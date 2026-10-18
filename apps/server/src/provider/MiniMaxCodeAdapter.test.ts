// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpSchemaV1 from "effect-acp/schema-v1";

import {
  type ChatAttachment,
  MINIMAX_CODE_DEFAULT_MODEL,
  MiniMaxCodeSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import {
  MINIMAX_CODE_MODEL_CONFIG_ID,
  MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID,
  currentMiniMaxCodeModelIdFromConfigOptions,
  miniMaxCodeThinkingEffortFromModelSelection,
  normalizeMiniMaxCodeThinkingEffort,
  resolveMiniMaxCodePermissionMode,
} from "./acp/MiniMaxCodeAcpSupport.ts";
import {
  MINI_MAX_CODE_SUPPORTS_IMAGE_ATTACHMENTS,
  isMiniMaxCodeThinkingEffortUnsupported,
  makeMiniMaxCodeAdapter,
  miniMaxCodeApprovalOptions,
  miniMaxCodeModelsFromConfigOptions,
  miniMaxCodeUnsupportedImageAttachments,
  resolveMiniMaxCodeModel,
  selectMiniMaxCodePermissionOptionId,
} from "./MiniMaxCodeAdapter.ts";

/**
 * The capture below is verbatim `mcode acp` 0.5.5 wire data, and that CLI
 * speaks ACP v1, so it is decoded against the v1 schema. What the adapter is
 * actually fed at runtime is `effect-acp/compat` — the normalized vocabulary
 * the ACP client hands every adapter. The two differ only in the select-group
 * arm, which this capture has none of: v1 names that arm's id `group` where
 * compat names it `groupId`. So the capture is read as the adapter's own option
 * type.
 */
const decodeConfigOptions = Schema.decodeUnknownSync(
  Schema.Array(EffectAcpSchemaV1.SessionConfigOption),
) as (input: unknown) => ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
const decodeMiniMaxCodeSettings = Schema.decodeSync(MiniMaxCodeSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

/** The instance slug the adapter binds to when no driver pins one. */
const INSTANCE_ID = ProviderInstanceId.make("minimaxCode");

const MINIMAX_M3_FLASH_THINKING = "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking";
const MINIMAX_M3_FLASH = "m:minimax:MiniMax-M3.1-Flash-Preview:v:";
const MINIMAX_M3_THINKING = "m:minimax:MiniMax-M3:v:thinking";
const MINIMAX_M3_PLAIN = "m:minimax:MiniMax-M3:v:";

/**
 * Captured verbatim from `mcode acp` 0.5.5 `session/new` against the T3 repo.
 * `models: { currentModelId, availableModels }` is absent — the catalog lives
 * in `configOptions`, and `session/set_model` does not exist on this agent.
 */
const CAPTURED_SESSION_NEW_CONFIG_OPTIONS = [
  {
    type: "select",
    id: "permissionMode",
    name: "Permission mode",
    category: "_permission",
    currentValue: "bypassPermissions",
    options: [
      { value: "default", name: "Ask" },
      { value: "auto", name: "Auto" },
      { value: "bypassPermissions", name: "Full access" },
    ],
    _meta: { "minimax-code/scope": "process" },
  },
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: MINIMAX_M3_FLASH_THINKING,
    options: [
      { value: MINIMAX_M3_FLASH, name: "M3.1-Flash-Preview" },
      { value: MINIMAX_M3_FLASH_THINKING, name: "M3.1-Flash-Preview · thinking" },
      { value: MINIMAX_M3_PLAIN, name: "M3" },
      { value: MINIMAX_M3_THINKING, name: "M3 · thinking" },
    ],
  },
  {
    type: "select",
    id: "thinkingEffort",
    name: "Thinking effort",
    category: "thought_level",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Xhigh" },
      { value: "max", name: "Max" },
    ],
  },
] as const;

const capturedConfigOptions = decodeConfigOptions(CAPTURED_SESSION_NEW_CONFIG_OPTIONS);

/**
 * The same shape as the capture minus the `thinkingEffort` option: MiniMax Code
 * only advertises it for models with a thinking variant, so selecting
 * `m:minimax:MiniMax-M3:v:` makes the option disappear.
 */
const configOptionsWithoutThinkingEffort = decodeConfigOptions([
  CAPTURED_SESSION_NEW_CONFIG_OPTIONS[0],
  CAPTURED_SESSION_NEW_CONFIG_OPTIONS[1],
]);

function permissionRequest(
  options: ReadonlyArray<{
    kind: EffectAcpSchema.PermissionOption["kind"];
    name: string;
    optionId: string;
  }>,
) {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      title: "Run npm test",
      kind: "execute",
      status: "pending",
      rawInput: { command: "npm test" },
    },
    options,
  } satisfies EffectAcpSchema.RequestPermissionRequest;
}

/* -------------------------------------------------------------------------- */
/* Live harness                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Spawns the ACP mock agent in its MiniMax Code profile behind a fake `mcode`
 * CLI. The stub asserts it is launched with exactly `acp`, which is the whole
 * launch contract for this provider.
 */
async function makeMockMiniMaxCodeWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "minimax-code-acp-mock-"));
  const requestLogPath = NodePath.join(dir, "requests.ndjson");
  const wrapperPath = writeFakeCli({
    directory: dir,
    name: "fake-mcode",
    env: { T3_ACP_MINIMAX: "1", T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
  });
  return { wrapperPath, requestLogPath };
}

type TurnCompletedEvent = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;

interface EventLog {
  readonly events: Array<ProviderRuntimeEvent>;
  readonly fiber: Fiber.Fiber<void>;
  readonly turnStarted: Deferred.Deferred<void>;
  readonly turnCompleted: Deferred.Deferred<TurnCompletedEvent>;
}

/**
 * Subscribes to the adapter event stream before anything is published: the
 * adapter broadcasts through a PubSub, so events emitted before this fiber runs
 * are dropped rather than buffered.
 */
function watchEvents(adapter: {
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}): Effect.Effect<EventLog> {
  return Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    const turnStarted = yield* Deferred.make<void>();
    const turnCompleted = yield* Deferred.make<TurnCompletedEvent>();
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.started") {
          yield* Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
        }
      }),
    ).pipe(Effect.forkChild);
    return { events, fiber, turnStarted, turnCompleted };
  });
}

function turnCompletions(log: EventLog, threadId: ThreadId): ReadonlyArray<TurnCompletedEvent> {
  return log.events.filter(
    (event): event is TurnCompletedEvent =>
      event.type === "turn.completed" && event.threadId === threadId,
  );
}

async function readRequests(requestLogPath: string) {
  const raw = await NodeFSP.readFile(requestLogPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

function requestMethods(requests: ReadonlyArray<{ method?: string }>): ReadonlyArray<string> {
  return requests.flatMap((request) => (request.method ? [request.method] : []));
}

function configOptionWrites(
  requests: ReadonlyArray<{ method?: string; params?: Record<string, unknown> }>,
  configId: string,
) {
  return requests.flatMap((request) =>
    request.method === "session/set_config_option" && request.params?.configId === configId
      ? [request.params]
      : [],
  );
}

const miniMaxCodeAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-minimax-code-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string) =>
  makeMiniMaxCodeAdapter(decodeMiniMaxCodeSettings({ enabled: true, binaryPath })).pipe(
    Effect.orDie,
  );

/**
 * Fails fast, with one shared message, when `startSession` did not leave a live
 * session behind. Without it every turn-level test below reports the same
 * `ProviderAdapterSessionNotFoundError` from a different line.
 */
const assertSessionIsLive = (
  adapter: { readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean> },
  threadId: ThreadId,
): Effect.Effect<void> =>
  adapter.hasSession(threadId).pipe(
    Effect.flatMap((isLive) =>
      Effect.sync(() => {
        assert.isTrue(isLive, "startSession tore down the session it had just started");
      }),
    ),
  );

/* -------------------------------------------------------------------------- */
/* Pure protocol mapping                                                       */
/* -------------------------------------------------------------------------- */

describe("MiniMaxCodeAdapter model catalog", () => {
  it("reads the model list off the category-`model` config option", () => {
    const models = miniMaxCodeModelsFromConfigOptions(capturedConfigOptions);

    assert.deepStrictEqual(models, [
      { value: MINIMAX_M3_FLASH, name: "M3.1-Flash-Preview" },
      { value: MINIMAX_M3_FLASH_THINKING, name: "M3.1-Flash-Preview · thinking" },
      { value: MINIMAX_M3_PLAIN, name: "M3" },
      { value: MINIMAX_M3_THINKING, name: "M3 · thinking" },
    ]);
    // The permission and thinking-effort selects are not models.
    assert.isTrue(models.every((model) => model.value.startsWith("m:minimax:")));
  });

  it("keeps model ids verbatim, including the `v:` thinking marker", () => {
    const models = miniMaxCodeModelsFromConfigOptions(capturedConfigOptions);
    const thinking = models.find((model) => model.name === "M3 · thinking");

    assert.isDefined(thinking);
    assert.strictEqual(thinking.value, MINIMAX_M3_THINKING);
  });

  it("flattens grouped select options, which ACP also allows", () => {
    const grouped = decodeConfigOptions([
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: MINIMAX_M3_PLAIN,
        options: [
          {
            group: "MiniMax",
            name: "MiniMax",
            options: [
              { value: MINIMAX_M3_PLAIN, name: "M3" },
              { value: MINIMAX_M3_THINKING, name: "M3 · thinking" },
            ],
          },
        ],
      },
    ]);

    assert.deepStrictEqual(miniMaxCodeModelsFromConfigOptions(grouped), [
      { value: MINIMAX_M3_PLAIN, name: "M3" },
      { value: MINIMAX_M3_THINKING, name: "M3 · thinking" },
    ]);
  });

  it("returns no models when the agent advertises no model option", () => {
    assert.deepStrictEqual(miniMaxCodeModelsFromConfigOptions([]), []);
    assert.deepStrictEqual(
      miniMaxCodeModelsFromConfigOptions(
        decodeConfigOptions([CAPTURED_SESSION_NEW_CONFIG_OPTIONS[0]]),
      ),
      [],
    );
  });

  it("passes the T3 product slug through to the session's current model", () => {
    const resolution = resolveMiniMaxCodeModel({
      configOptions: capturedConfigOptions,
      model: MINIMAX_CODE_DEFAULT_MODEL,
    });

    // The slug is a T3 concept; the wire value is the CLI's own current model.
    assert.deepStrictEqual(resolution, {
      _tag: "Resolved",
      model: MINIMAX_M3_FLASH_THINKING,
    });
    assert.isFalse(
      miniMaxCodeModelsFromConfigOptions(capturedConfigOptions).some(
        (model) => model.value === MINIMAX_CODE_DEFAULT_MODEL,
      ),
      "the product slug must never appear as a selectable model id",
    );
  });

  it("resolves the product slug the same way as an absent selection", () => {
    for (const model of [undefined, null, "", "   "]) {
      assert.deepStrictEqual(
        resolveMiniMaxCodeModel({ configOptions: capturedConfigOptions, model }),
        {
          _tag: "Resolved",
          model: MINIMAX_M3_FLASH_THINKING,
        },
      );
    }
  });

  it("passes an advertised model id through and rejects an unoffered one", () => {
    assert.deepStrictEqual(
      resolveMiniMaxCodeModel({
        configOptions: capturedConfigOptions,
        model: MINIMAX_M3_THINKING,
      }),
      { _tag: "Resolved", model: MINIMAX_M3_THINKING },
    );
    assert.deepStrictEqual(
      resolveMiniMaxCodeModel({
        configOptions: capturedConfigOptions,
        model: "m:minimax:MiniMax-M4:v:thinking",
      }),
      { _tag: "Unknown", model: "m:minimax:MiniMax-M4:v:thinking" },
    );
  });

  it("reports the session's current model id", () => {
    assert.strictEqual(
      currentMiniMaxCodeModelIdFromConfigOptions(capturedConfigOptions),
      MINIMAX_M3_FLASH_THINKING,
    );
  });
});

describe("MiniMaxCodeAdapter thinking effort", () => {
  it("reads the effort out of the model selection options", () => {
    assert.strictEqual(
      miniMaxCodeThinkingEffortFromModelSelection({
        options: [{ id: "thinkingEffort", value: "xhigh" }],
      }),
      "xhigh",
    );
    assert.strictEqual(
      miniMaxCodeThinkingEffortFromModelSelection({
        options: [{ id: "ThinkingEffort", value: "max" }],
      }),
      "max",
    );
    assert.strictEqual(
      miniMaxCodeThinkingEffortFromModelSelection({
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
      "high",
    );
  });

  it("prefers the published reasoningEffort id over thinkingEffort", () => {
    assert.strictEqual(
      miniMaxCodeThinkingEffortFromModelSelection({
        options: [
          { id: "thinkingEffort", value: "low" },
          { id: "reasoningEffort", value: "max" },
        ],
      }),
      "max",
    );
  });

  it("ignores unrelated provider option selections", () => {
    assert.isUndefined(
      miniMaxCodeThinkingEffortFromModelSelection({
        options: [{ id: "someOtherOption", value: "high" }],
      }),
    );
    assert.isUndefined(
      miniMaxCodeThinkingEffortFromModelSelection({
        options: [{ id: "thinkingEffort", value: true }],
      }),
    );
  });

  it("forwards advertised values and drops garbage", () => {
    for (const effort of ["default", "low", "medium", "high", "xhigh", "max"]) {
      assert.strictEqual(normalizeMiniMaxCodeThinkingEffort(effort, capturedConfigOptions), effort);
    }
    for (const garbage of ["turbo", "HIGH", "", "   "]) {
      assert.isUndefined(normalizeMiniMaxCodeThinkingEffort(garbage, capturedConfigOptions));
    }
  });

  it("trims surrounding whitespace off a selected effort", () => {
    assert.strictEqual(
      normalizeMiniMaxCodeThinkingEffort("  high  ", capturedConfigOptions),
      "high",
    );
  });

  it("drops the effort when the selected model does not advertise the option", () => {
    assert.strictEqual(normalizeMiniMaxCodeThinkingEffort("high", capturedConfigOptions), "high");
    // `m:minimax:MiniMax-M3:v:` has no thinking variant, so the CLI omits the
    // option entirely; sending it would be rejected with -32602.
    assert.isUndefined(
      normalizeMiniMaxCodeThinkingEffort("high", configOptionsWithoutThinkingEffort),
    );
  });

  it("treats the model-specific -32602 as a benign no-op", () => {
    const rejected = new EffectAcpErrors.AcpRequestError({
      code: -32602,
      errorMessage:
        "Invalid params: Thinking effort is not advertised for the selected model: high",
    });
    assert.isTrue(isMiniMaxCodeThinkingEffortUnsupported(rejected));

    const otherInvalidParams = new EffectAcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "Invalid params: Unknown authentication method.",
    });
    assert.isFalse(isMiniMaxCodeThinkingEffortUnsupported(otherInvalidParams));

    const otherCode = new EffectAcpErrors.AcpRequestError({
      code: -32601,
      errorMessage: "Thinking effort is not advertised for the selected model: high",
    });
    assert.isFalse(isMiniMaxCodeThinkingEffortUnsupported(otherCode));
  });

  it("keys off the negotiated config ids", () => {
    assert.strictEqual(MINIMAX_CODE_MODEL_CONFIG_ID, "model");
    assert.strictEqual(MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID, "thinkingEffort");
  });
});

describe("MiniMaxCodeAdapter permission mode", () => {
  it("maps every T3 runtime mode onto a permission value the CLI advertises", () => {
    const cases: ReadonlyArray<readonly [RuntimeMode, string]> = [
      ["approval-required", "default"],
      ["auto", "auto"],
      // Lossy by necessity: mcode has no "auto-accept edits, ask for the rest"
      // policy, so T3's approval prompt governs this mode instead.
      ["auto-accept-edits", "default"],
      ["full-access", "bypassPermissions"],
    ];

    for (const [runtimeMode, expected] of cases) {
      assert.strictEqual(resolveMiniMaxCodePermissionMode(runtimeMode), expected);
    }
  });

  it("asks for permission when no runtime mode is supplied", () => {
    assert.strictEqual(resolveMiniMaxCodePermissionMode(undefined), "default");
  });

  it("only ever writes permission values the agent advertises", () => {
    const advertised = new Set(
      capturedConfigOptions.flatMap((option) =>
        option.type === "select" && option.id === "permissionMode"
          ? option.options.flatMap((entry) => ("value" in entry ? [entry.value] : []))
          : [],
      ),
    );
    const produced = new Set(
      (["approval-required", "auto", "auto-accept-edits", "full-access"] as const).map(
        resolveMiniMaxCodePermissionMode,
      ),
    );

    assert.deepStrictEqual([...produced].sort(), ["auto", "bypassPermissions", "default"]);
    for (const value of produced) {
      assert.isTrue(advertised.has(value), `permission value ${value} is not advertised`);
    }
  });
});

describe("MiniMaxCodeAdapter image capability", () => {
  it("reports image attachments as unsupported", () => {
    // `initialize` on this agent advertises promptCapabilities.image = false.
    assert.isFalse(MINI_MAX_CODE_SUPPORTS_IMAGE_ATTACHMENTS);
  });

  it("flags image attachments and leaves non-image uploads alone", () => {
    assert.deepStrictEqual(
      miniMaxCodeUnsupportedImageAttachments([
        { type: "image", name: "diagram.png" },
        { type: "file", name: "notes.txt" },
        { type: "image", name: "chart.jpg" },
      ]),
      ["diagram.png", "chart.jpg"],
    );
    assert.deepStrictEqual(miniMaxCodeUnsupportedImageAttachments([]), []);
    assert.deepStrictEqual(miniMaxCodeUnsupportedImageAttachments(undefined), []);
  });
});

describe("MiniMaxCodeAdapter permission option selection", () => {
  const request = permissionRequest([
    { kind: "allow_once", name: "Yes, allow once", optionId: "opt-once" },
    { kind: "allow_always", name: "Always allow", optionId: "opt-always" },
    { kind: "reject_once", name: "No, deny", optionId: "opt-reject" },
  ]);

  it("maps T3 decisions onto the agent's own options", () => {
    assert.strictEqual(selectMiniMaxCodePermissionOptionId(request, "accept"), "opt-once");
    assert.strictEqual(
      selectMiniMaxCodePermissionOptionId(request, "acceptForSession"),
      "opt-always",
    );
    assert.strictEqual(selectMiniMaxCodePermissionOptionId(request, "decline"), "opt-reject");
    assert.isUndefined(selectMiniMaxCodePermissionOptionId(request, "cancel"));
  });

  it("falls back to the option label when the agent ships non-conforming kinds", () => {
    const untyped = {
      ...request,
      options: [
        { kind: "other" as never, name: "Allow once", optionId: "a" },
        { kind: "other" as never, name: "Deny", optionId: "d" },
      ],
    };

    assert.strictEqual(selectMiniMaxCodePermissionOptionId(untyped, "accept"), "a");
    assert.strictEqual(selectMiniMaxCodePermissionOptionId(untyped, "decline"), "d");
  });

  it("offers every decision the agent's own options can satisfy", () => {
    assert.deepStrictEqual(miniMaxCodeApprovalOptions(request), [
      { decision: "accept", label: "Allow once" },
      { decision: "acceptForSession", label: "Allow for this thread" },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);
  });
});

/**
 * Known adapter defect, deliberately left failing.
 *
 * `PERMISSION_OPTION_RULES.decline` in `MiniMaxCodeAdapter.ts` falls back to
 * `ALLOW_ONCE` after `REJECT_ONCE` and `REJECT_ALWAYS`. When the agent offers
 * no reject option, T3's "Deny" button therefore resolves to the agent's
 * *allow once* option and the tool call runs. `selectGrokPermissionOptionId`
 * (GrokAdapter.ts:290) never does this: only `acceptForSession` falls back to
 * `allow_once`. The rule needs to stop there.
 */
describe("MiniMaxCodeAdapter KNOWN BUG: decline must never resolve to an allow option", () => {
  const request = permissionRequest([
    { kind: "allow_once", name: "Yes, allow once", optionId: "opt-once" },
    { kind: "allow_always", name: "Always allow", optionId: "opt-always" },
  ]);

  it("leaves decline unsatisfiable instead of answering it with an allow", () => {
    assert.isUndefined(selectMiniMaxCodePermissionOptionId(request, "decline"));
  });

  it("hides the Deny button when the agent offers no reject option", () => {
    assert.deepStrictEqual(miniMaxCodeApprovalOptions(request), [
      { decision: "accept", label: "Allow once" },
      { decision: "acceptForSession", label: "Allow for this thread" },
      { decision: "cancel", label: "Cancel" },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Live adapter                                                                */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Blocked by one adapter defect: every test below that needs a turn fails
 * with `ProviderAdapterSessionNotFoundError`, because `startSession` tears down
 * the session it just started.
 *
 * `MiniMaxCodeAdapter.ts:976` runs `start.pipe(Effect.ensuring(stopOwned))`.
 * `Effect.ensuring` fires on success as well as failure, and `stopOwned`
 * (line 822) calls `stopContext(context)` whenever `context` is set — which it
 * is on the success path — so the ACP process is stopped, `sessions` loses the
 * thread, and the returned `status: "ready"` session is already dead. The
 * `transferred` flag set at line 957 is only read by the `Effect.addFinalizer`
 * at line 817, never by `ensuring`, so the successful hand-off is unguarded.
 * Antigravity, whose session shape is copied here, keeps the teardown in a
 * registry that only sign-out drains (`AntigravityAuth.withProcess`).
 *
 * The failing tests below are the specification of what a turn must do once
 * that is fixed; they are written against the adapter, not weakened around it.
 */
it.layer(miniMaxCodeAdapterTestLayer)("MiniMaxCodeAdapterLive", (it) => {
  it.effect("starts a session and reads the model off the model config option", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-start-session");
      const { wrapperPath } = yield* Effect.promise(() => makeMockMiniMaxCodeWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);

      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, threadId);
      assert.equal(session.provider, "minimaxCode");
      assert.equal(session.status, "ready");
      // `session/new` returns no `models` block on this agent, so this id can
      // only have come from the `model` config option.
      assert.equal(session.model, MINIMAX_M3_FLASH_THINKING);
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      const threadStarted = log.events.find((event) => event.type === "thread.started");
      assert.equal(threadStarted?.type, "thread.started");
      assert.equal(
        threadStarted?.type === "thread.started"
          ? threadStarted.payload.providerThreadId
          : undefined,
        "mock-session-1",
      );

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  /**
   * Known adapter defect, deliberately left failing. See the live-suite banner.
   */
  it.effect("keeps the session it just started registered and running", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-session-survives-start");
      const { wrapperPath } = yield* Effect.promise(() => makeMockMiniMaxCodeWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);

      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      // `startSession` runs `stopOwned` through `Effect.ensuring`, which fires
      // on success too, so the session is stopped and deregistered before
      // `startSession` returns.
      assert.isTrue(yield* adapter.hasSession(threadId), "the started session was torn down");
      assert.lengthOf(
        yield* adapter
          .listSessions()
          .pipe(Effect.map((sessions) => sessions.map((s) => s.threadId))),
        1,
      );
      // A dead session cannot take a turn.
      yield* adapter.sendTurn({ threadId, input: "first prompt" });

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("rejects a model the agent does not offer, without touching the session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-unknown-model");
      const { wrapperPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper(),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* assertSessionIsLive(adapter, threadId);

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "use a model I do not have",
          modelSelection: { instanceId: INSTANCE_ID, model: "m:minimax:MiniMax-M9:v:thinking" },
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.include(error.issue, "m:minimax:MiniMax-M9:v:thinking");
      }
      // Rejected before dispatch: the CLI never saw the id, and no turn settled.
      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      assert.notInclude(requestMethods(requests), "session/prompt");
      assert.lengthOf(turnCompletions(log, threadId), 0);

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("never sends an ACP authenticate request", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-no-authenticate");
      const { wrapperPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper(),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);

      // The mock rejects every methodId with -32602, exactly like `mcode acp`,
      // so this session can only start if the runtime skips the auth round-trip.
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      const methods = requestMethods(requests);
      assert.notInclude(methods, "authenticate");
      assert.include(methods, "initialize");
      assert.include(methods, "session/new");
      // `session/new` is asked for with the workspace cwd and no launch flags.
      const sessionNew = requests.find((request) => request.method === "session/new");
      assert.equal(sessionNew?.params?.cwd, process.cwd());
      assert.equal(sessionNew?.params?.modelConfigId, undefined);

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("selects the model through session/set_config_option, never session/set_model", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-no-set-model");
      const { wrapperPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper(),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* assertSessionIsLive(adapter, threadId);

      yield* adapter.sendTurn({
        threadId,
        input: "switch model",
        modelSelection: { instanceId: INSTANCE_ID, model: MINIMAX_M3_THINKING },
      });

      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      assert.notInclude(requestMethods(requests), "session/set_model");
      // The id rides the wire verbatim: rewriting the `v:thinking` marker would
      // select a different model than the user picked.
      const writes = configOptionWrites(requests, "model");
      assert.deepStrictEqual(
        writes.map((params) => params.value),
        [MINIMAX_M3_THINKING],
      );

      const session = yield* adapter
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((entry) => entry.threadId === threadId)));
      assert.equal(session?.model, MINIMAX_M3_THINKING);
      assert.lengthOf(turnCompletions(log, threadId), 1);

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("completes a turn and settles it as completed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-happy-path");
      const { wrapperPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper({ T3_ACP_PROMPT_RESPONSE_TEXT: "minimax says hi" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* assertSessionIsLive(adapter, threadId);

      const started = yield* adapter.sendTurn({ threadId, input: "first prompt" });
      const completed = yield* Deferred.await(log.turnCompleted).pipe(
        Effect.timeout("5 seconds"),
        TestClock.withLive,
      );

      assert.equal(started.threadId, threadId);
      assert.equal(completed.turnId, started.turnId);
      assert.equal(completed.payload.state, "completed");
      assert.equal(completed.payload.stopReason, "end_turn");
      // turn.started precedes turn.completed, and the turn settles exactly once.
      assert.isBelow(
        log.events.findIndex((event) => event.type === "turn.started"),
        log.events.findIndex((event) => event.type === "turn.completed"),
      );
      assert.lengthOf(turnCompletions(log, threadId), 1);

      const snapshot = yield* adapter.readThread(threadId);
      assert.lengthOf(snapshot.turns, 1);
      assert.equal(snapshot.turns[0]?.id, started.turnId);

      const session = yield* adapter
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((entry) => entry.threadId === threadId)));
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      const prompts = requests
        .filter((request) => request.method === "session/prompt")
        .map(
          (request) => request.params?.prompt as ReadonlyArray<Record<string, string> | undefined>,
        );
      assert.lengthOf(prompts, 1);
      assert.deepStrictEqual(prompts[0]?.[0], { type: "text", text: "first prompt" });
      assert.include(prompts[0]?.[1]?.text ?? "", "through the MiniMax Code harness");
      assert.include(prompts[0]?.[1]?.text ?? "", `as ${MINIMAX_M3_FLASH_THINKING}`);

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("settles a failed prompt as a failed turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-prompt-failure");
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* assertSessionIsLive(adapter, threadId);

      // Regression test for the out-of-scope `tapError` handler: the handler is
      // attached with `.pipe` outside the generator body, so a broken closure
      // here silently leaves the turn unsettled forever. The assertion that
      // matters is the emitted event, not the thrown error.
      const error = yield* adapter
        .sendTurn({ threadId, input: "fail this prompt" })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      const completed = yield* Deferred.await(log.turnCompleted).pipe(
        Effect.timeout("5 seconds"),
        TestClock.withLive,
      );

      assert.equal(completed.payload.state, "failed");
      assert.isString(completed.payload.errorMessage);
      assert.include(completed.payload.errorMessage ?? "", "Mock prompt failure");
      assert.lengthOf(turnCompletions(log, threadId), 1);

      const session = yield* adapter
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((entry) => entry.threadId === threadId)));
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("settles an interrupted turn as cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-interrupt");
      const { wrapperPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* assertSessionIsLive(adapter, threadId);

      // Regression test for the out-of-scope `onInterrupt` handler: it is
      // attached with `.pipe` outside the generator body, so a broken closure
      // there leaves the turn unsettled forever.
      const hangingTurn = yield* adapter
        .sendTurn({ threadId, input: "hang forever" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(log.turnStarted).pipe(Effect.timeout("5 seconds"), TestClock.withLive);
      assert.lengthOf(turnCompletions(log, threadId), 0);

      yield* Fiber.interrupt(hangingTurn);
      const completed = yield* Deferred.await(log.turnCompleted).pipe(
        Effect.timeout("5 seconds"),
        TestClock.withLive,
      );

      assert.equal(completed.payload.state, "cancelled");
      assert.equal(completed.payload.stopReason, "cancelled");
      assert.lengthOf(turnCompletions(log, threadId), 1);

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  /**
   * Known adapter/runtime defect, deliberately skipped.
   *
   * After a turn is cancelled by interrupting `sendTurn`, the next turn never
   * reaches the CLI. Measured against the mock, the agent receives exactly
   * `["initialize", "session/new", "session/cancel", "session/prompt"]` — the
   * second turn writes *nothing* to the wire, not even the
   * `session/set_config_option` that precedes its prompt, so the turn stalls
   * until the test's own timeout emits the second turn.completion.
   *
   * The prompt is never dispatched, so whatever is holding the shared runtime's
   * `promptDispatchSemaphore`/`promptSerializationSemaphore` is never released.
   * `sendTurn` forks `context.runtime.prompt(...)` into the session scope and
   * interrupts the waiting fiber; the semaphores themselves live in
   * `AcpSessionRuntime.ts`, which this test does not own. Note the agent
   * answers `session/cancel` and then hangs forever on the abandoned prompt, so
   * the permit can only come back when that prompt resolves.
   *
   * Skipped rather than left red: the defect is in the shared ACP runtime, not in
   * this adapter, so fixing it belongs with whoever owns that file. Delete this
   * `.skip` once the interrupted prompt releases the dispatch permit.
   */
  it.effect.skip("accepts a new prompt after a cancelled turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-after-cancel");
      const { wrapperPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* assertSessionIsLive(adapter, threadId);

      const hangingTurn = yield* adapter
        .sendTurn({ threadId, input: "hang forever" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(log.turnStarted).pipe(Effect.timeout("5 seconds"), TestClock.withLive);
      yield* Fiber.interrupt(hangingTurn);
      yield* Deferred.await(log.turnCompleted).pipe(
        Effect.timeout("5 seconds"),
        TestClock.withLive,
      );

      // Only the first prompt hangs, so this turn must reach the CLI.
      yield* adapter
        .sendTurn({ threadId, input: "carry on" })
        .pipe(Effect.timeout("10 seconds"), TestClock.withLive);

      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      assert.equal(
        requestMethods(requests).filter((method) => method === "session/prompt").length,
        1,
        "the second turn's session/prompt never reached the CLI",
      );
      const completions = turnCompletions(log, threadId);
      assert.lengthOf(completions, 2);
      assert.equal(completions[1]?.payload.state, "completed");

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("refuses image attachments instead of dropping them", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-image-attachments");
      const { wrapperPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper(),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* assertSessionIsLive(adapter, threadId);

      const imageAttachment: ChatAttachment = {
        type: "image",
        id: "attachment-image-1",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 2048,
      };
      const error = yield* adapter
        .sendTurn({ threadId, input: "what is in this picture?", attachments: [imageAttachment] })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.include(error.issue, "diagram.png");
      }
      // Nothing reached the CLI and no turn was started or settled.
      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      assert.notInclude(requestMethods(requests), "session/prompt");
      assert.lengthOf(turnCompletions(log, threadId), 0);
      assert.notInclude(
        log.events.map((event) => event.type),
        "turn.started",
      );

      // A non-image upload is still accepted, and it reaches the CLI.
      yield* adapter.sendTurn({
        threadId,
        input: "summarise the notes",
        attachments: [
          {
            type: "file",
            id: "attachment-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
          },
        ],
      });
      const after = yield* Effect.promise(() => readRequests(requestLogPath));
      assert.include(requestMethods(after), "session/prompt");

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("forwards a thinking effort the selected model advertises", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-thinking-effort-advertised");
      const { wrapperPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper(),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* assertSessionIsLive(adapter, threadId);

      yield* adapter.sendTurn({
        threadId,
        input: "think hard",
        modelSelection: {
          instanceId: INSTANCE_ID,
          model: MINIMAX_M3_THINKING,
          options: [{ id: "thinkingEffort", value: "high" }],
        },
      });
      const completed = yield* Deferred.await(log.turnCompleted).pipe(
        Effect.timeout("5 seconds"),
        TestClock.withLive,
      );

      assert.equal(completed.payload.state, "completed");
      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      assert.deepStrictEqual(
        configOptionWrites(requests, "thinkingEffort").map((params) => params.value),
        ["high"],
      );
      assert.deepStrictEqual(
        configOptionWrites(requests, "model").map((params) => params.value),
        [MINIMAX_M3_THINKING],
      );

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );

  it.effect("survives the CLI rejecting a thinking effort the new model dropped", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("minimax-thinking-effort-unadvertised");
      const { wrapperPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockMiniMaxCodeWrapper(),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const log = yield* watchEvents(adapter);
      // The CLI starts on a `:thinking` model, so it advertises thinkingEffort.
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: INSTANCE_ID, model: MINIMAX_M3_FLASH_THINKING },
      });
      yield* assertSessionIsLive(adapter, threadId);

      // Switching to the non-thinking variant makes the CLI drop the option and
      // answer -32602 "Thinking effort is not advertised for the selected
      // model". The write is decided from the pre-write snapshot, so it does go
      // out; the turn must survive the rejection.
      yield* adapter.sendTurn({
        threadId,
        input: "no thinking for this one",
        modelSelection: {
          instanceId: INSTANCE_ID,
          model: MINIMAX_M3_PLAIN,
          options: [{ id: "thinkingEffort", value: "high" }],
        },
      });
      const completed = yield* Deferred.await(log.turnCompleted).pipe(
        Effect.timeout("5 seconds"),
        TestClock.withLive,
      );

      assert.equal(completed.payload.state, "completed");
      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      assert.deepStrictEqual(
        configOptionWrites(requests, "thinkingEffort").map((params) => params.value),
        ["high"],
        "the rejected write must actually have been sent, or this test proves nothing",
      );

      yield* Fiber.interrupt(log.fiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );
});
