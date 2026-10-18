/**
 * MiniMaxCodeAdapter — ACP adapter for the first-party MiniMax Code provider.
 *
 * MiniMax Code speaks Agent Client Protocol over stdio (`mcode acp`), like Grok
 * and Antigravity, but three of its protocol details differ and shape every
 * decision in this file:
 *
 * 1. **No ACP authentication.** `initialize` advertises no auth methods and every
 *    `authenticate` methodId is rejected with -32602 "Unknown authentication
 *    method." Sign-in is entirely `mcode login`, so
 *    {@link makeMiniMaxCodeAcpRuntime} starts with `authenticate: false` and no
 *    `authMethodId` is sent. Credentials never pass through this adapter.
 * 2. **Models are session config options, not the `models` block.** `session/new`
 *    returns `configOptions` with a `category: "model"` select and no
 *    `{ currentModelId, availableModels }`. `session/set_model` does not exist on
 *    this agent (-32601), so Grok's `setSessionModel` path is wrong here; every
 *    model write goes through `session/set_config_option` via the shared
 *    runtime's `setConfigOption` / `setModel`.
 * 3. **Images are not an input capability.** `initialize` reports
 *    `promptCapabilities: { image: false, audio: false, embeddedContext: false }`,
 *    so this adapter never builds ACP image content blocks — see
 *    {@link MINI_MAX_CODE_SUPPORTS_IMAGE_ATTACHMENTS}.
 *
 * Deliberately not implemented: the CLI's `mcode/*` extension methods (queue,
 * steer, goal, delegation). They are not required for parity with the other
 * providers and would add a protocol surface T3 has no orchestration event for.
 * `default` / `plan` session modes *are* reachable through the shared runtime's
 * generic `setMode`, but T3's `RuntimeMode` has no plan notion, so this adapter
 * does not select one — see {@link resolveMiniMaxCodePermissionMode}.
 *
 * @module provider/MiniMaxCodeAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type ChatAttachment,
  type MiniMaxCodeSettings,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ThreadId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ServerConfig } from "../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "./Errors.ts";
import { mapAcpToAdapterError } from "./acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "@t3tools/provider-acp/server/coreRuntimeEvents";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  findSessionConfigOption,
  parsePermissionRequest,
} from "@t3tools/provider-acp/server/runtimeModel";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { readClientTextFile, writeClientTextFile } from "./acp/ClientFiles.ts";
import {
  MINIMAX_CODE_DEFAULT_MODEL_SLUG,
  MINIMAX_CODE_DRIVER_KIND,
  MINIMAX_CODE_MODEL_CONFIG_ID,
  MINIMAX_CODE_PERMISSION_MODE_CONFIG_ID,
  MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID,
  currentMiniMaxCodeModelIdFromConfigOptions,
  makeMiniMaxCodeAcpRuntime,
  miniMaxCodeThinkingEffortFromModelSelection,
  normalizeMiniMaxCodeThinkingEffort,
  resolveMiniMaxCodePermissionMode,
  type MiniMaxCodePermissionMode,
} from "./acp/MiniMaxCodeAcpSupport.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = MINIMAX_CODE_DRIVER_KIND;
const MINIMAX_CODE_HARNESS = "MiniMax Code";
const MINIMAX_CODE_CLIENT_NAME = "t3-code";
const MINIMAX_CODE_CLIENT_VERSION = "0.0.0";
/** `mcode login` must have run before the CLI will serve a session. */
const MINIMAX_CODE_SIGN_IN_HINT =
  "Run `mcode login` in a terminal before starting a MiniMax Code thread.";
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);

const isAcpError = Schema.is(EffectAcpErrors.AcpError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * The permission outcome is an open union — the generated schema keeps a
 * catch-all `{ outcome: string }` arm for agents that answer with a vocabulary
 * T3 does not model — so `optionId` cannot be read off the narrowed `selected`
 * arm directly. Read it through this guard instead, which stays honest about an
 * agent answering with a non-string id by reporting no selection.
 */
function selectedPermissionOptionId(
  outcome: NativePermissionResponse["outcome"],
): string | undefined {
  if (outcome.outcome !== "selected") return undefined;
  const { optionId } = outcome as { readonly optionId?: unknown };
  return typeof optionId === "string" ? optionId : undefined;
}

/** `category` the CLI tags its model select option with. */
const MINI_MAX_CODE_MODEL_CATEGORY = "model";

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "handleRequestPermission"
  | "handleReadTextFile"
  | "handleWriteTextFile"
  | "start"
  | "setMode"
  | "setModel"
  | "setConfigOption"
  | "getConfigOptions"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
>;
type NativePermission = EffectAcpSchema.RequestPermissionRequest;
type NativePermissionResponse = EffectAcpSchema.RequestPermissionResponse;
type ConfigOptions = ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
type PermissionOptionKind = EffectAcpSchema.PermissionOption["kind"];
type SelectionOptions = NonNullable<
  NonNullable<Parameters<Adapter["sendTurn"]>[0]["modelSelection"]>["options"]
>;

/* -------------------------------------------------------------------------- */
/* Pure protocol mapping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One selectable model as MiniMax Code advertises it.
 *
 * The `value` is the CLI's own id (`m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking`)
 * and is stored and displayed verbatim: it carries a version segment and a
 * `v:<variant>` thinking marker, and rewriting either would select a different
 * model than the user picked.
 */
export interface MiniMaxCodeModelOption {
  readonly value: string;
  readonly name: string;
}

/** A select option narrowed out of the {@link ConfigOptions} union. */
type SelectConfigOption = Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>;

/**
 * Locates the model select option. `extractModelConfigId` finds it by
 * `category: "model"`; `findSessionConfigOption` then resolves it by id, so the
 * id is tried first and the category is the fallback for a CLI that keeps the
 * id but drops the category (or vice versa).
 */
function findModelConfigOption(configOptions: ConfigOptions): SelectConfigOption | undefined {
  const byId = findSessionConfigOption(configOptions, MINIMAX_CODE_MODEL_CONFIG_ID);
  if (byId?.type === "select") return byId;
  return configOptions.find(
    (candidate): candidate is SelectConfigOption =>
      candidate.type === "select" &&
      "category" in candidate &&
      candidate.category === MINI_MAX_CODE_MODEL_CATEGORY,
  );
}

/**
 * MiniMax Code's model list, in CLI order, as `value`/`name` pairs.
 *
 * This is the only source of models for this provider: `session/new` returns no
 * `models` block, so the catalog is derived from the live config-option
 * snapshot rather than from a static manifest. The companion
 * `miniMaxCodeModelIdsFromConfigOptions` in the shared support module returns
 * values only; T3 needs the `name` too, so the pair form lives here.
 *
 * A select option's `options` is either a flat value list or a list of groups.
 * MiniMax Code sends a flat list, but grouping is legal ACP and the shared
 * `collectSessionConfigOptionValues` flattens both, so this does too — reading
 * `.value` straight off each entry would type-error and skip grouped catalogs.
 */
export function miniMaxCodeModelsFromConfigOptions(
  configOptions: ConfigOptions,
): ReadonlyArray<MiniMaxCodeModelOption> {
  const option = findModelConfigOption(configOptions);
  if (!option) return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value, name: entry.name.trim() || entry.value }]
      : entry.options.map((nested) => ({
          value: nested.value,
          // A blank label would render as an empty row in the model picker.
          name: nested.name.trim() || nested.value,
        })),
  );
}

/** Outcome of matching T3's requested model against the CLI's live catalog. */
export type MiniMaxCodeModelResolution =
  | { readonly _tag: "Resolved"; readonly model: string | undefined }
  | { readonly _tag: "Unknown"; readonly model: string };

/**
 * Maps T3's requested model onto a wire value.
 *
 * `MINIMAX_CODE_DEFAULT_MODEL` ("minimax-code-default") is a T3 product slug,
 * not a CLI model id. It means "keep whatever model this session is already
 * running", so it resolves to the live `currentValue` and is never written to
 * the session. An explicit id is passed through only when the CLI currently
 * advertises it — MiniMax Code gates its catalog by account, so an unlisted id
 * would otherwise fail the whole turn with an opaque -32602.
 */
export function resolveMiniMaxCodeModel(input: {
  readonly configOptions: ConfigOptions;
  readonly model: string | null | undefined;
}): MiniMaxCodeModelResolution {
  const current = currentMiniMaxCodeModelIdFromConfigOptions(input.configOptions);
  const requested = input.model?.trim();
  if (
    requested === undefined ||
    requested === "" ||
    requested === MINIMAX_CODE_DEFAULT_MODEL_SLUG
  ) {
    return { _tag: "Resolved", model: current };
  }
  const available = miniMaxCodeModelsFromConfigOptions(input.configOptions);
  return available.some((option) => option.value === requested)
    ? { _tag: "Resolved", model: requested }
    : { _tag: "Unknown", model: requested };
}

/**
 * MiniMax Code rejects `thinkingEffort` unless the *current* model advertises
 * it: setting `high` on the non-thinking `m:minimax:MiniMax-M3:v:` model
 * returns -32602 "Thinking effort is not advertised for the selected model".
 * That is a benign mismatch between two independent settings, not a failed
 * turn, so the write is dropped instead of failing the prompt.
 */
const THINKING_EFFORT_UNADVERTISED = /thinking effort is not advertised/i;
export function isMiniMaxCodeThinkingEffortUnsupported(error: EffectAcpErrors.AcpError): boolean {
  return (
    isAcpRequestError(error) &&
    error.code === -32602 &&
    THINKING_EFFORT_UNADVERTISED.test(error.errorMessage)
  );
}

/**
 * Whether this adapter can forward image attachments.
 *
 * Always `false`, and deliberately not a runtime probe: `initialize` on
 * `mcode acp` 0.5.5 reports `promptCapabilities: { image: false, audio: false,
 * embeddedContext: false }`. An ACP `image` content block on such an agent is
 * dropped by the CLI, so the user would see a confident reply that never saw
 * the picture. There is no wiring here that reads attachments as images —
 * non-image uploads reach the agent as paths in the turn text — and this
 * constant exists so the refusal is explicit and greppable rather than an
 * omission someone later "fixes" by adding image blocks.
 */
export const MINI_MAX_CODE_SUPPORTS_IMAGE_ATTACHMENTS = false;

/** Names of image attachments that cannot be delivered to this agent. */
export function miniMaxCodeUnsupportedImageAttachments(
  attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "name">> | undefined,
): ReadonlyArray<string> {
  if (MINI_MAX_CODE_SUPPORTS_IMAGE_ATTACHMENTS) return [];
  return (attachments ?? [])
    .filter((attachment) => attachment.type === "image")
    .map((attachment) => attachment.name);
}

/* -------------------------------------------------------------------------- */
/* Permission option selection                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generic T3-decision → agent-option matching.
 *
 * Nothing is known about MiniMax Code's own permission tool or option names,
 * so selection is by ACP `PermissionOption.kind` first — that is the
 * standardized vocabulary — and only then by a conservative label match for
 * agents that ship non-conforming kinds. `acpPermissionOutcome` maps a T3
 * decision to the same four outcomes, so the tables below and that helper stay
 * in agreement.
 */
interface PermissionOptionRule {
  readonly kind: PermissionOptionKind | undefined;
  readonly label: RegExp;
}
const ALLOW_ONCE: PermissionOptionRule = {
  kind: "allow_once",
  label: /allow.*once|yes,?\s*allow/i,
};
const ALLOW_ALWAYS: PermissionOptionRule = {
  kind: "allow_always",
  label: /always|allow\s*all|accept\s*all|this\s*session/i,
};
const REJECT_ONCE: PermissionOptionRule = { kind: "reject_once", label: /^(deny|reject|no)\b/i };
const REJECT_ALWAYS: PermissionOptionRule = { kind: "reject_always", label: /never|don't\s*ask/i };

const PERMISSION_OPTION_RULES: Record<
  Exclude<ProviderApprovalDecision, "cancel">,
  ReadonlyArray<PermissionOptionRule>
> = {
  accept: [ALLOW_ONCE, ALLOW_ALWAYS],
  // `acceptForSession` and `acceptAlways` both mean "stop asking"; the CLI only
  // offers one durable option, so they resolve to the same agent option.
  acceptForSession: [ALLOW_ALWAYS, ALLOW_ONCE],
  acceptAlways: [ALLOW_ALWAYS, ALLOW_ONCE],
  // A one-shot deny is preferred; "never ask again" only when the agent offers it.
  // An allow option must never stand in for a decline: when the agent offers no
  // reject option, the lookup returns `undefined` and the request is answered as
  // cancelled, which withholds permission instead of granting it.
  decline: [REJECT_ONCE, REJECT_ALWAYS],
};

/**
 * Picks the agent option that carries T3's decision, or `undefined` when the
 * agent did not offer one (and for `cancel`, which is answered as a cancelled
 * outcome rather than a selected option).
 */
export function selectMiniMaxCodePermissionOptionId(
  request: NativePermission,
  decision: ProviderApprovalDecision,
): string | undefined {
  if (decision === "cancel") return undefined;
  for (const rule of PERMISSION_OPTION_RULES[decision]) {
    const byKind = rule.kind
      ? request.options.find((option) => option.kind === rule.kind)
      : undefined;
    const optionId = byKind?.optionId.trim();
    if (optionId) return optionId;
    const byLabel = request.options.find((option) => rule.label.test(option.name));
    const labelId = byLabel?.optionId.trim();
    if (labelId) return labelId;
  }
  return undefined;
}

const APPROVAL_LABELS = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow for this thread" },
  { decision: "decline", label: "Deny" },
  { decision: "cancel", label: "Cancel" },
] as const satisfies ReadonlyArray<{
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
}>;

/** Only offers decisions the agent can actually satisfy for this request. */
export function miniMaxCodeApprovalOptions(
  request: NativePermission,
): ReadonlyArray<ProviderApprovalOption> {
  return APPROVAL_LABELS.filter(
    (entry) =>
      entry.decision === "cancel" ||
      selectMiniMaxCodePermissionOptionId(request, entry.decision) !== undefined,
  ).map((entry) => ({ decision: entry.decision, label: entry.label }));
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export interface MiniMaxCodeAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<NativePermissionResponse>;
  readonly turnId: TurnId | undefined;
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  /** Latest advertised config options; the authority for every option write. */
  configOptions: ConfigOptions;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

/**
 * Builds the MiniMax Code adapter.
 *
 * `options.instanceId` pins the adapter to one configured provider instance;
 * without it every thread binds to the default instance slug.
 */
export function makeMiniMaxCodeAdapter(
  settings: MiniMaxCodeSettings,
  options?: MiniMaxCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("minimaxCode");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionContext>();
    const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Could not create a MiniMax Code event ID.",
            cause,
          }),
      ),
    );
    const stamp = Effect.all({
      eventId: Effect.map(randomId, EventId.make),
      createdAt: nowIso,
    });
    const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

    const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
      SynchronizedRef.modifyEffect(locks, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
        );
      }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const cancelApprovals = (context: SessionContext) =>
      Effect.forEach(
        context.approvals.values(),
        (pending) => Deferred.succeed(pending.response, { outcome: { outcome: "cancelled" } }),
        { discard: true },
      );

    const stopContext = (context: SessionContext) =>
      context.stopLock
        .withPermit(
          Effect.gen(function* () {
            if (context.closed) return;
            context.stopped = true;
            yield* Effect.gen(function* () {
              yield* cancelApprovals(context);
              if (context.promptFiber && !context.disconnected) {
                yield* Effect.ignore(context.runtime.cancel);
              }
            }).pipe(Effect.ensuring(Scope.close(context.scope, Exit.void)));
            context.closed = true;
            if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
            yield* emit({
              type: "session.exited",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: context.threadId,
              payload: {
                exitKind: context.disconnected ? "error" : "graceful",
                ...(context.disconnected ? { reason: "MiniMax Code process stopped." } : {}),
              },
            });
          }),
        )
        .pipe(Effect.uninterruptible);

    const handleApproval = Effect.fn("MiniMaxCodeAdapter.handleApproval")(function* (
      context: SessionContext,
      request: NativePermission,
    ): Effect.fn.Return<NativePermissionResponse, ProviderAdapterError> {
      if (context.stopped || request.sessionId !== context.nativeSessionId) {
        return { outcome: { outcome: "cancelled" } };
      }
      const requestId = ApprovalRequestId.make(yield* randomId);
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const turnId = context.activeTurnId;
      const parsed = parsePermissionRequest(request);
      const response = yield* Deferred.make<NativePermissionResponse>();
      context.approvals.set(requestId, { request, response, turnId });
      return yield* Effect.gen(function* () {
        yield* emit(
          makeAcpRequestOpenedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId,
            requestId: runtimeRequestId,
            permissionRequest: parsed,
            approvalOptions: miniMaxCodeApprovalOptions(request),
            detail:
              parsed.toolCall?.command ??
              parsed.toolCall?.detail ??
              parsed.toolCall?.title ??
              "MiniMax Code requests permission.",
            args: parsed.toolCall?.data ?? null,
            source: "acp.jsonrpc",
            method: "session/request_permission",
            rawPayload: request,
          }),
        );
        const result = yield* Deferred.await(response);
        const selectedOptionId = selectedPermissionOptionId(result.outcome);
        const optionId =
          selectedOptionId === undefined
            ? undefined
            : request.options.find((option) => option.optionId === selectedOptionId);
        const decision: ProviderApprovalDecision =
          optionId === undefined ? "cancel" : decisionForPermissionOption(optionId.kind);
        yield* emit(
          makeAcpRequestResolvedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId,
            requestId: runtimeRequestId,
            permissionRequest: parsed,
            decision,
          }),
        );
        return result;
      }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
    });

    const handleEvent = (
      context: SessionContext,
      event: AcpSessionRuntime.AcpSessionRuntimeEvent,
    ) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "EventStreamBarrier":
            yield* Deferred.succeed(event.acknowledge, undefined);
            return;
          case "ConnectionTerminated": {
            context.disconnected = true;
            yield* emit({
              type: "session.state.changed",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: context.threadId,
              payload: {
                state: "error",
                reason: `MiniMax Code disconnected. ${MINIMAX_CODE_SIGN_IN_HINT}`,
              },
            });
            yield* cancelApprovals(context);
            const promptFiber = context.promptFiber;
            if (promptFiber) yield* Effect.ignore(Fiber.interrupt(promptFiber));
            return;
          }
          case "ConfigOptionsUpdated":
            // The live snapshot is what makes a model/thinking write legal.
            context.configOptions = event.configOptions;
            return;
          case "ModeChanged":
          case "AvailableCommandsUpdated":
            // Session modes and slash commands have no T3 orchestration event;
            // T3 drives both through its own surfaces.
            return;
          case "AssistantItemStarted":
            yield* emit(
              makeAcpAssistantItemEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.activeTurnId,
                itemId: event.itemId,
                lifecycle: "item.started",
              }),
            );
            return;
          case "AssistantItemCompleted":
            yield* emit(
              makeAcpAssistantItemEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.activeTurnId,
                itemId: event.itemId,
                lifecycle: "item.completed",
              }),
            );
            return;
          case "ContentDelta":
          case "ThoughtDelta":
            yield* emit(
              makeAcpContentDeltaEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.activeTurnId,
                ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
                ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "PlanUpdated":
            yield* emit(
              makeAcpPlanUpdatedEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.activeTurnId,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ToolCallUpdated":
            yield* emit(
              makeAcpToolCallEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.activeTurnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          default:
            return;
        }
      });

    /**
     * Writes the permission mode, model and thinking effort for one turn.
     *
     * The permission option carries `_meta: {"minimax-code/scope": "process"}`,
     * which reads like a session-scoped write but is not: the value belongs to
     * the CLI process, so the write is repeated for every turn rather than
     * trusted to stick from session start. `session/set_config_option` accepts
     * it live (verified against `mcode acp`), so no launch flag is involved —
     * `mcode acp` takes none.
     */
    const applySessionOptions = Effect.fn("MiniMaxCodeAdapter.applySessionOptions")(function* (
      context: SessionContext,
      input: {
        readonly runtimeMode: RuntimeMode;
        readonly modelSelection:
          | { readonly model: string; readonly options?: SelectionOptions }
          | undefined;
        readonly fallbackModel: string | undefined;
      },
    ) {
      const configOptions = yield* context.runtime.getConfigOptions;
      context.configOptions = configOptions;
      const mapError = (method: string) => (cause: EffectAcpErrors.AcpError) =>
        mapAcpToAdapterError(PROVIDER, context.threadId, method, cause);

      const permissionMode: MiniMaxCodePermissionMode = resolveMiniMaxCodePermissionMode(
        input.runtimeMode,
      );
      if (findSessionConfigOption(configOptions, MINIMAX_CODE_PERMISSION_MODE_CONFIG_ID)) {
        // A silent failure here would leave the process at its own default,
        // which is `bypassPermissions` — so this write must surface errors.
        yield* context.runtime
          .setConfigOption(MINIMAX_CODE_PERMISSION_MODE_CONFIG_ID, permissionMode)
          .pipe(Effect.mapError(mapError("session/set_config_option")));
      } else {
        yield* Effect.logWarning(
          "MiniMax Code did not advertise a permissionMode option; the runtime mode cannot be enforced.",
          { threadId: context.threadId, runtimeMode: input.runtimeMode },
        );
      }

      const resolution = resolveMiniMaxCodeModel({
        configOptions,
        model: input.modelSelection?.model ?? input.fallbackModel,
      });
      if (resolution._tag === "Unknown") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "applySessionOptions",
          issue: `MiniMax Code does not currently offer model '${resolution.model}'. Pick one of the offered models.`,
        });
      }
      if (resolution.model !== undefined) {
        yield* context.runtime
          .setModel(resolution.model)
          .pipe(Effect.mapError(mapError("session/set_config_option")));
      }

      // Thinking effort is per-model: the CLI only advertises the option for
      // models with a thinking variant, so an unadvertised value is dropped
      // rather than forwarded, and a late -32602 is a benign no-op.
      const effort = normalizeMiniMaxCodeThinkingEffort(
        miniMaxCodeThinkingEffortFromModelSelection(input.modelSelection),
        configOptions,
      );
      if (effort !== undefined) {
        yield* context.runtime.setConfigOption(MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID, effort).pipe(
          Effect.catchTags({
            AcpRequestError: (cause) =>
              isMiniMaxCodeThinkingEffortUnsupported(cause)
                ? Effect.logWarning(
                    "MiniMax Code rejected the thinking effort for the selected model; keeping the CLI default.",
                    { threadId: context.threadId, effort },
                  )
                : Effect.fail(cause),
          }),
          Effect.mapError(mapError("session/set_config_option")),
        );
      }
      return resolution.model;
    });

    const startSession: Adapter["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (!settings.enabled) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Enable MiniMax Code in provider settings before starting a thread.",
            });
          }
          if (
            (input.provider !== undefined && input.provider !== PROVIDER) ||
            (input.providerInstanceId !== undefined &&
              input.providerInstanceId !== boundInstanceId) ||
            (input.modelSelection !== undefined &&
              input.modelSelection.instanceId !== boundInstanceId)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The MiniMax Code provider instance does not match the requested session.",
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The session requires a workspace directory.",
            });
          }
          const cursor = decodeResumeCursor(input.resumeCursor);
          if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The saved MiniMax Code session is invalid. Start a new thread.",
            });
          }
          const previous = sessions.get(input.threadId);
          if (previous) yield* stopContext(previous);

          const cwd = path.resolve(input.cwd);
          const sessionScope = yield* Scope.make("sequential");
          let transferred = false;
          let context: SessionContext | undefined;
          // Teardown runs only when startup did not hand the session over, so a
          // startup that dies partway drops its half-registered session entry and
          // drains the scope it opened instead of leaking both. `ensuring` would
          // also fire on success, which stopped the CLI it had just registered and
          // left `startSession` returning a "ready" session that could never take a
          // turn. On success the session scope's own finalizer drains it when the
          // thread stops.
          const stopUntransferred = Effect.suspend(() => {
            if (transferred) return Effect.void;
            sessions.delete(input.threadId);
            return context
              ? stopContext(context).pipe(Effect.ignore)
              : Scope.close(sessionScope, Exit.void);
          });

          const start = Effect.gen(function* () {
            const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
            const runtime = yield* makeMiniMaxCodeAcpRuntime({
              cwd,
              clientInfo: { name: MINIMAX_CODE_CLIENT_NAME, version: MINIMAX_CODE_CLIENT_VERSION },
              childProcessSpawner,
              miniMaxCodeSettings: settings,
              ...(options?.environment ? { environment: options.environment } : {}),
              ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
              ...(mcp
                ? {
                    mcpServers: [
                      {
                        type: "http" as const,
                        name: MINIMAX_CODE_CLIENT_NAME,
                        url: mcp.endpoint,
                        headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                      },
                    ],
                  }
                : {}),
              ...makeNativeLoggers({
                nativeEventLogger,
                provider: PROVIDER,
                threadId: input.threadId,
              }),
            });
            // The CLI declares `fs` client capabilities, so it delegates file
            // reads and writes back to T3. Every write is still gated by
            // `session/request_permission`; only path containment is enforced here.
            const allowedRoots = [cwd, serverConfig.attachmentsDir];
            yield* runtime.handleReadTextFile((request) =>
              readClientTextFile({ fileSystem, path, allowedRoots, request }),
            );
            yield* runtime.handleWriteTextFile((request) =>
              writeClientTextFile({ fileSystem, path, allowedRoots, request }),
            );
            yield* runtime.handleRequestPermission((request) =>
              context
                ? handleApproval(context, request).pipe(
                    Effect.mapError((cause) =>
                      EffectAcpErrors.AcpRequestError.internalError(
                        "Could not process a MiniMax Code permission request.",
                        undefined,
                        { cause },
                      ),
                    ),
                  )
                : Effect.succeed({
                    outcome: { outcome: "cancelled" },
                  } satisfies NativePermissionResponse),
            );
            // `start()` sends `initialize`, `session/new` (or `session/load`)
            // and — because `authenticate: false` — no auth round-trip.
            const started = yield* runtime.start();
            const createdAt = yield* nowIso;
            const configOptions = yield* runtime.getConfigOptions;
            const session: ProviderSession = {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              cwd,
              status: "ready",
              runtimeMode: input.runtimeMode,
              ...(currentMiniMaxCodeModelIdFromConfigOptions(configOptions)
                ? { model: currentMiniMaxCodeModelIdFromConfigOptions(configOptions) }
                : {}),
              resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
              createdAt,
              updatedAt: createdAt,
            };
            const running: SessionContext = {
              threadId: input.threadId,
              cwd,
              nativeSessionId: started.sessionId,
              scope: sessionScope,
              runtime,
              promptLock: yield* Semaphore.make(1),
              stopLock: yield* Semaphore.make(1),
              approvals: new Map(),
              configOptions,
              turns: [],
              session,
              activeTurnId: undefined,
              promptFiber: undefined,
              generation: 0,
              stopped: false,
              closed: false,
              disconnected: false,
            };
            context = running;
            sessions.set(input.threadId, running);
            yield* Stream.runForEach(runtime.getEvents(), (event) =>
              handleEvent(running, event),
            ).pipe(
              Effect.catchCause(() =>
                Effect.logError("Could not process a MiniMax Code runtime event."),
              ),
              Effect.forkIn(sessionScope),
            );
            yield* emit({
              type: "session.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* emit({
              type: "session.state.changed",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "MiniMax Code ACP session ready" },
            });
            yield* emit({
              type: "thread.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
            yield* runtime.drainEvents;
            if (running.stopped) {
              return yield* new ProviderAdapterSessionClosedError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            transferred = true;
            return session;
          }).pipe(
            // `Layer.build` needs a scope and Crypto; the session scope closes
            // the ACP runtime and its event pump when this thread stops.
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError((cause) =>
              isAcpError(cause)
                ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause)
                : new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/start",
                    detail: `Could not start MiniMax Code. ${MINIMAX_CODE_SIGN_IN_HINT}`,
                    cause,
                  }),
            ),
          );

          return yield* start.pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? stopUntransferred : Effect.void)),
          );
        }),
      );

    // `sendTurn`'s error and interrupt handlers are attached with `.pipe` outside its
    // generator body, so they cannot close over bindings made inside it. The settler is
    // built here from the session it is given, and the generator publishes the turn it
    // started onto `active`; the handlers read `active` inside `Effect.suspend` at the
    // moment they run, which is after the generator has yielded.
    const finishTurnFor =
      (context: SessionContext) => (turn: TurnIntent, payload: TurnCompletedPayload) =>
        Effect.gen(function* () {
          if (turn.settled || context.stopped || context.generation !== turn.generation) return;
          turn.settled = true;
          // Every turn ends through here — success, failure or cancellation — so this is
          // the one place that can clear the running state that starting the turn set.
          // Clearing it only on the success path left the session reporting "running"
          // with a stale `activeTurnId` after a failed or cancelled prompt, which in turn
          // left the next prompt waiting on state that was never released.
          context.session = {
            ...context.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
          };
          if (context.activeTurnId === turn.turnId) context.activeTurnId = undefined;
          yield* emit({
            type: "turn.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: turn.turnId,
            payload,
          });
        });

    const sendTurn: Adapter["sendTurn"] = (input: Parameters<Adapter["sendTurn"]>[0]) => {
      const active: {
        context?: SessionContext;
        intent?: TurnIntent;
        finishTurn?: ReturnType<typeof finishTurnFor>;
      } = {};
      return Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        active.context = context;
        if (
          input.modelSelection !== undefined &&
          input.modelSelection.instanceId !== boundInstanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "The selected model belongs to another provider instance.",
          });
        }
        // `promptCapabilities.image` is false on this agent, so an image
        // attachment cannot be delivered. Failing loudly beats a reply that
        // silently ignored the picture the user attached.
        const unsupportedImages = miniMaxCodeUnsupportedImageAttachments(input.attachments);
        if (unsupportedImages.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `MiniMax Code cannot read image attachments (${unsupportedImages.join(", ")}). Send the file as a non-image attachment instead.`,
          });
        }
        const text = input.input?.trim();
        // Non-image uploads already reach the agent as paths in the turn text,
        // which is why nothing here reads them off disk.
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "MiniMax Code needs message text.",
          });
        }

        const finishTurn = finishTurnFor(context);
        active.finishTurn = finishTurn;

        const launch = yield* context.promptLock.withPermit(
          Effect.gen(function* () {
            // Cancel any in-flight prompt *before* the generation bump so the
            // outgoing turn still settles itself as cancelled instead of being
            // orphaned by the generation guard in finishTurn.
            if (context.promptFiber) {
              yield* cancelApprovals(context);
              yield* Effect.ignore(context.runtime.cancel);
              yield* Fiber.await(context.promptFiber);
              context.promptFiber = undefined;
            }
            const model = yield* applySessionOptions(context, {
              runtimeMode: context.session.runtimeMode,
              modelSelection: input.modelSelection,
              fallbackModel: context.session.model,
            });
            const turnId = TurnId.make(yield* randomId);
            const turn: TurnIntent = {
              turnId,
              generation: ++context.generation,
              settled: false,
            };
            active.intent = turn;
            context.activeTurnId = turnId;
            yield* emit({
              type: "turn.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: model ? { model } : {},
            });
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              ...(model ? { model } : {}),
              updatedAt: yield* nowIso,
            };
            const dispatched = yield* Deferred.make<void>();
            const fiber = yield* context.runtime
              .prompt(
                {
                  prompt: [
                    { type: "text", text },
                    {
                      type: "text",
                      text: buildRuntimeInstructions({
                        harness: MINIMAX_CODE_HARNESS,
                        ...(model ? { model } : {}),
                      }),
                    },
                  ],
                },
                { dispatched },
              )
              .pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            // Fiber.join can skip a scope-close waiter when the child is
            // interrupted, so the Exit is unwrapped after Fiber.await returns.
            yield* Effect.raceFirst(
              Deferred.await(dispatched),
              Fiber.await(fiber).pipe(
                Effect.flatMap((exit) => exit),
                Effect.asVoid,
              ),
            );
            return { turn, fiber };
          }),
        );

        const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
        if (context.promptFiber === launch.fiber) context.promptFiber = undefined;
        yield* context.runtime.drainEvents;
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
        if (record) record.items.push(result);
        else context.turns.push({ id: launch.turn.turnId, items: [result] });
        // The running state this turn set is cleared by `finishTurn`, which is the single
        // owner of that transition for every outcome.
        yield* context.promptLock.withPermit(
          finishTurn(launch.turn, {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason,
          }),
        );
        return {
          threadId: input.threadId,
          turnId: launch.turn.turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isAcpError(cause)
            ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause)
            : cause,
        ),
        Effect.tapError((cause) =>
          Effect.suspend(() => {
            const turn = active.intent;
            const settle = active.finishTurn;
            const session = active.context;
            if (!turn || !settle || !session) {
              return Effect.void;
            }
            return session.promptLock.withPermit(
              settle(turn, { state: "failed", errorMessage: cause.message }),
            );
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            const session = active.context;
            if (!session) {
              return Effect.void;
            }
            return session.promptLock.withPermit(
              Effect.gen(function* () {
                const turn = active.intent;
                const settle = active.finishTurn;
                if (
                  !turn ||
                  !settle ||
                  turn.settled ||
                  session.stopped ||
                  session.generation !== turn.generation
                ) {
                  return;
                }
                const promptFiber = session.promptFiber;
                yield* cancelApprovals(session);
                yield* Effect.ignore(session.runtime.cancel);
                if (promptFiber) yield* Fiber.interrupt(promptFiber);
                yield* settle(turn, { state: "cancelled", stopReason: "cancelled" });
              }),
            );
          }),
        ),
      );
    };

    const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          context.promptLock.withPermit(
            Effect.gen(function* () {
              yield* cancelApprovals(context);
              yield* context.runtime.cancel;
            }),
          ),
        ),
        Effect.mapError((cause) =>
          isAcpError(cause)
            ? mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause)
            : cause,
        ),
      );

    const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.gen(function* () {
            const pending = context.approvals.get(requestId);
            if (!pending) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/request_permission",
                detail: "This approval request is no longer pending.",
              });
            }
            const optionId = selectMiniMaxCodePermissionOptionId(pending.request, decision);
            if (decision !== "cancel" && optionId === undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "respondToRequest",
                issue:
                  "MiniMax Code did not offer this permission choice. Select one of the available choices.",
              });
            }
            yield* Deferred.succeed(pending.response, {
              outcome:
                optionId === undefined
                  ? { outcome: "cancelled" }
                  : { outcome: "selected", optionId },
            });
          }),
        ),
      );

    /**
     * `mcode acp` advertises no elicitation capability, so this agent has no
     * structured user-input request to answer. Failing explicitly keeps the
     * orchestrator from waiting on a reply that will never arrive.
     */
    const respondToUserInput: Adapter["respondToUserInput"] = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail:
            "MiniMax Code does not support structured user-input requests; answer the approval request instead.",
        }),
      );

    const stopSession: Adapter["stopSession"] = (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
    const stopAll: Adapter["stopAll"] = () =>
      Effect.forEach([...sessions.values()], stopContext, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logError("Could not stop a MiniMax Code session."),
        ),
        Effect.ensuring(PubSub.shutdown(events)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopAll,
      listSessions: () =>
        Effect.sync(() =>
          [...sessions.values()]
            .filter((context) => !context.stopped)
            .map((context) => ({
              ...context.session,
            })),
        ),
      hasSession: (threadId) =>
        Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
      readThread: (threadId) =>
        Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
      rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "MiniMax Code does not support conversation rewind. Start a new thread instead.",
          }),
        ),
      streamEvents: Stream.fromPubSub(events),
    } satisfies Adapter;
  });
}

/** Reports the outcome of the option T3 answered with as a T3 decision. */
function decisionForPermissionOption(kind: PermissionOptionKind): ProviderApprovalDecision {
  switch (kind) {
    case "allow_always":
      return "acceptForSession";
    case "allow_once":
      return "accept";
    default:
      return "decline";
  }
}
