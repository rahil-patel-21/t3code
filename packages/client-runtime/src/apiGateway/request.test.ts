import type { ApiGatewayKeyValue, ApiGatewayRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  apiGatewayVariables,
  EMPTY_API_GATEWAY_REQUEST,
  prepareApiGatewayRequest,
  withApiGatewayQuery,
  withApiGatewayUrl,
} from "./request.ts";

const row = (key: string, value: string, enabled = true): ApiGatewayKeyValue => ({
  key,
  value,
  enabled,
});

const request = (overrides: Partial<ApiGatewayRequest>): ApiGatewayRequest => ({
  ...EMPTY_API_GATEWAY_REQUEST,
  ...overrides,
});

const NO_VARIABLES = new Map<string, string>();

const headerMap = (prepared: ReturnType<typeof prepareApiGatewayRequest>) =>
  Object.fromEntries(prepared.input.headers.map((header) => [header.name, header.value]));

describe("URL and query rows", () => {
  it("reads the query string of a typed URL into rows", () => {
    const next = withApiGatewayUrl(EMPTY_API_GATEWAY_REQUEST, "https://api.test/items?page=2&flag");
    expect(next.url).toBe("https://api.test/items?page=2&flag");
    expect(next.query).toEqual([row("page", "2"), row("flag", "")]);
  });

  it("keeps a switched-off row in its place while the URL around it is edited", () => {
    const start = request({
      url: "https://api.test/items?a=1&b=2",
      query: [row("a", "1"), row("debug", "true", false), row("b", "2")],
    });
    const next = withApiGatewayUrl(start, "https://api.test/items?a=9&b=2&c=3");
    expect(next.query).toEqual([
      row("a", "9"),
      row("debug", "true", false),
      row("b", "2"),
      row("c", "3"),
    ]);
  });

  it("drops rows whose parameter was deleted from the URL", () => {
    const start = request({
      url: "https://api.test/items?a=1&b=2",
      query: [row("a", "1"), row("b", "2")],
    });
    expect(withApiGatewayUrl(start, "https://api.test/items").query).toEqual([]);
  });

  it("rewrites only the query string when rows change, leaving placeholders as written", () => {
    const start = request({ url: "{{host}}/items?old=1#top" });
    const next = withApiGatewayQuery(start, [
      row("q", "{{term}} x"),
      row("debug", "true", false),
      row("", ""),
      row("flag", ""),
    ]);
    expect(next.url).toBe("{{host}}/items?q={{term}} x&flag#top");
    expect(next.query).toHaveLength(4);
  });

  it("removes the question mark with the last row", () => {
    const start = request({ url: "https://api.test/items?a=1", query: [row("a", "1")] });
    expect(withApiGatewayQuery(start, []).url).toBe("https://api.test/items");
  });

  it("reads no row from an empty parameter, so typing around one adds none", () => {
    const once = withApiGatewayUrl(EMPTY_API_GATEWAY_REQUEST, "https://api.test/x?a=1&=&&");
    const again = withApiGatewayUrl(once, "https://api.test/x?a=1&=&&b");
    expect(once.query).toEqual([row("a", "1")]);
    expect(again.query).toEqual([row("a", "1"), row("b", "")]);
  });

  it("leaves the text of parameters whose rows did not change as it was written", () => {
    const start = withApiGatewayUrl(
      EMPTY_API_GATEWAY_REQUEST,
      "https://api.test/x?empty=&sig=a%3Db&flag",
    );
    const flagOff = start.query.map((each) =>
      each.key === "flag" ? { ...each, enabled: false } : each,
    );
    expect(withApiGatewayQuery(start, flagOff).url).toBe("https://api.test/x?empty=&sig=a%3Db");
  });

  it("keeps a value that contains query punctuation as one value", () => {
    const rows = [row("q", "a&b=c#d"), row("k=1", "x")];
    const next = withApiGatewayQuery(request({ url: "https://api.test/items" }), rows);

    expect(next.url).toBe("https://api.test/items?q=a%26b=c%23d&k%3D1=x");
    // Read back from the URL, the rows say what was typed into them.
    expect(withApiGatewayUrl(EMPTY_API_GATEWAY_REQUEST, next.url).query).toEqual(rows);
  });
});

describe("apiGatewayVariables", () => {
  it("takes enabled rows by name, the later row winning", () => {
    const variables = apiGatewayVariables([
      row("host", "one.test"),
      row(" host ", "two.test"),
      row("token", "off", false),
      row("", "nameless"),
    ]);
    expect([...variables]).toEqual([["host", "two.test"]]);
  });
});

describe("prepareApiGatewayRequest", () => {
  it("fills placeholders everywhere and reports the ones it could not", () => {
    const prepared = prepareApiGatewayRequest(
      request({
        method: "POST",
        url: "{{host}}/users/{{ id }}?trace={{trace}}",
        headers: [row("X-Tenant", "{{tenant}}")],
        body: { mode: "raw", rawLanguage: "json", raw: '{"name":"{{name}}"}', form: [] },
      }),
      new Map([
        ["host", "https://api.test"],
        ["id", "42"],
        ["name", "Ada"],
      ]),
    );
    expect(prepared.input.url).toBe("https://api.test/users/42?trace={{trace}}");
    expect(prepared.input.body).toBe('{"name":"Ada"}');
    expect(headerMap(prepared)).toEqual({
      "X-Tenant": "{{tenant}}",
      "Content-Type": "application/json",
    });
    expect(prepared.unresolved).toEqual(["trace", "tenant"]);
  });

  it("fills a variable written with another, and reports what is left unfilled", () => {
    const prepared = prepareApiGatewayRequest(
      request({ url: "{{baseUrl}}/users?t={{token}}" }),
      new Map([
        ["baseUrl", "https://{{host}}/api"],
        ["host", "example.com"],
      ]),
    );
    expect(prepared.input.url).toBe("https://example.com/api/users?t={{token}}");
    expect(prepared.unresolved).toEqual(["token"]);
  });

  it("stops filling a variable that names itself", () => {
    const prepared = prepareApiGatewayRequest(
      request({ url: "https://api.test/{{loop}}" }),
      new Map([["loop", "{{loop}}x"]]),
    );
    expect(prepared.input.url).toMatch(/^https:\/\/api\.test\/\{\{loop\}\}x+$/);
  });

  it("sends half of an emoji in a query parameter as the replacement character", () => {
    const prepared = prepareApiGatewayRequest(
      request({
        url: "https://api.test",
        auth: {
          ...EMPTY_API_GATEWAY_REQUEST.auth,
          type: "apiKey",
          apiKeyName: "key",
          apiKeyValue: "a\ud83d",
          apiKeyIn: "query",
        },
      }),
      NO_VARIABLES,
    );
    expect(prepared.input.url).toBe("https://api.test?key=a%EF%BF%BD");
  });

  it("assumes http for a URL written without a scheme", () => {
    const prepared = prepareApiGatewayRequest(
      request({ url: "localhost:3000/health" }),
      NO_VARIABLES,
    );
    expect(prepared.input.url).toBe("http://localhost:3000/health");
  });

  it("leaves out rows that are switched off or have no name", () => {
    const prepared = prepareApiGatewayRequest(
      request({
        url: "https://api.test",
        headers: [row("X-On", "1"), row("X-Off", "2", false), row("  ", "3")],
      }),
      NO_VARIABLES,
    );
    expect(headerMap(prepared)).toEqual({ "X-On": "1" });
  });

  it("turns each auth type into the header or parameter it stands for", () => {
    const auth = EMPTY_API_GATEWAY_REQUEST.auth;
    const prepare = (overrides: Partial<ApiGatewayRequest["auth"]>) =>
      prepareApiGatewayRequest(
        request({ url: "https://api.test/items?a=1", auth: { ...auth, ...overrides } }),
        new Map([["token", "abc"]]),
      );

    expect(headerMap(prepare({ type: "bearer", bearerToken: " {{token}} " }))).toEqual({
      Authorization: "Bearer abc",
    });
    expect(
      headerMap(prepare({ type: "basic", basicUsername: "ada", basicPassword: "pässword" })),
    ).toEqual({ Authorization: "Basic YWRhOnDDpHNzd29yZA==" });
    expect(
      headerMap(prepare({ type: "apiKey", apiKeyName: "X-Api-Key", apiKeyValue: "{{token}}" })),
    ).toEqual({ "X-Api-Key": "abc" });
    expect(
      prepare({ type: "apiKey", apiKeyName: "api key", apiKeyValue: "a&b", apiKeyIn: "query" })
        .input.url,
    ).toBe("https://api.test/items?a=1&api%20key=a%26b");
    // A token that is not filled in yet adds no header rather than an empty credential.
    expect(prepare({ type: "bearer", bearerToken: "  " }).input.headers).toEqual([]);
  });

  it("lets a header the user wrote win over the one auth or the body would add", () => {
    const prepared = prepareApiGatewayRequest(
      request({
        method: "POST",
        url: "https://api.test",
        headers: [
          row("authorization", "Custom abc"),
          row("content-type", "application/vnd.api+json"),
        ],
        auth: { ...EMPTY_API_GATEWAY_REQUEST.auth, type: "bearer", bearerToken: "ignored" },
        body: { mode: "raw", rawLanguage: "json", raw: "{}", form: [] },
      }),
      NO_VARIABLES,
    );
    expect(headerMap(prepared)).toEqual({
      authorization: "Custom abc",
      "content-type": "application/vnd.api+json",
    });
  });

  it("encodes a form body and names its content type", () => {
    const prepared = prepareApiGatewayRequest(
      request({
        method: "POST",
        url: "https://api.test",
        body: {
          mode: "urlencoded",
          rawLanguage: "json",
          raw: "",
          form: [row("name", "Ada Lovelace"), row("note", "a&b"), row("skipped", "x", false)],
        },
      }),
      NO_VARIABLES,
    );
    expect(prepared.input.body).toBe("name=Ada+Lovelace&note=a%26b");
    expect(headerMap(prepared)).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
  });

  it("writes each multipart field as a part under the boundary its content type names", () => {
    const prepared = prepareApiGatewayRequest(
      request({
        method: "POST",
        url: "https://api.test",
        body: {
          mode: "multipart",
          rawLanguage: "json",
          raw: "",
          form: [row("title", "hello"), row("note", "has ----T3CodeFormBoundary inside")],
        },
      }),
      NO_VARIABLES,
    );
    // Random per request, so a field that holds the fixed part cannot end a part early.
    const boundary = /^multipart\/form-data; boundary=(----T3CodeFormBoundary[a-z\d]+)$/.exec(
      headerMap(prepared)["Content-Type"] ?? "",
    )?.[1];
    expect(boundary).toBeDefined();
    expect(prepared.input.body).toBe(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="title"',
        "",
        "hello",
        `--${boundary}`,
        'Content-Disposition: form-data; name="note"',
        "",
        "has ----T3CodeFormBoundary inside",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
  });

  it("replaces every hand-written content type of a multipart body with the one naming its boundary", () => {
    const prepared = prepareApiGatewayRequest(
      request({
        method: "POST",
        url: "https://api.test",
        headers: [row("content-type", "text/plain"), row("Content-Type", "multipart/mixed")],
        body: { mode: "multipart", rawLanguage: "json", raw: "", form: [row("title", "hello")] },
      }),
      NO_VARIABLES,
    );

    expect(prepared.input.headers).toEqual([
      { name: "Content-Type", value: expect.stringMatching(/^multipart\/form-data; boundary=/) },
    ]);
  });

  it("keeps a multipart field name from closing its quotes or starting a header of its own", () => {
    const prepared = prepareApiGatewayRequest(
      request({
        method: "POST",
        url: "https://api.test",
        body: {
          mode: "multipart",
          rawLanguage: "json",
          raw: "",
          form: [row('a"b\r\nX-Injected: 1', "value")],
        },
      }),
      NO_VARIABLES,
    );

    expect(prepared.input.body).toContain('name="a%22b%0D%0AX-Injected: 1"\r\n\r\nvalue\r\n');
  });

  it("sends no body and no content type with GET, keeping the body for another method", () => {
    const withBody = request({
      url: "https://api.test",
      body: { mode: "raw", rawLanguage: "json", raw: "{}", form: [] },
    });
    const prepared = prepareApiGatewayRequest(withBody, NO_VARIABLES);
    expect(prepared.input.body).toBeUndefined();
    expect(prepared.input.headers).toEqual([]);
    expect(
      prepareApiGatewayRequest({ ...withBody, method: "PATCH" }, NO_VARIABLES).input.body,
    ).toBe("{}");
  });
});
