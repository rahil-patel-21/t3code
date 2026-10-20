import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
  MAX_PROVIDER_FAILURE_CODE_LENGTH,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  ContextHandoffBudgetError,
} from "./failure.ts";
import * as IdAllocator from "./IdAllocator.ts";
import {
  ProviderAdapterProtocolError,
  ProviderAdapterTurnStartError,
  ProviderCommandUnsupportedError,
} from "./ProviderAdapter.ts";

it("redacts credentials and URL secrets from provider failures", () => {
  const failure = makeProviderFailure({
    message:
      'request failed: Authorization: Bearer bearer-secret https://user:pass@example.test/path?access_token=url-secret#fragment {"token":"json-secret"} api_key=key-secret sk-abcdefghijklmnop',
    code: "provider_rejected",
    class: "provider_error",
  });

  assert.equal(failure.class, "provider_error");
  assert.equal(failure.code, "provider_rejected");
  assert.include(failure.message, "[REDACTED]");
  assert.include(failure.message, "https://example.test/path");
  assert.notInclude(failure.message, "bearer-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "url-secret");
  assert.notInclude(failure.message, "json-secret");
  assert.notInclude(failure.message, "key-secret");
  assert.notInclude(failure.message, "sk-abcdefghijklmnop");
});

it("replaces unsafe control characters without stripping whitespace", () => {
  const failure = makeProviderFailure({ message: "before\u0000\u0007\t\nafter\u007f" });

  assert.equal(failure.message, "before  \t\nafter");
});

it("bounds provider-controlled failure strings", () => {
  const failure = makeProviderFailure({
    message: "m".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH + 500),
    code: "c".repeat(MAX_PROVIDER_FAILURE_CODE_LENGTH + 50),
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  assert.equal(failure.code?.length, MAX_PROVIDER_FAILURE_CODE_LENGTH);
  assert.match(failure.message, /…$/u);
  assert.match(failure.code ?? "", /…$/u);
});

it("does not split a surrogate pair at the truncation boundary", () => {
  const failure = makeProviderFailure({
    message: `${"a".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 2)}🚀tail`,
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 1);
  assert.equal(failure.message.at(-1), "…");
  assert.notMatch(failure.message.slice(0, -1), /[\uD800-\uDBFF]$/u);
});

it("does not expose arbitrary cause messages and preserves explicit messages", () => {
  const cause = new Error("Adapter failed", {
    cause: new Error("Session expired. Sign in again."),
  });
  for (const value of [
    cause,
    Cause.fail(cause),
    "Session expired. Sign in again.",
    { message: "Session expired. Sign in again." },
  ]) {
    assert.equal(makeProviderFailure({ cause: value }).message, "Provider turn failed.");
    assert.equal(
      makeProviderFailure({ cause: value, message: "Provider connection closed." }).message,
      "Provider connection closed.",
    );
  }
});

it("preserves actionable handoff errors wrapped by turn startup", () => {
  const cause = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:handoff-error"),
    providerThreadId: ProviderThreadId.make("provider-thread:handoff-error"),
    runId: RunId.make("run:handoff-error"),
    cause: new ContextHandoffBudgetError(),
  });
  assert.equal(
    makeProviderFailure({ cause: Cause.fail(cause) }).message,
    new ContextHandoffBudgetError().message,
  );
});

it("keeps the generic retry advice when turn startup fails without a stated reason", () => {
  const cause = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:plain-start-error"),
    providerThreadId: ProviderThreadId.make("provider-thread:plain-start-error"),
    runId: RunId.make("run:plain-start-error"),
  });
  assert.include(
    makeProviderFailure({ cause: Cause.fail(cause) }).message,
    "provider could not start this turn",
  );
});

it("names an unsupported command instead of advising a retry that cannot work", () => {
  const cause = new ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("minimaxCode"),
    threadId: ThreadId.make("thread:compact-unsupported"),
    providerThreadId: ProviderThreadId.make("provider-thread:compact-unsupported"),
    runId: RunId.make("run:compact-unsupported"),
    cause: new ProviderCommandUnsupportedError({
      driver: ProviderDriverKind.make("minimaxCode"),
      command: "conversation compaction (/compact)",
    }),
  });
  const message = makeProviderFailure({ cause: Cause.fail(cause) }).message;
  assert.equal(message, "minimaxCode does not support conversation compaction (/compact).");
  assert.notInclude(message, "Retry the turn");
});

it.each([
  ["previous_turn_active", "the previous turn is still running"],
  ["attachment_unreadable", "an attachment could not be read"],
] as const)("names %s without exposing provider detail or losing guidance", (reason, wording) => {
  const failure = makeProviderFailure({
    cause: Cause.fail({
      _tag: "ProviderAdapterTurnStartError",
      cause: Cause.fail(
        new ProviderAdapterProtocolError({
          driver: ProviderDriverKind.make("claudeAgent"),
          detail: `Private configuration: ${"x".repeat(5000)}`,
          reason,
        }),
      ),
    }),
  });
  assert.equal(
    failure.message,
    `The provider could not start this turn: ${wording}. Retry the turn; if it keeps failing, check the provider setup and server logs.`,
  );
});

it("keeps unrecognized reasons and provider text out of category messages", () => {
  for (const cause of [
    "Private launch command",
    { _tag: "ProviderAdapterProtocolError", detail: "Pi model 'private-config' is invalid" },
    { _tag: "ProviderAdapterProtocolError", reason: "private-config" },
    { _tag: "ProviderAdapterProtocolError", reason: "constructor" },
    { _tag: "constructor", cause: "private-config" },
  ]) {
    assert.equal(
      makeProviderFailure({ cause: { _tag: "ProviderAdapterTurnStartError", cause } }).message,
      "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.",
    );
  }
  assert.equal(
    makeProviderFailure({
      cause: { _tag: "ProviderAdapterProtocolError", reason: "previous_turn_active" },
    }).message,
    "Provider turn failed.",
  );
});

it("uses the innermost category without carrying an outer reason into it", () => {
  assert.equal(
    makeProviderFailure({
      cause: {
        _tag: "ProviderAdapterTurnStartError",
        cause: {
          _tag: "ProviderAdapterProtocolError",
          reason: "previous_turn_active",
          cause: Cause.fail({ _tag: "ProviderAdapterOpenSessionError" }),
        },
      },
    }).message,
    "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.",
  );
});

it("does not expose defect text nested inside a known error category", () => {
  const failure = makeProviderFailure({
    cause: {
      _tag: "ProviderAdapterEventStreamError",
      cause: new Error(
        `Session rejected: Bearer nested-secret https://user:pass@example.test/path?token=secret ${"x".repeat(5000)}`,
      ),
    },
  });
  assert.include(failure.message, "provider event stream closed unexpectedly");
  assert.notInclude(failure.message, "Session rejected:");
  assert.notInclude(failure.message, "nested-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "token=secret");
  assert.isBelow(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
});

it("handles cyclic causes and throwing accessors", () => {
  const cyclic: { message: string; cause?: unknown } = {
    message: "Provider disconnected. Retry the turn.",
  };
  cyclic.cause = cyclic;
  assert.equal(makeProviderFailure({ cause: cyclic }).message, "Provider turn failed.");
  assert.equal(
    makeProviderFailure({
      cause: {
        get message() {
          throw new Error("unreadable");
        },
        get cause() {
          throw new Error("unreadable");
        },
      },
    }).message,
    "Provider turn failed.",
  );
});

it("falls back when inspecting a provider cause throws", () => {
  const cause = new Proxy(
    {},
    {
      has() {
        throw new Error("unreadable provider cause");
      },
    },
  );
  assert.equal(makeProviderFailure({ cause }).message, "Provider turn failed.");
});

it("does not serialize arbitrary provider causes", () => {
  const failure = makeProviderFailure({
    cause: {
      payload: { authorization: "Bearer nested-secret" },
      stack: "private provider stack",
    },
    class: "transport_error",
  });

  assert.deepEqual(failure, {
    class: "transport_error",
    message: "Provider turn failed.",
    code: null,
    retryable: null,
  });
});

it("reduces a gateway HTML error page to readable lines", () => {
  const failure = makeProviderFailure({
    message:
      "Internal error: MiniMax Code Runtime failed: 503 <HTML><HEAD><TITLE>Internal Server Error</TITLE></HEAD><BODY><H1>Internal Server Error - Write</H1><P>The server encountered an internal error or misconfiguration and was unable to complete your request.<P>Reference&#32;&#35;&#46;865f3a17&#46;1791461588&#46;5542f301<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;4&#46;865f3a17&#46;1791461588&#46;5542f301</BODY></HTML>",
  });

  assert.equal(
    failure.message,
    [
      "Internal error: MiniMax Code Runtime failed: 503",
      "Internal Server Error",
      "Internal Server Error - Write",
      "The server encountered an internal error or misconfiguration and was unable to complete your request.",
      "Reference #.865f3a17.1791461588.5542f301",
      "https://errors.edgesuite.net/4.865f3a17.1791461588.5542f301",
    ].join("\n"),
  );
});

it("keeps inline markup inline and drops script and style bodies", () => {
  const failure = makeProviderFailure({
    message:
      'Turn failed: <b>Bad</b> request (<i>code</i> 400) <script>alert("xss")</script><style>.a{color:red}</style>Retry the turn.',
  });

  assert.equal(failure.message, "Turn failed: Bad request (code 400) Retry the turn.");
});

it("strips entity-encoded markup instead of leaving a tag for the client to parse", () => {
  const failure = makeProviderFailure({
    message:
      "&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;Gateway rejected the turn.",
  });

  assert.equal(failure.message, "Gateway rejected the turn.");
});

it("redacts secrets inside an entity-hidden URL", () => {
  const failure = makeProviderFailure({
    message:
      "<P>https&#58;&#47;&#47;user&#58;pass&#64;example&#46;test&#47;path&#63;access_token&#61;entity-secret</P>",
  });

  assert.equal(failure.message, "https://example.test/path");
  assert.notInclude(failure.message, "entity-secret");
});

it("falls back to the default message when the page carries no readable text", () => {
  const failure = makeProviderFailure({ message: "<!DOCTYPE html><HTML><HEAD></HEAD></HTML>" });

  assert.equal(failure.message, "Provider turn failed.");
});

it.effect("keys terminal failure items by provider turn across retries and fallback paths", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const driver = ProviderDriverKind.make("codex");
    const runId = RunId.make("run:provider-failure-id");
    const base = {
      idAllocator,
      driver,
      threadId: ThreadId.make("thread:provider-failure-id"),
      runId,
      nodeId: NodeId.make("node:provider-failure-id"),
      providerThreadId: ProviderThreadId.make("provider-thread:provider-failure-id"),
      itemOrdinal: 101,
      failure: makeProviderFailure({ message: "Provider failed" }),
      occurredAt: DateTime.makeUnsafe("2026-06-22T12:00:00.000Z"),
    } as const;
    const firstTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:first");
    const secondTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:second");

    const firstAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: firstTurnId,
    });
    const retriedAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: secondTurnId,
    });
    const ingestorFallback = makeProviderFailureTurnItem({
      ...base,
      runId: null,
      nodeId: null,
      providerTurnId: firstTurnId,
    });

    assert.notEqual(firstAttempt.id, retriedAttempt.id);
    assert.equal(firstAttempt.id, ingestorFallback.id);
    assert.equal(firstAttempt.ordinal, 101);
  }).pipe(Effect.provide(IdAllocator.layer)),
);
