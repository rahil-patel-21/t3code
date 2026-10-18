import { describe, expect, it } from "vite-plus/test";

import { parseCurlCommand, toCurlCommand } from "./curl.ts";
import { prepareApiGatewayRequest } from "./request.ts";

const row = (key: string, value: string) => ({ key, value, enabled: true });

describe("parseCurlCommand", () => {
  it("reads a command copied from a browser's network panel", () => {
    const parsed = parseCurlCommand(`curl 'https://api.test/v1/users?page=2' \\
  -H 'accept: application/json' \\
  -H 'content-type: application/json' \\
  -b 'session=abc; theme=dark' \\
  --data-raw $'{"name":"O\\'Brien","note":"line\\nbreak \\u00e9"}' \\
  --compressed`);

    expect(parsed).toMatchObject({
      method: "POST",
      url: "https://api.test/v1/users?page=2",
      query: [row("page", "2")],
      headers: [
        row("accept", "application/json"),
        row("content-type", "application/json"),
        row("Cookie", "session=abc; theme=dark"),
      ],
      body: { mode: "raw", rawLanguage: "json", raw: '{"name":"O\'Brien","note":"line\nbreak é"}' },
    });
  });

  it("reads form data, basic auth, and an explicit method", () => {
    const parsed = parseCurlCommand(
      `curl -X put -u ada:open:sesame -d 'name=Ada+Lovelace' -d "note=a%26b" https://api.test/profile`,
    );

    expect(parsed).toMatchObject({
      method: "PUT",
      auth: { type: "basic", basicUsername: "ada", basicPassword: "open:sesame" },
      body: { mode: "urlencoded", form: [row("name", "Ada Lovelace"), row("note", "a&b")] },
    });
  });

  it("keeps data that rows would send differently as the text curl sends", () => {
    for (const data of ["hello world", "SELECT 1", "name=caf%E9", "lang=en%2Dgb"]) {
      expect(parseCurlCommand(`curl -d '${data}' https://api.test/in`)).toMatchObject({
        method: "POST",
        headers: [row("Content-Type", "application/x-www-form-urlencoded")],
        body: { mode: "raw", rawLanguage: "text", raw: data },
      });
    }
  });

  it("treats JSON sent without a content type as JSON rather than a form", () => {
    expect(parseCurlCommand(`curl https://api.test -d '{"a":1}'`)).toMatchObject({
      method: "POST",
      body: { mode: "raw", rawLanguage: "json", raw: '{"a":1}' },
    });
  });

  it("moves data into the query string for -G", () => {
    const parsed = parseCurlCommand(
      `curl -G https://api.test/search --data-urlencode 'q=a b&c' -d limit=5`,
    );

    expect(parsed).toMatchObject({
      method: "GET",
      url: "https://api.test/search?q=a%20b%26c&limit=5",
      // The row shows the `&` itself; in the URL it stays escaped so it cannot split the value.
      query: [row("q", "a%20b&c"), row("limit", "5")],
      body: { mode: "none" },
    });
  });

  it("reads multipart fields, bundled flags, and values attached to their option", () => {
    const parsed = parseCurlCommand(
      `curl -sSL -XPATCH --header=X-Trace:on -F title=Hello -F file=@photo.png -m 2.5 -o out.json --url https://api.test/upload`,
    );

    expect(parsed).toMatchObject({
      method: "PATCH",
      url: "https://api.test/upload",
      headers: [row("X-Trace", "on")],
      body: { mode: "multipart", form: [row("title", "Hello"), row("file", "@photo.png")] },
      followRedirects: true,
      timeoutMs: 2500,
    });
  });

  it("reads a form part's content without the settings curl reads after it", () => {
    const parsed = parseCurlCommand(
      `curl https://api.test -F 'kind=text;type=text/plain' -F 'note="a;b \\"c\\"";type=text/plain' --form-string 'raw=x;type=y'`,
    );

    expect(parsed?.body.form).toEqual([
      row("kind", "text"),
      row("note", 'a;b "c"'),
      row("raw", "x;type=y"),
    ]);
  });

  it("reads headers curl sends empty or removes", () => {
    const parsed = parseCurlCommand(`curl https://api.test -H 'X-Empty;' -H 'Accept:' -b jar.txt`);

    // `Accept:` removes a header curl adds itself, and `-b` without `=` names a cookie file.
    expect(parsed?.headers).toEqual([row("X-Empty", "")]);
  });

  it("reads the escapes browsers write in $'…' words", () => {
    expect(
      parseCurlCommand(`curl https://api.test --data-raw $'Hi\\041 \\U0001F600\\x7'`),
    ).toMatchObject({
      body: { raw: "Hi! 😀\x07" },
    });
  });

  it("adds query data before the fragment, whichever option gives it", () => {
    expect(
      parseCurlCommand(`curl -G 'https://api.test/s#top' -d q=1 --url-query 'tag=a b'`)?.url,
    ).toBe("https://api.test/s?q=1&tag=a%20b#top");
  });

  it("keeps a timeout too short to express in milliseconds at the shortest one", () => {
    expect(parseCurlCommand("curl -m 0.0004 https://api.test")?.timeoutMs).toBe(1);
  });

  it("follows redirects only when the command asks for it, as curl does", () => {
    expect(parseCurlCommand("curl https://api.test")?.followRedirects).toBe(false);
    expect(parseCurlCommand("curl --location https://api.test")?.followRedirects).toBe(true);
  });

  it("prefers a word with a scheme as the URL over the value of an option it does not know", () => {
    expect(parseCurlCommand("curl --retry-delay 2 https://api.test/items")?.url).toBe(
      "https://api.test/items",
    );
    expect(parseCurlCommand("curl localhost:3000/health")?.url).toBe("localhost:3000/health");
    // Options known to take a value do not lend it to the request, a URL or not.
    expect(parseCurlCommand("curl --doh-url https://dns.test/q https://api.test")?.url).toBe(
      "https://api.test",
    );
    expect(parseCurlCommand("curl -T file.txt api.test/upload")?.url).toBe("api.test/upload");
  });

  it("drops the line breaks a quoted URL can carry, which a URL cannot", () => {
    expect(parseCurlCommand("curl 'https://api.test/a\n\tb?x=1'")).toMatchObject({
      url: "https://api.test/ab?x=1",
      query: [row("x", "1")],
    });
  });

  it("uses HEAD for -I and keeps an unsupported method from becoming the request method", () => {
    expect(parseCurlCommand("curl -I https://api.test")?.method).toBe("HEAD");
    expect(parseCurlCommand("curl -X PURGE https://api.test")?.method).toBe("GET");
  });

  it("reads --json as a JSON body that asks for JSON back, and --oauth2-bearer as auth", () => {
    expect(
      parseCurlCommand(`curl --json '{"a":1}' --oauth2-bearer abc123 https://api.test/items`),
    ).toMatchObject({
      method: "POST",
      url: "https://api.test/items",
      headers: [row("Accept", "application/json")],
      auth: { type: "bearer", bearerToken: "abc123" },
      body: { mode: "raw", rawLanguage: "json", raw: '{"a":1}' },
    });
  });

  it("joins lines at a trailing backslash, except inside single quotes", () => {
    const parsed = parseCurlCommand(
      "curl https://api.test/notes \\\n  -H 'content-type: text/plain' \\\r\n  -d 'kept \\\nas written'",
    );

    expect(parsed).toMatchObject({
      url: "https://api.test/notes",
      headers: [row("content-type", "text/plain")],
      body: { mode: "raw", rawLanguage: "text", raw: "kept \\\nas written" },
    });
  });

  it("returns null when there is no URL to import", () => {
    expect(parseCurlCommand("curl -H 'accept: */*'")).toBeNull();
    expect(parseCurlCommand("   ")).toBeNull();
  });
});

describe("toCurlCommand", () => {
  it("writes a command that parses back into the request it was made from", () => {
    const original = parseCurlCommand(
      `curl https://api.test/items?tag=a -X DELETE -H "X-Note: it's fine" -H 'content-type: text/plain' -d 'plain body'`,
    );
    expect(original).not.toBeNull();
    const command = toCurlCommand(prepareApiGatewayRequest(original!, new Map()).input);

    expect(command).toBe(
      [
        "curl 'https://api.test/items?tag=a'",
        "--request DELETE",
        `--header 'X-Note: it'\\''s fine'`,
        "--header 'content-type: text/plain'",
        "--data-raw 'plain body'",
      ].join(" \\\n  "),
    );
    expect(parseCurlCommand(command)).toEqual(original);
  });

  it("leaves POST to the data, and writes an empty header the way curl sends one", () => {
    const command = toCurlCommand({
      method: "POST",
      url: "https://api.test",
      headers: [{ name: "X-Empty", value: "" }],
      body: "a=1",
      followRedirects: false,
      timeoutMs: 30_000,
    });

    expect(command).toBe(
      ["curl 'https://api.test'", "--header 'X-Empty;'", "--data-raw 'a=1'"].join(" \\\n  "),
    );
    expect(parseCurlCommand(command)).toMatchObject({
      method: "POST",
      headers: [row("X-Empty", "")],
    });
  });

  it("asks for headers only with --head, since -X HEAD would wait for a body", () => {
    expect(
      toCurlCommand({
        method: "HEAD",
        url: "https://api.test",
        headers: [],
        followRedirects: false,
        timeoutMs: 30_000,
      }),
    ).toBe("curl 'https://api.test' \\\n  --head");
  });

  it("stops curl from expanding brackets and braces in the URL", () => {
    const command = toCurlCommand({
      method: "GET",
      url: "https://api.test/items?filter[status]=open",
      headers: [],
      followRedirects: false,
      timeoutMs: 30_000,
    });

    expect(command).toBe("curl 'https://api.test/items?filter[status]=open' \\\n  --globoff");
    expect(parseCurlCommand(command)?.url).toBe("https://api.test/items?filter[status]=open");
  });

  it("carries redirect following and a timeout that is not the default", () => {
    const command = toCurlCommand({
      method: "GET",
      url: "https://api.test",
      headers: [],
      followRedirects: true,
      timeoutMs: 2500,
    });

    expect(command).toBe("curl 'https://api.test' \\\n  --location \\\n  --max-time 2.5");
    expect(parseCurlCommand(command)).toMatchObject({ followRedirects: true, timeoutMs: 2500 });
  });
});
