import {
  API_GATEWAY_DEFAULT_TIMEOUT_MS,
  API_GATEWAY_MAX_TIMEOUT_MS,
  ApiGatewayHttpMethod,
  type ApiGatewayAuth,
  type ApiGatewayBody,
  type ApiGatewayExecuteInput,
  type ApiGatewayKeyValue,
  type ApiGatewayRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  API_GATEWAY_URL_SCHEME,
  EMPTY_API_GATEWAY_REQUEST,
  encodeApiGatewayComponent,
  withApiGatewayUrl,
} from "./request.ts";

const isMethod = Schema.is(ApiGatewayHttpMethod);

const ANSI_C_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/**
 * A character by number after the backslash: `xHH`, `uHHHH`, `UHHHHHHHH`, or
 * up to three octal digits, as browsers write `!`. Sticky, so it is tried in
 * place without copying the rest.
 */
const ANSI_C_CODE = /x([\dA-Fa-f]{1,2})|u([\dA-Fa-f]{1,4})|U([\dA-Fa-f]{1,8})|([0-7]{1,3})/y;

/** Splits a POSIX shell command into words, honoring `'…'`, `"…"`, `$'…'`, and backslashes. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | "$'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    // A backslash before a line break joins the two lines, except inside
    // single quotes, where both characters are part of the text.
    if (char === "\\" && (quote === null || quote === '"')) {
      const lineBreak = next === "\n" ? 1 : next === "\r" && text[index + 2] === "\n" ? 2 : 0;
      if (lineBreak > 0) {
        index += lineBreak;
        continue;
      }
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && next !== undefined && '"\\$`'.includes(next)) {
        word += next;
        index += 1;
      } else word += char;
    } else if (quote === "$'") {
      if (char === "'") quote = null;
      else if (char === "\\" && next !== undefined) {
        ANSI_C_CODE.lastIndex = index + 1;
        const code = ANSI_C_CODE.exec(text);
        const point =
          code && Number.parseInt(code[1] ?? code[2] ?? code[3] ?? code[4]!, code[4] ? 8 : 16);
        if (code && point !== null && point <= 0x10ffff) {
          word += String.fromCodePoint(point);
          index += code[0].length;
        } else {
          word += ANSI_C_ESCAPES[next] ?? `\\${next}`;
          index += 1;
        }
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "$" && next === "'") {
      quote = "$'";
      inWord = true;
      index += 1;
    } else if (char === "\\" && next !== undefined) {
      word += next;
      inWord = true;
      index += 1;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

type ValueOption =
  | "method"
  | "header"
  /** The value is the whole header, under the name after the colon. */
  | `header:${string}`
  | "data"
  | "data-urlencode"
  | "url-query"
  | "json"
  | "form"
  | "form-string"
  | "user"
  | "bearer"
  | "max-time"
  | "url"
  /** Takes a value that has no counterpart here, so both are dropped. */
  | "skip";

/**
 * Options that take a value this importer has no use for. They are listed so
 * that value is not taken for the URL; an option missing here is read as a
 * flag, which is why a word with a scheme is preferred as the URL.
 */
const SKIPPED_VALUE_OPTIONS = `
  -o --output --output-dir -D --dump-header -w --write-out -c --cookie-jar --stderr
  --trace --trace-ascii -K --config -x --proxy --preproxy -U --proxy-user --proxy-header
  --noproxy --socks4 --socks4a --socks5 --socks5-hostname --doh-url --dns-servers
  --dns-interface --unix-socket --abstract-unix-socket --interface --local-port
  --connect-to --resolve -E --cert --cert-type --key --key-type --pass --cacert --capath
  --crlfile --pinnedpubkey --ciphers --tls13-ciphers --curves --tls-max --connect-timeout
  --max-redirs --retry --retry-delay --retry-max-time --expect100-timeout
  --happy-eyeballs-timeout-ms --keepalive-time --limit-rate --rate -Y --speed-limit
  -y --speed-time --max-filesize -z --time-cond -C --continue-at -r --range
  -T --upload-file --netrc-file --alt-svc --hsts --etag-save --etag-compare --aws-sigv4
  --proto --proto-default --proto-redir --request-target --service-name
  --create-file-mode --parallel-max --variable
`
  .split(/\s+/)
  .filter((name) => name !== "");

/** Options that take a value, and what the value is. */
const VALUE_OPTIONS: Record<string, ValueOption> = {
  ...Object.fromEntries(SKIPPED_VALUE_OPTIONS.map((name) => [name, "skip" as const])),
  "-X": "method",
  "--request": "method",
  "-H": "header",
  "--header": "header",
  "-d": "data",
  "--data": "data",
  "--data-raw": "data",
  "--data-binary": "data",
  "--data-ascii": "data",
  "--data-urlencode": "data-urlencode",
  "--url-query": "url-query",
  "--json": "json",
  "-F": "form",
  "--form": "form",
  "--form-string": "form-string",
  "-u": "user",
  "--user": "user",
  "--oauth2-bearer": "bearer",
  "-b": "header:Cookie",
  "--cookie": "header:Cookie",
  "-A": "header:User-Agent",
  "--user-agent": "header:User-Agent",
  "-e": "header:Referer",
  "--referer": "header:Referer",
  "-m": "max-time",
  "--max-time": "max-time",
  "--url": "url",
};

function splitPair(text: string, separator: string): { key: string; value: string } {
  const index = text.indexOf(separator);
  return index === -1
    ? { key: text, value: "" }
    : { key: text.slice(0, index), value: text.slice(index + 1) };
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

/** `name=content` encodes only the content. Bare `content` and `=content` have no name. */
function urlEncodeData(value: string): string {
  const field = splitPair(value, "=");
  return value.includes("=") && field.key !== ""
    ? `${field.key}=${encodeApiGatewayComponent(field.value)}`
    : encodeApiGatewayComponent(value.includes("=") ? field.value : value);
}

interface ParsedCurl {
  /** From `--url`, which says outright which word is the URL. */
  url: string | null;
  /** Words that belong to no option. One of them is the URL when `--url` was not given. */
  readonly bareWords: string[];
  method: ApiGatewayHttpMethod | null;
  /** `-G`: the data belongs in the query string rather than the body. */
  dataAsQuery: boolean;
  /** `--json`: the data is JSON whatever it looks like, and JSON is asked for back. */
  json: boolean;
  /** `-L`. curl shows a redirect as the response unless told to follow it. */
  followRedirects: boolean;
  timeoutMs: number;
  auth: ApiGatewayAuth;
  readonly headers: ApiGatewayKeyValue[];
  readonly data: string[];
  /** From `--url-query`: added to the query string whatever the method. */
  readonly query: string[];
  readonly form: ApiGatewayKeyValue[];
}

function takeValue(parsed: ParsedCurl, option: ValueOption, value: string): void {
  switch (option) {
    case "method": {
      const method = value.toUpperCase();
      if (isMethod(method)) parsed.method = method;
      return;
    }
    case "header": {
      // `Name;` sends the header empty. `Name:` with nothing after it removes a
      // header curl adds on its own, which has no counterpart here.
      const colon = value.indexOf(":");
      if (colon === -1) {
        if (value.endsWith(";")) {
          parsed.headers.push({ key: value.slice(0, -1).trim(), value: "", enabled: true });
        }
        return;
      }
      const content = value.slice(colon + 1).trim();
      if (content !== "") {
        parsed.headers.push({ key: value.slice(0, colon).trim(), value: content, enabled: true });
      }
      return;
    }
    case "json":
      parsed.json = true;
      parsed.data.push(value);
      return;
    case "data":
      parsed.data.push(value);
      return;
    case "data-urlencode":
      parsed.data.push(urlEncodeData(value));
      return;
    case "url-query":
      parsed.query.push(urlEncodeData(value));
      return;
    case "form": {
      // Content in quotes can hold `;`. Otherwise the first `;` starts settings
      // for the part, such as its type, and a part here is plain text.
      const field = splitPair(value, "=");
      const quoted = /^"((?:[^"\\]|\\.)*)"/s.exec(field.value)?.[1];
      parsed.form.push({
        key: field.key,
        value: quoted?.replace(/\\(.)/gs, "$1") ?? field.value.split(";", 1)[0]!,
        enabled: true,
      });
      return;
    }
    case "form-string": {
      const field = splitPair(value, "=");
      parsed.form.push({ key: field.key, value: field.value, enabled: true });
      return;
    }
    case "user": {
      const credentials = splitPair(value, ":");
      parsed.auth = {
        ...parsed.auth,
        type: "basic",
        basicUsername: credentials.key,
        basicPassword: credentials.value,
      };
      return;
    }
    case "bearer":
      parsed.auth = { ...parsed.auth, type: "bearer", bearerToken: value };
      return;
    case "max-time": {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        parsed.timeoutMs = Math.min(
          Math.max(Math.round(seconds * 1000), 1),
          API_GATEWAY_MAX_TIMEOUT_MS,
        );
      }
      return;
    }
    case "url":
      parsed.url ??= value;
      return;
    case "skip":
      return;
    default:
      // `-b` without `=` names a cookie file rather than giving cookies.
      if (option === "header:Cookie" && !value.includes("=")) return;
      parsed.headers.push({ key: option.slice("header:".length), value, enabled: true });
  }
}

function takeFlag(parsed: ParsedCurl, flag: string): void {
  if (flag === "-G" || flag === "--get") parsed.dataAsQuery = true;
  if (flag === "-I" || flag === "--head") parsed.method = "HEAD";
  if (flag === "-L" || flag === "--location") parsed.followRedirects = true;
}

function readWords(words: ReadonlyArray<string>): ParsedCurl {
  const parsed: ParsedCurl = {
    url: null,
    bareWords: [],
    method: null,
    dataAsQuery: false,
    json: false,
    followRedirects: false,
    timeoutMs: EMPTY_API_GATEWAY_REQUEST.timeoutMs,
    auth: EMPTY_API_GATEWAY_REQUEST.auth,
    headers: [],
    data: [],
    query: [],
    form: [],
  };
  let index = words[0] === "curl" ? 1 : 0;
  const nextWord = () => {
    const word = words[index] ?? "";
    index += 1;
    return word;
  };
  while (index < words.length) {
    const word = nextWord();
    if (!word.startsWith("-") || word === "-") {
      parsed.bareWords.push(word);
    } else if (word.startsWith("--")) {
      const inline = splitPair(word, "=");
      const option = VALUE_OPTIONS[inline.key];
      if (option === undefined) takeFlag(parsed, inline.key);
      else takeValue(parsed, option, word.includes("=") ? inline.value : nextWord());
    } else {
      // Short options can be bundled (`-sSL`) and can carry their value unspaced (`-XPOST`).
      for (let offset = 1; offset < word.length; offset += 1) {
        const name = `-${word[offset]}`;
        const option = VALUE_OPTIONS[name];
        if (option === undefined) {
          takeFlag(parsed, name);
          continue;
        }
        const attached = word.slice(offset + 1);
        takeValue(parsed, option, attached === "" ? nextWord() : attached);
        break;
      }
    }
  }
  return parsed;
}

/** The body the data makes, and the content type curl would send it with when none was given. */
function readBody(parsed: ParsedCurl): { body: ApiGatewayBody; contentType: string | null } {
  const body = EMPTY_API_GATEWAY_REQUEST.body;
  if (parsed.dataAsQuery) return { body, contentType: null };
  if (parsed.form.length > 0) {
    return { body: { ...body, mode: "multipart", form: parsed.form }, contentType: null };
  }
  if (parsed.data.length === 0) return { body, contentType: null };

  // `--json` may be repeated; curl sends the pieces one after another.
  if (parsed.json) {
    return {
      body: { ...body, mode: "raw", rawLanguage: "json", raw: parsed.data.join("") },
      contentType: null,
    };
  }

  const text = parsed.data.join("&");
  const contentType =
    parsed.headers
      .find((header) => header.key.toLowerCase() === "content-type")
      ?.value.toLowerCase() ?? "";
  // curl sends `-d` as a form unless a header says otherwise. Text that is
  // plainly JSON is read as JSON anyway: that is what such a command means.
  const looksLikeJson = /^\s*[[{]/.test(text);
  if (contentType.includes("x-www-form-urlencoded") || (contentType === "" && !looksLikeJson)) {
    const form = text
      .split("&")
      .filter((part) => part !== "")
      .map((part) => {
        const field = splitPair(part, "=");
        return {
          key: decodeFormComponent(field.key),
          value: decodeFormComponent(field.value),
          enabled: true,
        };
      });
    // Rows only when they would be sent as this same text. Anything else, such
    // as a line of plain text, is kept word for word.
    if (new URLSearchParams(form.map((field) => [field.key, field.value])).toString() === text) {
      return { body: { ...body, mode: "urlencoded", form }, contentType: null };
    }
    return {
      body: { ...body, mode: "raw", rawLanguage: "text", raw: text },
      contentType: contentType === "" ? "application/x-www-form-urlencoded" : null,
    };
  }
  return {
    body: {
      ...body,
      mode: "raw",
      raw: text,
      rawLanguage:
        contentType.includes("json") || contentType === ""
          ? "json"
          : contentType.includes("xml")
            ? "xml"
            : contentType.includes("html")
              ? "html"
              : "text",
    },
    contentType: null,
  };
}

/**
 * Reads a `curl` command, as copied from documentation or a browser's network
 * panel, into a request. Returns null when the text has no URL in it.
 *
 * Only POSIX shell quoting is understood, not the `^` escapes of a command
 * copied for Windows cmd. Options with no counterpart here (proxies,
 * certificates, output files) are dropped, and a `@file` argument stays the
 * text it is: the file is on whatever machine the command came from.
 */
export function parseCurlCommand(command: string): ApiGatewayRequest | null {
  const parsed = readWords(shellWords(command.trim()));
  const target =
    parsed.url ??
    parsed.bareWords.find((word) => API_GATEWAY_URL_SCHEME.test(word)) ??
    parsed.bareWords[0];
  if (target === undefined) return null;

  const { body, contentType } = readBody(parsed);
  const query = [...(parsed.dataAsQuery ? parsed.data : []), ...parsed.query];
  const hashAt = target.indexOf("#");
  const beforeHash = hashAt === -1 ? target : target.slice(0, hashAt);
  const url = (
    query.length === 0
      ? target
      : `${beforeHash}${beforeHash.includes("?") ? "&" : "?"}${query.join("&")}${target.slice(beforeHash.length)}`
  )
    // A quoted word can hold line breaks. A URL cannot, and neither can the field it is shown in.
    .replace(/[\t\n\r]/g, "");
  const headers = [...parsed.headers];
  if (contentType !== null)
    headers.push({ key: "Content-Type", value: contentType, enabled: true });
  if (parsed.json && !headers.some((header) => header.key.toLowerCase() === "accept")) {
    headers.push({ key: "Accept", value: "application/json", enabled: true });
  }
  return withApiGatewayUrl(
    {
      ...EMPTY_API_GATEWAY_REQUEST,
      method: parsed.method ?? (body.mode === "none" ? "GET" : "POST"),
      headers,
      auth: parsed.auth,
      body,
      followRedirects: parsed.followRedirects,
      timeoutMs: parsed.timeoutMs,
    },
    url,
  );
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A `curl` command that sends the same request, quoted for a POSIX shell.
 * Values are final, so secrets are included.
 */
export function toCurlCommand(input: ApiGatewayExecuteInput): string {
  const parts = [`curl ${shellQuote(input.url)}`];
  // curl reads brackets and braces in a URL as ranges and lists to expand.
  if (/[[\]{}]/.test(input.url)) parts.push("--globoff");
  if (input.method === "HEAD") parts.push("--head");
  // Data makes curl send POST by itself. Saying so would also keep it POST
  // after a redirect that turns it into GET, as the request here does.
  else if (input.method !== "GET" && !(input.method === "POST" && input.body !== undefined)) {
    parts.push(`--request ${input.method}`);
  }
  if (input.followRedirects) parts.push("--location");
  if (input.timeoutMs !== API_GATEWAY_DEFAULT_TIMEOUT_MS) {
    parts.push(`--max-time ${input.timeoutMs / 1000}`);
  }
  for (const header of input.headers) {
    // `Name:` with nothing after it would tell curl to leave the header out.
    const line = header.value === "" ? `${header.name};` : `${header.name}: ${header.value}`;
    parts.push(`--header ${shellQuote(line)}`);
  }
  if (input.body !== undefined) parts.push(`--data-raw ${shellQuote(input.body)}`);
  return parts.join(" \\\n  ");
}
