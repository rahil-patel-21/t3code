import {
  API_GATEWAY_MAX_RESPONSE_BYTES,
  ApiGatewayExecuteError,
  apiGatewayMethodSendsBody,
  type ApiGatewayBodyCutOff,
  type ApiGatewayExecuteInput,
  type ApiGatewayExecuteResult,
  type ApiGatewayHeader,
  type ApiGatewayResponseBody,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

function parseHttpUrl(value: string): URL | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/** A URL component percent-decoded, or as written when its escapes are malformed. */
function decodeUrlPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Headers by lowercased name. Repeated names become one header, joined the way
 * HTTP defines repetition: by commas, or by semicolons for cookies. A Map,
 * because names come from the client and an object would mistake
 * `constructor` for one already set.
 */
function combineHeaders(headers: ReadonlyArray<ApiGatewayHeader>): Map<string, string> {
  const combined = new Map<string, string>();
  for (const { name, value } of headers) {
    const key = name.trim().toLowerCase();
    if (key.length === 0) continue;
    const existing = combined.get(key);
    const separator = key === "cookie" ? "; " : ", ";
    combined.set(key, existing === undefined ? value : `${existing}${separator}${value}`);
  }
  return combined;
}

/** What a header name may be made of: a `token` in RFC 9110. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/;

/** Headers fetch keeps for the connection it opens. Given one, it fails the whole request. */
const CONNECTION_HEADERS = new Set(["expect", "keep-alive", "transfer-encoding", "upgrade"]);

/**
 * Why a header cannot be sent, or null when it can. fetch refuses the same
 * headers, but says little about why, and for a bad value its error quotes
 * the whole value, which is often a credential and would follow the failure
 * into the trace file.
 */
function headerProblem(name: string, value: string): string | null {
  if (!HEADER_NAME.test(name)) return `"${name}" cannot be used as a header name.`;
  if (CONNECTION_HEADERS.has(name)) {
    return `The "${name}" header belongs to the connection and cannot be set on a request.`;
  }
  return /[\0\r\n]/.test(value)
    ? `The "${name}" header has a line break in its value, which a header cannot hold.`
    : null;
}

// fetch takes a header value as bytes, one per character. Text goes out as
// UTF-8, as curl sends it, and comes back as UTF-8 when the bytes are that.
const toHeaderBytes = (value: string) => Buffer.from(value, "utf8").toString("latin1");
function fromHeaderBytes(value: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1"));
  } catch {
    return value;
  }
}

/**
 * fetch reports every failure as "fetch failed" and keeps the reason (a
 * refused connection, an unknown host, a TLS error) further down `cause`.
 */
function describeFailure(cause: unknown): string {
  let message = "";
  let current = cause;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    // Dual-stack connects fail as an AggregateError with an empty message.
    if (current instanceof AggregateError && current.errors.length > 0) {
      current = current.errors[0];
      continue;
    }
    if (current.message.length > 0) message = current.message;
    current = current.cause;
  }
  // fetch refuses a fixed list of ports (6000, 10080, the mail ports, ...) and says only this.
  if (message === "bad port") return "fetch does not allow requests to this port.";
  return message.length > 0 ? message : "The request could not be sent.";
}

/** The bytes as text in the declared charset, else UTF-8, or null when they are not text. */
function decodeText(bytes: Uint8Array, charset: string | undefined, isCutOff: boolean) {
  for (const label of charset === undefined ? ["utf-8"] : [charset, "utf-8"]) {
    try {
      // `stream` keeps a character cut in half where the body stopped from counting as invalid.
      const text = new TextDecoder(label, { fatal: true }).decode(bytes, { stream: isCutOff });
      // NUL decodes without error but no text contains it, so its presence
      // means binary. Checked after decoding: UTF-16 text is full of zero bytes.
      if (!text.includes("\0")) return text;
    } catch {
      // An unknown charset label or bytes that are not in it: try the next.
    }
  }
  return null;
}

function encodeBody(
  bytes: Uint8Array,
  contentType: string | undefined,
  cutOff: ApiGatewayBodyCutOff | null,
): ApiGatewayResponseBody {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
  const text = decodeText(bytes, charset, cutOff !== null);
  return text === null
    ? { encoding: "base64", data: Base64.encode(bytes), bytes: bytes.byteLength, cutOff }
    : { encoding: "utf8", data: text, bytes: bytes.byteLength, cutOff };
}

/**
 * Sends one request from this machine and returns whatever came back. Any
 * HTTP status is a result; only a request that produced no response fails.
 * Once the status and headers are in, they are returned even if the body then
 * stops short: a stream that never ends is still a response.
 */
export const executeApiGatewayRequest = Effect.fn("ApiGatewayExecutor.execute")(function* (
  input: ApiGatewayExecuteInput,
): Effect.fn.Return<ApiGatewayExecuteResult, ApiGatewayExecuteError, HttpClient.HttpClient> {
  const url = parseHttpUrl(input.url);
  if (url === null) {
    return yield* new ApiGatewayExecuteError({
      reason: "invalid-request",
      message: "Enter a full URL that starts with http:// or https://.",
    });
  }
  const headers = combineHeaders(input.headers);

  // `user:pass@host` means Basic auth, as it does to curl. fetch rejects such
  // a URL outright, with an error that repeats it, password included.
  if (url.username !== "" || url.password !== "") {
    if (!headers.has("authorization")) {
      const credentials = `${decodeUrlPart(url.username)}:${decodeUrlPart(url.password)}`;
      headers.set("authorization", `Basic ${Base64.encode(credentials)}`);
    }
    url.username = "";
    url.password = "";
  }

  // fetch always sends the URL's own host and silently drops a Host header.
  // Reaching a different host than the user named would be worse than refusing.
  const host = headers.get("host")?.trim().toLowerCase();
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (host !== undefined && host !== url.host && host !== `${url.hostname}:${defaultPort}`) {
    return yield* new ApiGatewayExecuteError({
      reason: "invalid-request",
      message: "The Host header cannot name a different host than the URL.",
    });
  }
  headers.delete("host");

  for (const [name, value] of headers) {
    const problem = headerProblem(name, value);
    if (problem !== null) {
      return yield* new ApiGatewayExecuteError({ reason: "invalid-request", message: problem });
    }
  }

  const body = apiGatewayMethodSendsBody(input.method) ? input.body : undefined;
  const request = HttpClientRequest.make(input.method)(url.href).pipe(
    body === undefined
      ? (self) => self
      : HttpClientRequest.bodyText(body, headers.get("content-type") ?? "text/plain"),
    HttpClientRequest.setHeaders(
      Object.fromEntries(Array.from(headers, ([name, value]) => [name, toHeaderBytes(value)])),
    ),
  );

  return yield* Effect.gen(function* () {
    // The client keeps one value per header name, which loses all but one
    // Set-Cookie. fetch itself yields each line, so they are recorded from it.
    const underlyingFetch = yield* FetchHttpClient.Fetch;
    let received: ReadonlyArray<ApiGatewayHeader> | undefined;
    const recordHeaders: typeof underlyingFetch = async (...args) => {
      const response = await underlyingFetch(...args);
      received = Array.from(response.headers, ([name, value]) => ({
        name,
        value: fromHeaderBytes(value),
      }));
      return response;
    };

    // Scoped, so leaving early (the size cap, a timeout, a cancelled call)
    // aborts the connection rather than draining it.
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const startedAt = yield* Clock.currentTimeMillis;
    const response = yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, recordHeaders),
      Effect.mapError(
        (error) =>
          new ApiGatewayExecuteError({
            reason: "network",
            message: describeFailure(error.reason.cause),
          }),
      ),
      Effect.timeoutOrElse({
        duration: input.timeoutMs,
        orElse: () =>
          Effect.fail(
            new ApiGatewayExecuteError({
              reason: "timeout",
              message: `Timed out after ${input.timeoutMs / 1000} s.`,
            }),
          ),
      }),
    );

    // Kept outside the read, so what arrived survives a read that stops short.
    const chunks: Uint8Array[] = [];
    let bodyBytes = 0;
    const headersAt = yield* Clock.currentTimeMillis;
    const stopped = yield* response.stream.pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          chunks.push(chunk);
          bodyBytes += chunk.byteLength;
          return bodyBytes <= API_GATEWAY_MAX_RESPONSE_BYTES;
        }),
      ),
      Effect.as<ApiGatewayBodyCutOff | null>(null),
      // The time the headers took is spent; the body has what is left of it.
      Effect.timeoutOrElse({
        duration: Math.max(0, input.timeoutMs - (headersAt - startedAt)),
        orElse: () => Effect.succeed("timeout" as const),
      }),
      // A response without a body (HEAD, 204, 304) has no stream to read.
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag === "EmptyBodyError" ? null : ("connection" as const)),
      ),
    );
    const cutOff = bodyBytes > API_GATEWAY_MAX_RESPONSE_BYTES ? "size" : stopped;
    const finishedAt = yield* Clock.currentTimeMillis;
    const responseHeaders = response.headers;
    return {
      status: response.status,
      url: response.url,
      headers:
        received ?? Object.entries(responseHeaders).map(([name, value]) => ({ name, value })),
      body: encodeBody(
        Buffer.concat(chunks).subarray(0, API_GATEWAY_MAX_RESPONSE_BYTES),
        responseHeaders["content-type"],
        cutOff,
      ),
      // The wall clock can step backwards; a duration cannot be negative.
      totalMs: Math.max(0, finishedAt - startedAt),
    };
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, {
      redirect: input.followRedirects ? "follow" : "manual",
    }),
    // The client's own span would record the URL and headers, which carry
    // the user's credentials, and would add trace headers to their request.
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  );
});
