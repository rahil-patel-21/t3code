/**
 * MiniMaxCodeAdapterV2 — orchestration-v2 wiring for the first-party MiniMax
 * Code provider.
 *
 * MiniMax Code speaks Agent Client Protocol over stdio (`mcode acp`), like Grok
 * and Antigravity, so all the protocol work belongs to `makeAcpAdapterV2`. What
 * is left is the flavor: the protocol details that differ and shape every
 * decision here, all captured from `mcode acp`.
 *
 * 1. **No ACP authentication.** `initialize` advertises no auth methods and
 *    every `authenticate` methodId is rejected with -32602 "Unknown
 *    authentication method." Sign-in is entirely `mcode login`, so
 *    {@link makeMiniMaxCodeAcpRuntime} starts with `authenticate: false` and no
 *    `authMethodId` is sent. Credentials never pass through this adapter.
 * 2. **Models are session config options, not the `models` block.** `session/new`
 *    returns `configOptions` with a `category: "model"` select and no
 *    `{ currentModelId, availableModels }`, and `session/set_model` does not
 *    exist on this agent (-32601) — so Grok's `setSessionModel` path is wrong
 *    here. The shared runtime's `setModel` is the model write, and it lowers to
 *    `session/set_config_option` against the agent's `modelConfigId`.
 * 3. **Images arrive as file paths, not content blocks.** `initialize` reports
 *    `promptCapabilities: { image: false, audio: false, embeddedContext: false }`
 *    and this agent enforces it: an ACP `image` block fails `session/prompt`
 *    with -32602 "Prompt content type image is not supported in ACP P0." The
 *    agent still reads images through its own file tools, so this flavor leaves
 *    `supportsImagePrompts` false and sets
 *    `unsupportedImageAttachmentPolicy: "reference"` — the shared adapter sends
 *    the path and tells the agent to open it, so a screenshot turn works
 *    instead of failing.
 *
 * Deliberately not implemented: the CLI's `mcode/*` extension methods (queue,
 * steer, goal, delegation). They are not required for parity with the other
 * providers and would add a protocol surface T3 has no orchestration event for.
 *
 * **Permission mode is enforced by T3, not by the CLI.** `mcode acp` takes no
 * launch flags — permission mode is a session config option — and it spawns at
 * its own `bypassPermissions` default. No flavor hook receives both a started
 * runtime and the runtime policy, so this adapter does not write the
 * `permissionMode` option; instead {@link acpPermissionDisposition} is left as
 * the gate, which decides allow/ask/deny per T3's own policy for every
 * `session/request_permission` the agent sends. See
 * {@link resolveMiniMaxCodePermissionMode} for the mapping the CLI-side write
 * would use, and re-check that assumption against a real `mcode` if an approval
 * ever slips through.
 *
 * @module orchestration-v2/Adapters/MiniMaxCodeAdapterV2
 */
import { MiniMaxCodeSettings, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ServerConfig from "../../config.ts";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import { readClientTextFile, writeClientTextFile } from "../../provider/acp/ClientFiles.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  MINIMAX_CODE_DRIVER_KIND,
  MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID,
  makeMiniMaxCodeAcpRuntime,
  miniMaxCodeThinkingEffortFromModelSelection,
  normalizeMiniMaxCodeThinkingEffort,
  resolveMiniMaxCodeAcpBaseModelId,
} from "../../provider/acp/MiniMaxCodeAcpSupport.ts";
import {
  isMiniMaxCodeThinkingEffortUnsupported,
  miniMaxCodeApprovalOptions,
  resolveMiniMaxCodeModel,
} from "../../provider/MiniMaxCodeAdapter.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export const MINIMAX_CODE_PROVIDER = MINIMAX_CODE_DRIVER_KIND;
const DEFAULT_MINIMAX_CODE_SETTINGS = Schema.decodeSync(MiniMaxCodeSettings)({});

export const MiniMaxCodeProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    // The model is a session config option on this agent, so a model change
    // does not need a new session.
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface MiniMaxCodeAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: MiniMaxCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly hostPlatform: NodeJS.Platform;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

/**
 * Roots the client `fs` handlers may touch: the workspace of the turn in
 * progress, plus the attachments dir so path-only uploads stay readable. A
 * session with no workspace still gets the attachments dir.
 */
function minimaxCodeClientFileRoots(
  cwd: string | null,
  serverConfig: ServerConfig.ServerConfig["Service"],
): ReadonlyArray<string> {
  return cwd === null ? [serverConfig.attachmentsDir] : [cwd, serverConfig.attachmentsDir];
}

export function makeMiniMaxCodeAcpAdapterFlavor(
  options: MiniMaxCodeAdapterV2Options,
): AcpAdapterV2Flavor {
  return {
    driver: MINIMAX_CODE_PROVIDER,
    runtimeHarness: "MiniMax Code",
    capabilities: MiniMaxCodeProviderCapabilitiesV2,
    // Deliberately NOT overridden, unlike the Grok flavor's equivalent. Grok
    // reports `promptCapabilities.image: false` and still accepts image blocks,
    // so it overrides to true. `mcode acp` (0.6.2) enforces the advertised
    // capability instead: an image block fails `session/prompt` with -32602
    // "Prompt content type image is not supported in ACP P0." Leaving this off
    // lets the shared adapter refuse the turn up front with a message naming the
    // files, rather than surfacing a raw ACP rejection mid-thread.
    supportsImagePrompts: false,
    // `mcode acp` refuses image content blocks, but the agent itself reads
    // images fine when handed a path: verified against 0.6.2 by pointing it at
    // a PNG, which it opened with its own file tools and described correctly
    // (dimensions and dominant color) while still reporting image: false. So
    // reference the file instead of failing the turn — it sees the screenshot,
    // just not as prompt content.
    unsupportedImageAttachmentPolicy: "reference",
    // `mcode acp` answers `session/prompt` with the CLI's own slash-command
    // handler before the turn reaches the model: a lone `/compact` text block
    // is parsed by the ACP prompt handler and routed to the same
    // `requestCompaction` the TUI's `/compact` calls, so the summary lands in
    // the native session without spending a turn. Verified against 0.6.2.
    // Without this the composer still offers /compact (the provider snapshot
    // advertises it) and every use fails with "minimaxCode does not support
    // conversation compaction".
    supportsCompaction: true,
    resolveModelId: (selection) => resolveMiniMaxCodeAcpBaseModelId(selection.model),
    /**
     * Every model write is a `session/set_config_option` against the `model`
     * select, because `session/set_model` does not exist on this agent. An
     * unadvertised model is rejected rather than silently falling back to
     * whatever the session is already using.
     */
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      Effect.gen(function* () {
        const configOptions = startResult.sessionSetupResult.configOptions ?? [];
        const resolution = resolveMiniMaxCodeModel({
          configOptions,
          model: resolveMiniMaxCodeAcpBaseModelId(modelSelection.model),
        });
        if (resolution._tag === "Unknown") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `MiniMax Code does not currently offer model '${resolution.model}'. Pick one of the offered models.`,
          });
        }
        if (resolution.model !== undefined) {
          yield* runtime.setModel(resolution.model);
        }
        // Thinking effort is per-model: the CLI only advertises the option for a
        // thinking variant, so an unadvertised value is dropped rather than
        // forwarded, and a late -32602 is a benign no-op.
        const effort = normalizeMiniMaxCodeThinkingEffort(
          miniMaxCodeThinkingEffortFromModelSelection(modelSelection),
          configOptions,
        );
        if (effort !== undefined) {
          yield* runtime
            .setConfigOption(MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID, effort)
            .pipe(
              Effect.catchTag("AcpRequestError", (cause) =>
                isMiniMaxCodeThinkingEffortUnsupported(cause)
                  ? Effect.logWarning(
                      "MiniMax Code rejected the thinking effort for the selected model; keeping the CLI default.",
                      { model: resolution.model, effort },
                    )
                  : Effect.fail(cause),
              ),
            );
        }
        return resolution.model;
      }),
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeMiniMaxCodeAcpRuntime({
          ...input,
          miniMaxCodeSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
          // No `additionalDirectories`: `mcode acp` 0.6.2 rejects `session/new`
          // with -32602 "Additional directories are not supported by MiniMax
          // Code ACP." when it is sent, which fails the session open outright.
          // Path-only uploads stay readable because T3 serves the client `fs`
          // capability for the attachments dir itself.
        })),
    /**
     * The CLI delegates file reads and writes back to T3 rather than touching
     * the disk itself, so the session opts into the client `fs` capability and
     * serves it. Declaring the handlers here is what advertises `fs` — the two
     * cannot be set independently. Every write is still gated by
     * `session/request_permission`; only path containment is enforced here.
     */
    clientFileSystem: {
      readTextFile: (request, cwd) =>
        readClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: minimaxCodeClientFileRoots(cwd, options.serverConfig),
          request,
        }),
      writeTextFile: (request, cwd) =>
        writeClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: minimaxCodeClientFileRoots(cwd, options.serverConfig),
          request,
        }),
    },
    approvalOptions: miniMaxCodeApprovalOptions,
    permissionDisposition: acpPermissionDisposition,
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? { message: cause.errorMessage, code: String(cause.code), class: "provider_error" }
          : { class: "provider_error" }),
      }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

/** Yield this: the shared ACP adapter is built from the services in context. */
export function makeMiniMaxCodeAdapterV2(options: MiniMaxCodeAdapterV2Options) {
  const flavor = makeMiniMaxCodeAcpAdapterFlavor(options);
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
}

export type MiniMaxCodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost
  | ServerConfig.ServerConfig;

export const MiniMaxCodeAdapterV2Driver: ProviderAdapterDriver<
  MiniMaxCodeSettings,
  MiniMaxCodeAdapterV2DriverEnv
> = {
  driverKind: MINIMAX_CODE_PROVIDER,
  configSchema: MiniMaxCodeSettings,
  defaultConfig: (): MiniMaxCodeSettings => DEFAULT_MINIMAX_CODE_SETTINGS,
  create: Effect.fn("MiniMaxCodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<MiniMaxCodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const hostPlatform = yield* HostProcess.Platform;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeMiniMaxCodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        hostPlatform,
        childProcessSpawner,
        fileSystem,
        path,
        serverConfig,
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: MINIMAX_CODE_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: MINIMAX_CODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create MiniMax Code orchestration adapter.",
              cause,
            }),
        ),
      ),
  ),
};
