import {
  APP_BASE_NAME,
  type CustomModelSetting,
  type MiniMaxCodeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { enrichProviderSnapshotWithVersionAdvisory } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import {
  currentMiniMaxCodeModelIdFromConfigOptions,
  makeMiniMaxCodeAcpRuntime,
  miniMaxCodeSelectChoices,
  MINIMAX_CODE_DEFAULT_MODEL_SLUG,
  MINIMAX_CODE_MODEL_CONFIG_ID,
  MINIMAX_CODE_REASONING_EFFORT_OPTION_ID,
} from "./acp/MiniMaxCodeAcpSupport.ts";
import { discoverMiniMaxCodeSkills } from "./Drivers/MiniMaxCodeSkills.ts";

const MINIMAX_CODE_PRESENTATION = {
  displayName: "MiniMax Code",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  // `session/new` advertises `default` and `plan` modes, and the shared ACP
  // runtime exposes them through `setMode`.
  showInteractionModeToggle: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/** MiniMax's console usage page, where M Plan windows are actually tracked. */
const MINIMAX_USAGE_URL = "https://platform.minimax.io/console/usage";
// `initialize` is a single local round trip, so this is generous even on slow machines.
const MINIMAX_CODE_ACP_INITIALIZE_TIMEOUT_MS = 8_000;

/**
 * The built-in model runs whatever model the CLI session is on, so it mirrors
 * the CLI's `thinkingEffort` choices. Clients send nothing until the user picks
 * one, which leaves the CLI's own setting in place, and the adapter drops a
 * pick the session does not advertise (a model without a thinking variant).
 */
const MINIMAX_CODE_BUILT_IN_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: MINIMAX_CODE_REASONING_EFFORT_OPTION_ID,
      label: "Reasoning",
      type: "select",
      options: [
        { id: "default", label: "Default" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
      ],
      currentValue: "default",
    },
  ],
});

const MINIMAX_CODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: MINIMAX_CODE_DEFAULT_MODEL_SLUG,
    name: "MiniMax Code",
    isCustom: false,
    capabilities: MINIMAX_CODE_BUILT_IN_CAPABILITIES,
  },
];

export function buildInitialMiniMaxCodeProviderSnapshot(
  settings: MiniMaxCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = miniMaxCodeModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: MINIMAX_CODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `MiniMax Code is disabled in ${APP_BASE_NAME} settings.`,
        },
      });
    }

    return buildServerProvider({
      presentation: MINIMAX_CODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking MiniMax Code CLI availability...",
      },
    });
  });
}

function miniMaxCodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = MINIMAX_CODE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export interface MiniMaxCodeProviderListOutput {
  /** Null when no line looked like a provider entry, so the caller reports "unknown". */
  readonly authenticated: boolean | null;
}

/**
 * Parses `mcode provider list`, whose lines are `<marker><id>\t<state>\t<credential>`, for
 * example:
 *
 *     * minimax_oauth<TAB>active<TAB>managed login
 *       minimax_api<TAB>enabled<TAB>no key
 *       custom_provider:openrouter<TAB>enabled<TAB>sk-o****3c00
 *
 * A `*` marks the active credential source. A row whose credential column says
 * `no key` has nothing usable, so an active row without it means the user has
 * run `mcode login` or configured a key.
 *
 * The format is not a contract, so an unrecognized output yields `null` and the
 * caller degrades to "unknown" rather than reporting a sign-in state we guessed.
 */
export function parseMiniMaxCodeProviderList(output: string): MiniMaxCodeProviderListOutput {
  let sawRow = false;
  let authenticated: boolean | null = null;

  for (const line of output.split(/\r?\n/)) {
    const columns = line
      .trim()
      .split("\t")
      .map((column) => column.trim());
    if (columns.length < 2) {
      continue;
    }
    const [markerAndId, state, credential = ""] = columns as [string, string, string];
    const isActive = markerAndId.startsWith("*");
    const id = isActive ? markerAndId.slice(1).trim() : markerAndId;
    if (!id) {
      continue;
    }
    sawRow = true;
    if (!isActive) {
      continue;
    }
    authenticated = credential.length > 0 && !/^no\s+key$/i.test(credential);
    // The state column only tells us whether the source is usable, which the
    // credential column already answers more precisely.
    void state;
  }

  return { authenticated: sawRow ? authenticated : null };
}

/**
 * Models advertised by the session's `model` configuration option, with the
 * session's current model marked as default.
 *
 * Reasoning effort is deliberately left out of per-model capabilities: MiniMax
 * Code advertises `thinkingEffort` as its own session-level option and only for
 * models that take a thinking variant, so a per-model descriptor would claim a
 * capability that is not always there.
 */
export function buildMiniMaxCodeModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const choices = miniMaxCodeSelectChoices(configOptions, MINIMAX_CODE_MODEL_CONFIG_ID);
  if (choices.length === 0) {
    return [];
  }
  const currentModelId = currentMiniMaxCodeModelIdFromConfigOptions(configOptions)?.trim() ?? "";
  const seen = new Set<string>();
  return choices.flatMap((choice): ServerProviderModel[] => {
    const slug = choice.value.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: choice.name.trim() || slug,
        isCustom: false,
        ...(slug === currentModelId ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

export function miniMaxCodeSlashCommandsFromInitialize(
  initialized: EffectAcpSchema.InitializeResponse,
): ReadonlyArray<ServerProviderSlashCommand> {
  // `initialize` is the only call a health check may make, so commands come from
  // its metadata. MiniMax Code advertises no `availableCommands` today, which
  // leaves T3's own compact command.
  void initialized;
  return [COMPACT_SLASH_COMMAND];
}

/**
 * Reads command metadata from `initialize._meta`. This never calls
 * `authenticate` or `session/new`, so it cannot open a browser login or boot the
 * workspace's MCP servers.
 *
 * It deliberately does not fetch the live model list: on this agent the models
 * arrive with `session/new`, and taking a session here would start MCP servers
 * as a side effect of a health check. The adapter publishes the real list once a
 * thread starts.
 */
const discoverMiniMaxCodeMetadataViaAcpInitialize = (
  settings: MiniMaxCodeSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeMiniMaxCodeAcpRuntime({
      miniMaxCodeSettings: settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return { slashCommands: miniMaxCodeSlashCommandsFromInitialize(initialized) };
  }).pipe(Effect.scoped);

/**
 * Subscription usage for MiniMax Code.
 *
 * `mcode acp` reports no quota: its `/usage` answers a session's own token
 * totals, and `/status` reports account status, model, and auth mode. Neither
 * carries a limit window or a reset time, so there is nothing honest to draw a
 * bar from.
 *
 * Publishing the external console instead is what the Limits view is built for:
 * MiniMax tracks M Plan windows there, so the provider shows up with a "Manage
 * usage" link rather than vanishing from the tab. This mirrors how the managed
 * Codex provider points at ChatGPT's usage settings.
 *
 * Exported for tests: the enabled status path shells out to `mcode`, so this is
 * the only hermetic place to assert the published shape.
 */
export const miniMaxCodeUsageLimits = (checkedAt: string): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [],
  unavailable: {
    reason: "unsupported",
    message:
      "MiniMax tracks subscription usage in its console. Open Plan usage with the account you signed in to MiniMax Code with.",
  },
  externalUsage: { label: "MiniMax usage", url: MINIMAX_USAGE_URL },
});

const runMiniMaxCodeCliCommand = (
  settings: MiniMaxCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "mcode";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkMiniMaxCodeProviderStatus = Effect.fn("checkMiniMaxCodeProviderStatus")(
  function* (
    settings: MiniMaxCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = miniMaxCodeModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: MINIMAX_CODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `MiniMax Code is disabled in ${APP_BASE_NAME} settings.`,
        },
      });
    }

    const versionResult = yield* runMiniMaxCodeCliCommand(
      settings,
      ["--version"],
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("MiniMax Code CLI health check failed.", { errorTag: error._tag });
      return buildServerProvider({
        presentation: MINIMAX_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "MiniMax Code CLI (`mcode`) is not installed or not on PATH."
            : "Failed to execute MiniMax Code CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: MINIMAX_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "MiniMax Code CLI is installed but timed out while running `mcode --version`.",
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      yield* Effect.logWarning("MiniMax Code CLI version probe exited with a non-zero status.", {
        exitCode: versionOutput.code,
      });
      return buildServerProvider({
        presentation: MINIMAX_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "MiniMax Code CLI is installed but failed to run.",
        },
      });
    }

    // `mcode provider list` reports the active credential source without starting
    // the agent. MiniMax Code owns sign-in through `mcode login` and exposes no
    // ACP auth method, so this text is the only honest signal available.
    const providerListResult = yield* runMiniMaxCodeCliCommand(
      settings,
      ["provider", "list"],
      environment,
    ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
    const providerListOutput =
      Result.isSuccess(providerListResult) &&
      Option.isSome(providerListResult.success) &&
      providerListResult.success.value.code === 0
        ? providerListResult.success.value
        : undefined;
    if (!providerListOutput) {
      yield* Effect.logWarning("MiniMax Code credential listing failed or timed out.", {
        errorTag: Result.isFailure(providerListResult)
          ? providerListResult.failure._tag
          : Option.isNone(providerListResult.success)
            ? "Timeout"
            : `ExitCode${providerListResult.success.value.code}`,
      });
    }
    const credentialState = providerListOutput
      ? parseMiniMaxCodeProviderList(`${providerListOutput.stdout}\n${providerListOutput.stderr}`)
      : { authenticated: null };

    const auth: ServerProviderAuth =
      credentialState.authenticated === true
        ? { status: "authenticated", type: "cached_token", label: "MiniMax account" }
        : credentialState.authenticated === false
          ? { status: "unauthenticated" }
          : { status: "unknown" };

    // Skills live only on the CLI's filesystem — `initialize` advertises no
    // commands — so they are read from disk here rather than from the probe.
    // A read failure degrades to an empty list and never fails the snapshot.
    const skills = yield* discoverMiniMaxCodeSkills({ environment }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("MiniMax Code skill discovery failed.", {
            errorTag: causeErrorTag(cause),
          }),
          [] as ReadonlyArray<ServerProviderSkill>,
        ),
      ),
    );

    const acpExit = yield* discoverMiniMaxCodeMetadataViaAcpInitialize(settings, environment).pipe(
      Effect.timeoutOption(MINIMAX_CODE_ACP_INITIALIZE_TIMEOUT_MS),
      Effect.exit,
    );
    const acpMetadata = Exit.isSuccess(acpExit) ? Option.getOrUndefined(acpExit.value) : undefined;
    const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
    if (acpFailed) {
      yield* Effect.logWarning("MiniMax Code ACP initialize probe failed or timed out.", {
        errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
      });
    }

    if (auth.status === "unauthenticated") {
      return buildServerProvider({
        presentation: MINIMAX_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        slashCommands: acpMetadata?.slashCommands ?? [COMPACT_SLASH_COMMAND],
        skills,
        probe: {
          installed: true,
          version,
          status: "error",
          auth,
          message: "MiniMax Code is installed but not signed in. Run `mcode login`.",
          usageLimits: miniMaxCodeUsageLimits(checkedAt),
        },
      });
    }

    return buildServerProvider({
      presentation: MINIMAX_CODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: acpMetadata?.slashCommands ?? [COMPACT_SLASH_COMMAND],
      skills,
      probe: {
        installed: true,
        version,
        // A failed metadata probe degrades the slash command list, it does not
        // make chats fail.
        status: acpFailed ? "warning" : "ready",
        auth,
        usageLimits: miniMaxCodeUsageLimits(checkedAt),
        ...(acpFailed
          ? {
              message:
                "MiniMax Code is installed but ACP initialize failed. Model options may be incomplete.",
            }
          : {}),
      },
    });
  },
);

export const enrichMiniMaxCodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
  readonly latestVersions: ProviderLatestVersions.ProviderLatestVersions["Service"];
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, input.latestVersions),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("MiniMax Code version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
