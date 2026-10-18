/**
 * MiniMax Code speaks Agent Client Protocol over stdio (`mcode acp`), like Grok
 * and Antigravity, but its session surface differs from both in three ways that
 * this module exists to absorb:
 *
 * 1. It advertises no ACP `authenticate` method. Sign-in is `mcode login`, owned
 *    entirely by the CLI, so every `methodId` is rejected with -32602. The
 *    runtime therefore starts without an `authenticate` round-trip.
 * 2. Models are ACP session *configuration options*, not the `models` block.
 *    `session/set_model` does not exist; selection goes through
 *    `session/set_config_option` with `configId: "model"`. The shared runtime
 *    already exposes this as `setConfigOption` / `setModel`.
 * 3. Permission mode is a config option too, so a runtime mode is applied after
 *    the session exists rather than through launch flags — `mcode acp` accepts
 *    no options of its own.
 *
 * @module provider/acp/MiniMaxCodeAcpSupport
 */
import {
  type MiniMaxCodeSettings,
  ProviderDriverKind,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import { MINIMAX_CODE_DEFAULT_MODEL } from "@t3tools/contracts";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { findSessionConfigOption } from "@t3tools/provider-acp/server/runtimeModel";

export const MINIMAX_CODE_DRIVER_KIND = ProviderDriverKind.make("minimaxCode");

/**
 * T3's built-in MiniMax Code slug. The CLI's real model ids are versioned
 * strings such as `m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking`, so this
 * product slug means "keep whatever model the session is already on" and is
 * never sent over the wire.
 */
export const MINIMAX_CODE_DEFAULT_MODEL_SLUG = MINIMAX_CODE_DEFAULT_MODEL;

type MiniMaxCodeAcpRuntimeSettings = Pick<MiniMaxCodeSettings, "binaryPath">;

/** ACP `configId` of the model select option, per the CLI's `category: "model"`. */
export const MINIMAX_CODE_MODEL_CONFIG_ID = "model";
/** ACP `configId` of the reasoning-effort select option (`category: "thought_level"`). */
export const MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID = "thinkingEffort";
/** Option id T3 publishes for that effort; clients render it as the effort picker. */
export const MINIMAX_CODE_REASONING_EFFORT_OPTION_ID = "reasoningEffort";
/** ACP `configId` of the permission select option (`category: "_permission"`). */
export const MINIMAX_CODE_PERMISSION_MODE_CONFIG_ID = "permissionMode";

/** The three permission values MiniMax Code advertises for its process. */
export const MINIMAX_CODE_PERMISSION_MODES = ["default", "auto", "bypassPermissions"] as const;
export type MiniMaxCodePermissionMode = (typeof MINIMAX_CODE_PERMISSION_MODES)[number];

/**
 * T3 runtime mode → MiniMax Code permission policy.
 *
 * The CLI collapses T3's four modes onto three policies, so this is lossy by
 * necessity: there is no "auto-accept edits but still ask for the rest" policy.
 * `approval-required` and `auto-accept-edits` both land on `default` (ask), and
 * the user answers through T3's own permission prompts rather than the CLI's.
 */
export function resolveMiniMaxCodePermissionMode(
  runtimeMode?: RuntimeMode,
): MiniMaxCodePermissionMode {
  switch (runtimeMode) {
    case "full-access":
      return "bypassPermissions";
    case "auto":
      return "auto";
    case "approval-required":
    case "auto-accept-edits":
    default:
      return "default";
  }
}

/**
 * `mcode acp` takes no launch flags — permission mode and model are session
 * config options — so the spawn shape is constant apart from the binary.
 */
export function miniMaxCodeAcpSpawnArgs(): ReadonlyArray<string> {
  return ["acp"];
}

export function buildMiniMaxCodeAcpSpawnInput(
  settings: MiniMaxCodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "mcode",
    args: [...miniMaxCodeAcpSpawnArgs()],
    cwd,
    // Omitted rather than passed as `undefined`: the spawn input declares
    // `exactOptionalPropertyTypes`, and the runtime already merges a present
    // `env` over `process.env`, so leaving it out inherits the same environment.
    ...(environment === undefined ? {} : { env: environment }),
  };
}

interface MiniMaxCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly miniMaxCodeSettings: MiniMaxCodeAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export const makeMiniMaxCodeAcpRuntime = (
  input: MiniMaxCodeAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildMiniMaxCodeAcpSpawnInput(
          input.miniMaxCodeSettings,
          input.cwd,
          input.environment,
        ),
        // MiniMax Code owns sign-in through `mcode login` and rejects every ACP
        // auth method, so no `authenticate` round-trip is sent.
        authenticate: false,
        // `clientCapabilities` is the adapter's to set: it advertises `fs` only
        // for flavors that also register the matching handlers, and it owns
        // `terminal` and `elicitation`. Pinning a subset here would advertise
        // file access this runtime cannot serve — `mcode` answers every `fs/*`
        // request with -32601 once the handler is missing.
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveMiniMaxCodeAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : MINIMAX_CODE_DEFAULT_MODEL_SLUG;
}

/**
 * MiniMax Code only advertises `thinkingEffort` for models that take a thinking
 * variant — setting it for a plain model fails with -32602 "Thinking effort is
 * not advertised for the selected model". The advertised option list is the
 * authority, so a value outside it is dropped rather than forwarded.
 */
export interface MiniMaxCodeConfigChoice {
  readonly value: string;
  readonly name: string;
}

/**
 * Flattens a select config option into its choices. A select option's `options` is
 * either a flat list of choices or a list of labelled groups, so both shapes have to
 * be walked to reach a value. Reusing the shared narrowing keeps this in step with
 * `collectSessionConfigOptionValues` in `AcpRuntimeModel.ts`.
 */
export function miniMaxCodeSelectChoices(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string,
): ReadonlyArray<MiniMaxCodeConfigChoice> {
  const option = findSessionConfigOption(configOptions, configId);
  if (!option || option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value, name: entry.name }]
      : entry.options.map((choice) => ({ value: choice.value, name: choice.name })),
  );
}

/**
 * MiniMax Code only advertises `thinkingEffort` for models that take a thinking
 * variant — setting it for a plain model fails with -32602 "Thinking effort is
 * not advertised for the selected model". The advertised option list is the
 * authority, so a value outside it is dropped rather than forwarded.
 */
export function isValidMiniMaxCodeThinkingEffort(
  value: string,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): boolean {
  return miniMaxCodeSelectChoices(configOptions, MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID).some(
    (choice) => choice.value === value,
  );
}

/**
 * Reads the effort out of a model selection. The built-in model publishes it
 * as `reasoningEffort`; custom models may key it by the ACP `configId`. When
 * both are present the published id wins, so turns and text generation agree.
 * Ids match case-insensitively because custom model ids are typed by hand.
 */
export function miniMaxCodeThinkingEffortFromModelSelection(
  modelSelection:
    | { readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined }
    | null
    | undefined,
): string | undefined {
  for (const id of [
    MINIMAX_CODE_REASONING_EFFORT_OPTION_ID,
    MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID,
  ]) {
    const entry = modelSelection?.options?.find(
      (option) => option.id.trim().toLowerCase() === id.toLowerCase(),
    );
    if (typeof entry?.value === "string") {
      return entry.value;
    }
  }
  return undefined;
}

export function normalizeMiniMaxCodeThinkingEffort(
  value: string | undefined,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const effort = value?.trim();
  return effort && isValidMiniMaxCodeThinkingEffort(effort, configOptions) ? effort : undefined;
}

/** The model ids the session currently offers, in CLI order. */
export function miniMaxCodeModelIdsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<string> {
  return miniMaxCodeSelectChoices(configOptions, MINIMAX_CODE_MODEL_CONFIG_ID).map(
    (choice) => choice.value,
  );
}

export function currentMiniMaxCodeModelIdFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const option = findSessionConfigOption(configOptions, MINIMAX_CODE_MODEL_CONFIG_ID);
  return option && option.type === "select" ? option.currentValue.trim() || undefined : undefined;
}
