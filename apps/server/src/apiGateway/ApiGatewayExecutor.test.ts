// @effect-diagnostics nodeBuiltinImport:off - A local HTTP server stands in for the API being called.
import * as NodeHttp from "node:http";

import { assert, it } from "@effect/vitest";
import {
  API_GATEWAY_MAX_RESPONSE_BYTES,
  type ApiGatewayExecuteInput,
  type ApiGatewayExecuteResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";

import { executeApiGatewayRequest } from "./ApiGatewayExecutor.ts";

/** Serves `handler` on a loopback port for the length of the test and yields its origin. */
const upstream = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeHttp.Server; readonly origin: string }>((resolve) => {
          const server = NodeHttp.createServer(handler);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = address !== null && typeof address === "object" ? address.port : 0;
            resolve({ server, origin: `http://127.0.0.1:${port}` });
          });
        }),
    ),
    ({ server }) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  ).pipe(Effect.map(({ origin }) => origin));

const input = (
  overrides: Partial<ApiGatewayExecuteInput> & Pick<ApiGatewayExecuteInput, "url">,
): ApiGatewayExecuteInput => ({
  method: "GET",
  headers: [],
  followRedirects: true,
  timeoutMs: 30_000,
  ...overrides,
});

const headerValues = (result: ApiGatewayExecuteResult, name: string) =>
  result.headers.filter((header) => header.name === name).map((header) => header.value);

it.layer(FetchHttpClient.layer)("ApiGatewayExecutor", (it) => {
  it.effect("sends the method, headers, and body, and returns what came back", () =>
    Effect.gen(function* () {
      const origin = yield* upstream((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          response.statusCode = 201;
          response.setHeader("x-seen-method", request.method ?? "");
          response.setHeader("x-seen-url", request.url ?? "");
          response.setHeader("x-seen-tag", request.headers["x-tag"] ?? "");
          response.setHeader("x-seen-cookie", request.headers.cookie ?? "");
          response.setHeader("x-seen-content-type", request.headers["content-type"] ?? "");
          response.setHeader("x-seen-traceparent", request.headers.traceparent ?? "none");
          // The same cookie twice, and an attribute no parser would keep.
          response.setHeader("set-cookie", ["a=1; Path=/", "a=2; Path=/admin; Flavor=Odd"]);
          response.end(Buffer.concat(chunks));
        });
      });

      const result = yield* executeApiGatewayRequest(
        input({
          method: "POST",
          url: `${origin}/items?tag=a%20b`,
          headers: [
            { name: "X-Tag", value: "one" },
            { name: "x-tag", value: "two" },
            { name: "Cookie", value: "a=1" },
            { name: "Cookie", value: "b=2" },
            { name: "Content-Type", value: "application/json" },
          ],
          body: '{"n":1}',
        }),
      );

      assert.strictEqual(result.status, 201);
      assert.strictEqual(result.url, `${origin}/items?tag=a%20b`);
      assert.deepEqual(headerValues(result, "x-seen-method"), ["POST"]);
      assert.deepEqual(headerValues(result, "x-seen-url"), ["/items?tag=a%20b"]);
      // A repeated header is one header: a list by commas, cookies by semicolons.
      assert.deepEqual(headerValues(result, "x-seen-tag"), ["one, two"]);
      assert.deepEqual(headerValues(result, "x-seen-cookie"), ["a=1; b=2"]);
      assert.deepEqual(headerValues(result, "x-seen-content-type"), ["application/json"]);
      // The user's request goes out as written, with no tracing headers added.
      assert.deepEqual(headerValues(result, "x-seen-traceparent"), ["none"]);
      // Each Set-Cookie line arrives as the server wrote it.
      assert.deepEqual(headerValues(result, "set-cookie"), [
        "a=1; Path=/",
        "a=2; Path=/admin; Flavor=Odd",
      ]);
      assert.deepEqual(result.body, {
        encoding: "utf8",
        data: '{"n":1}',
        bytes: 7,
        cutOff: null,
      });
    }),
  );

  it.effect("returns a redirect as the response unless asked to follow it", () =>
    Effect.gen(function* () {
      const origin = yield* upstream((request, response) => {
        if (request.url === "/start") {
          response.writeHead(302, { location: "/end" }).end();
          return;
        }
        response.end("arrived");
      });

      const manual = yield* executeApiGatewayRequest(
        input({ url: `${origin}/start`, followRedirects: false }),
      );
      assert.strictEqual(manual.status, 302);
      assert.deepEqual(headerValues(manual, "location"), ["/end"]);

      const followed = yield* executeApiGatewayRequest(input({ url: `${origin}/start` }));
      assert.strictEqual(followed.status, 200);
      assert.strictEqual(followed.url, `${origin}/end`);
      assert.strictEqual(followed.body.data, "arrived");
    }),
  );

  it.effect("returns a response that has no body", () =>
    Effect.gen(function* () {
      const origin = yield* upstream((_request, response) => {
        response.writeHead(204).end();
      });

      const result = yield* executeApiGatewayRequest(input({ method: "DELETE", url: origin }));

      assert.strictEqual(result.status, 204);
      assert.deepEqual(result.body, { encoding: "utf8", data: "", bytes: 0, cutOff: null });
    }),
  );

  it.effect("cuts a body at the size cap and says so", () =>
    Effect.gen(function* () {
      const origin = yield* upstream((_request, response) => {
        response.end(Buffer.alloc(API_GATEWAY_MAX_RESPONSE_BYTES + 4096, "a"));
      });

      const result = yield* executeApiGatewayRequest(input({ url: origin }));

      assert.strictEqual(result.body.cutOff, "size");
      assert.strictEqual(result.body.bytes, API_GATEWAY_MAX_RESPONSE_BYTES);
      assert.strictEqual(result.body.data.length, API_GATEWAY_MAX_RESPONSE_BYTES);
    }),
  );

  it.effect("returns the status and what arrived of a body still coming at the timeout", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      let pulls = 0;
      // An event stream: one event, then open for as long as the client stays.
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new TextEncoder().encode("data: 1\n\n")),
        pull: () => {
          pulls += 1;
          // The first pull refills the queue the event left. The second is the
          // reader asking for more, which it does once it has taken the event in.
          if (pulls < 2) return undefined;
          Deferred.doneUnsafe(waiting, Effect.void);
          return new Promise<void>(() => {});
        },
      });
      const fetchStream: typeof fetch = () =>
        Promise.resolve(
          new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
        );

      const fiber = yield* executeApiGatewayRequest(
        input({ url: "http://stream.test/events", timeoutMs: 5_000 }),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStream), Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* TestClock.adjust(5_000);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result.status, 200);
      assert.deepEqual(result.body, {
        encoding: "utf8",
        data: "data: 1\n\n",
        bytes: 9,
        cutOff: "timeout",
      });
    }),
  );

  it.effect("returns what arrived when the connection drops partway through the body", () =>
    Effect.gen(function* () {
      const origin = yield* upstream((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        // Flushed, then hung up on without the chunk that would end the body.
        response.write("partial", () => response.socket?.destroy());
      });

      const result = yield* executeApiGatewayRequest(input({ url: origin }));

      assert.strictEqual(result.status, 200);
      assert.deepEqual(result.body, {
        encoding: "utf8",
        data: "partial",
        bytes: 7,
        cutOff: "connection",
      });
    }),
  );

  it.effect("decodes text in the charset the response declares, and leaves binary as base64", () =>
    Effect.gen(function* () {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      const origin = yield* upstream((request, response) => {
        if (request.url === "/latin1") {
          response.setHeader("content-type", "text/plain; charset=iso-8859-1");
          response.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
          return;
        }
        if (request.url === "/utf16") {
          response.setHeader("content-type", "text/plain; charset=utf-16le");
          response.end(Buffer.from("hi", "utf16le"));
          return;
        }
        response.setHeader("content-type", "image/png");
        response.end(png);
      });

      const text = yield* executeApiGatewayRequest(input({ url: `${origin}/latin1` }));
      assert.deepEqual(text.body, { encoding: "utf8", data: "café", bytes: 4, cutOff: null });

      // Every other byte of this text is zero, which must not make it binary.
      const wide = yield* executeApiGatewayRequest(input({ url: `${origin}/utf16` }));
      assert.deepEqual(wide.body, { encoding: "utf8", data: "hi", bytes: 4, cutOff: null });

      const binary = yield* executeApiGatewayRequest(input({ url: `${origin}/image` }));
      assert.deepEqual(binary.body, {
        encoding: "base64",
        data: png.toString("base64"),
        bytes: png.byteLength,
        cutOff: null,
      });
    }),
  );

  it.effect("names the reason a request could not connect", () =>
    Effect.gen(function* () {
      // A port that was just released: nothing is listening on it.
      const origin = yield* Effect.scoped(upstream(() => {}));

      const error = yield* executeApiGatewayRequest(input({ url: origin })).pipe(Effect.flip);

      assert.strictEqual(error.reason, "network");
      assert.include(error.message, "ECONNREFUSED");
    }),
  );

  it.effect("gives up when no response arrives within the timeout", () =>
    Effect.gen(function* () {
      const origin = yield* upstream(() => {
        // Accepts the request and never answers.
      });

      const fiber = yield* executeApiGatewayRequest(input({ url: origin, timeoutMs: 5_000 })).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(5_000);
      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error.reason, "timeout");
      assert.strictEqual(error.message, "Timed out after 5 s.");
    }),
  );

  it.effect("drops the connection when the call is cancelled", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const dropped = yield* Deferred.make<void>();
      const origin = yield* upstream((_request, response) => {
        // Never answered, so the response only closes if the client hangs up.
        response.on("close", () => Deferred.doneUnsafe(dropped, Effect.void));
        Deferred.doneUnsafe(received, Effect.void);
      });

      const fiber = yield* executeApiGatewayRequest(input({ url: origin })).pipe(Effect.forkChild);
      yield* Deferred.await(received);
      yield* Fiber.interrupt(fiber);

      yield* Deferred.await(dropped);
    }),
  );

  it.effect("rejects a URL that is not http or https without sending anything", () =>
    Effect.gen(function* () {
      const error = yield* executeApiGatewayRequest(input({ url: "file:///etc/hosts" })).pipe(
        Effect.flip,
      );

      assert.strictEqual(error.reason, "invalid-request");
    }),
  );

  it.effect("sends credentials written in the URL as Basic auth", () =>
    Effect.gen(function* () {
      const origin = yield* upstream((request, response) => {
        response.setHeader("x-seen-authorization", request.headers.authorization ?? "none");
        response.setHeader("x-seen-url", request.url ?? "");
        response.end();
      });

      const result = yield* executeApiGatewayRequest(
        input({ url: origin.replace("http://", "http://ada:p%40ss@") + "/me" }),
      );

      // "ada:p@ss", with the escape in the URL undone.
      assert.deepEqual(headerValues(result, "x-seen-authorization"), ["Basic YWRhOnBAc3M="]);
      assert.deepEqual(headerValues(result, "x-seen-url"), ["/me"]);
      assert.strictEqual(result.url, `${origin}/me`);
    }),
  );

  it.effect("refuses a Host header for another host, which fetch would silently drop", () =>
    Effect.gen(function* () {
      let requests = 0;
      const origin = yield* upstream((_request, response) => {
        requests += 1;
        response.end();
      });

      const error = yield* executeApiGatewayRequest(
        input({ url: origin, headers: [{ name: "Host", value: "internal.example" }] }),
      ).pipe(Effect.flip);
      assert.strictEqual(error.reason, "invalid-request");
      assert.strictEqual(requests, 0);

      // The URL's own host is what fetch sends anyway.
      const same = yield* executeApiGatewayRequest(
        input({ url: origin, headers: [{ name: "Host", value: new URL(origin).host }] }),
      );
      assert.strictEqual(same.status, 200);
    }),
  );

  it.effect("refuses a header that cannot be sent, without repeating its value", () =>
    Effect.gen(function* () {
      let requests = 0;
      const origin = yield* upstream((_request, response) => {
        requests += 1;
        response.end();
      });
      const refusal = (name: string, value: string) =>
        executeApiGatewayRequest(input({ url: origin, headers: [{ name, value }] })).pipe(
          Effect.flip,
        );

      const lineBreak = yield* refusal("Authorization", "Bearer secret\ntoken");
      assert.strictEqual(lineBreak.reason, "invalid-request");
      assert.include(lineBreak.message, "authorization");
      // The message ends up in the trace file, where a token does not belong.
      assert.notInclude(lineBreak.message, "secret");

      const badName = yield* refusal("My Header", "1");
      assert.strictEqual(badName.reason, "invalid-request");
      assert.include(badName.message, "my header");

      // fetch fails on this one too, but as if the network had.
      const connection = yield* refusal("Transfer-Encoding", "chunked");
      assert.strictEqual(connection.reason, "invalid-request");
      assert.include(connection.message, "transfer-encoding");
      assert.strictEqual(requests, 0);
    }),
  );

  it.effect("sends header text as UTF-8 and reads it back the same way", () =>
    Effect.gen(function* () {
      const origin = yield* upstream((request, response) => {
        // Node hands over a header's bytes one per character.
        const seen = String(request.headers["x-name"]);
        response.setHeader("x-echo", seen);
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end(Buffer.from(seen, "latin1"));
      });

      const result = yield* executeApiGatewayRequest(
        input({ url: origin, headers: [{ name: "X-Name", value: "José ☕" }] }),
      );

      assert.strictEqual(result.body.data, "José ☕");
      assert.deepEqual(headerValues(result, "x-echo"), ["José ☕"]);
    }),
  );

  it.effect("sends a header whose name is also a property of every object", () =>
    Effect.gen(function* () {
      const origin = yield* upstream((request, response) => {
        response.setHeader("x-seen", String(request.headers.constructor));
        response.end();
      });

      const result = yield* executeApiGatewayRequest(
        input({ url: origin, headers: [{ name: "Constructor", value: "plain" }] }),
      );

      assert.deepEqual(headerValues(result, "x-seen"), ["plain"]);
    }),
  );
});
