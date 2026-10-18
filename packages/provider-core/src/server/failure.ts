import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";

import * as IdAllocator from "./IdAllocator.ts";
import * as Schema from "effect/Schema";

export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  override get message() {
    return "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.";
  }
}

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
export const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;

const DEFAULT_PROVIDER_FAILURE_MESSAGE = "Provider turn failed.";

function causeMessage(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  let message: string | undefined;
  // Held back until the walk finishes, so a nested error that states a concrete
  // reason wins over the generic advice to retry.
  let generic: string | undefined;
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      switch ((cause as Record<string, unknown>)._tag) {
        case "ContextHandoffBudgetError":
          return new ContextHandoffBudgetError().message;
        case "ClaudeBackgroundWorkBlocksQueryReplacementError":
        case "CursorModelUnavailableError":
          return stringField(cause, "message");
        case "ContextHandoffDeliveryUncertainError":
          return "T3 could not confirm whether conversation history reached the provider. Retry the turn to recover the session.";
        case "ProviderCommandUnsupportedError":
          // Deterministic: the provider cannot do this, so retrying never helps.
          message ??= stringField(cause, "message");
          break;
        case "ProviderAdapterProtocolError":
          // `detail` is T3's own wording for a condition it recognized, not
          // text the provider supplied, so it is safe and far more useful than
          // the generic retry advice: it names what was rejected and why.
          message ??= stringField(cause, "detail");
          break;
        case "ProviderAdapterTurnStartError":
          generic ??=
            "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.";
          break;
        case "ProviderAdapterEventStreamError":
          message ??=
            "The provider event stream closed unexpectedly. Retry the turn; if it keeps failing, check the provider and server logs.";
          break;
        case "ProviderAdapterOpenSessionError":
          message ??=
            "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.";
          break;
        case "ProviderAdapterResumeThreadError":
          message ??=
            "The provider conversation could not be resumed. Retry the turn; if it keeps failing, check the provider and server logs.";
          break;
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  return message ?? generic;
}

function stringField(value: unknown, key: "message" | "code" | "detail"): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

function redactProviderFailureText(value: string): string {
  return replaceUnsafeControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'](?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}

/**
 * Cheap gate: only messages carrying real tag markup take the HTML path. The
 * encoded angle brackets matter as much as the literal ones, because a page
 * that hides its own markup behind entities is exactly the case that must not
 * survive to be decoded by a markdown renderer.
 */
const HTML_MARKUP_PATTERN = /<\/?[a-z][^>]*>|<!doctype\b[^>]*>|&lt;|&#0*60;|&#x0*3c;/iu;

/** Tags whose boundaries carry meaning a reader needs as a line break. */
const HTML_BLOCK_TAG_PATTERN =
  /<\/?(?:br|p|div|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|tbody|thead|section|article|aside|header|footer|main|nav|figure|figcaption|blockquote|pre|hr|html|head|body|title|form|fieldset)\b[^>]*>/giu;

const HTML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
};

function codePointToString(codePoint: number): string | undefined {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10_ff_ff ||
    (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff)
  ) {
    return undefined;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/gu,
    (match: string, body: string): string => {
      const lowered = body.toLowerCase();
      if (lowered.startsWith("#x")) {
        return codePointToString(Number.parseInt(lowered.slice(2), 16)) ?? match;
      }
      if (lowered.startsWith("#")) {
        return codePointToString(Number.parseInt(lowered.slice(1), 10)) ?? match;
      }
      return HTML_NAMED_ENTITIES[lowered] ?? match;
    },
  );
}

/**
 * Gateways answer a failed turn with a whole HTML error page, and that page
 * rides into the client as the failure detail. Clients render detail as
 * markdown, so the raw document reads as markup noise and hands the client a
 * second injection surface. Reduce the document to the lines a user actually
 * needs, before redaction, so an entity-hidden URL still gets redacted as a
 * URL rather than slipping through as text.
 */
function readableProviderFailureText(value: string): string {
  if (!HTML_MARKUP_PATTERN.test(value)) return value;
  const decoded = decodeHtmlEntities(value);
  const text = decoded
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(HTML_BLOCK_TAG_PATTERN, "\n")
    .replace(/<[^>]*>/gu, "");
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactProviderFailureText(readableProviderFailureText(value));
  if (redacted.length <= maxLength) return redacted;
  let end = Math.max(0, maxLength - 1);
  const finalCodeUnit = redacted.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}…`;
}

export function makeProviderFailure(input: {
  readonly cause?: unknown;
  readonly message?: string | undefined;
  readonly code?: string | null | undefined;
  readonly class?: OrchestrationV2ProviderFailureClass;
  readonly retryable?: boolean | null;
  readonly resetAt?: string | null;
}): OrchestrationV2ProviderFailure {
  const rawMessage = input.message ?? causeMessage(input.cause) ?? DEFAULT_PROVIDER_FAILURE_MESSAGE;
  const message = boundedText(rawMessage, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  const rawCode = input.code ?? stringField(input.cause, "code") ?? null;
  const code =
    rawCode === null ? null : boundedText(rawCode, MAX_PROVIDER_FAILURE_CODE_LENGTH) || null;

  return {
    class: input.class ?? "unknown",
    message: message || DEFAULT_PROVIDER_FAILURE_MESSAGE,
    code,
    retryable: input.retryable ?? null,
    ...(input.class === "usage_limit" &&
    input.resetAt != null &&
    Number.isFinite(Date.parse(input.resetAt))
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(input.resetAt)) }
      : {}),
  };
}

export function makeProviderFailureTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry;
  readonly retryStartedAt?: DateTime.Utc;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: "failed",
    title: input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: input.retryStartedAt ?? input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "error",
    failure: input.failure,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  };
}

export function makeProviderRetryTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  const completed = input.status !== "running";
  let title = "Provider retry";
  if (input.status === "completed") {
    title = "Provider recovered";
  } else if (input.status === "failed") {
    title = input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
  } else if (input.status === "interrupted" || input.status === "cancelled") {
    title = "Provider retry stopped";
  }
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: input.status,
    title,
    startedAt: input.startedAt,
    completedAt: completed ? input.updatedAt : null,
    updatedAt: input.updatedAt,
    type: "error",
    failure: input.failure,
    retry: input.retry,
  };
}
