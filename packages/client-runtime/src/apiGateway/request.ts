import {
  API_GATEWAY_DEFAULT_TIMEOUT_MS,
  apiGatewayMethodSendsBody,
  type ApiGatewayExecuteInput,
  type ApiGatewayHeader,
  type ApiGatewayKeyValue,
  type ApiGatewayRawLanguage,
  type ApiGatewayRequest,
} from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";

/** What a new request starts from. */
export const EMPTY_API_GATEWAY_REQUEST: ApiGatewayRequest = {
  method: "GET",
  url: "",
  query: [],
  headers: [],
  auth: {
    type: "none",
    bearerToken: "",
    basicUsername: "",
    basicPassword: "",
    apiKeyName: "",
    apiKeyValue: "",
    apiKeyIn: "header",
  },
  body: { mode: "none", rawLanguage: "json", raw: "", form: [] },
  followRedirects: true,
  timeoutMs: API_GATEWAY_DEFAULT_TIMEOUT_MS,
};

const RAW_CONTENT_TYPES: Record<ApiGatewayRawLanguage, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
};

/** A URL that names its scheme, as `https://` or `{{base}}` would not. */
export const API_GATEWAY_URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/** Every `{{name}}` in a text, for `replace`. The first group is the name, spaces included. */
export const API_GATEWAY_PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/** A row that takes part in the request: switched on and named. */
export const isApiGatewayRowSent = (row: ApiGatewayKeyValue) =>
  row.enabled && row.key.trim() !== "";

/** 24 random hex digits. */
const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * `encodeURIComponent`, which throws on half of a surrogate pair, such as a
 * pasted emoji cut in two. Such text is sent with U+FFFD in its place, as a
 * form sends it.
 */
export function encodeApiGatewayComponent(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    return encodeURIComponent(text.replace(/[\ud800-\udfff]/g, "�"));
  }
}

/**
 * A field name as browsers write it into a part's header. The quote would end
 * the name, and a line break would start a header of the field's own making.
 */
const escapeMultipartName = (name: string) =>
  name.replaceAll('"', "%22").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

function splitUrl(url: string): { base: string; query: string; hash: string } {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  return queryIndex === -1
    ? { base: beforeHash, query: "", hash }
    : { base: beforeHash.slice(0, queryIndex), query: beforeHash.slice(queryIndex + 1), hash };
}

const isBlank = (row: ApiGatewayKeyValue) => row.key === "" && row.value === "";

/** The rows the URL's query string stands for. Blank and switched-off rows are in neither. */
const inUrl = (row: ApiGatewayKeyValue) => row.enabled && !isBlank(row);

// A row holds the characters it means. Only the ones that would be read as
// query structure are escaped on the way into the URL, so `a&b` typed as a
// value stays one value; everything else, placeholders included, is untouched.
const escapeQueryPart = (text: string, structural: RegExp) =>
  text.replace(structural, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const unescapeQueryPart = (text: string) =>
  text.replace(/%(26|23|3D)/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** A query string's parameters, each as written and as the row it reads as. `&&` and `&=` hold none. */
function queryParameters(query: string) {
  return query.split("&").flatMap((text) => {
    const equals = text.indexOf("=");
    const row: ApiGatewayKeyValue = {
      key: unescapeQueryPart(equals === -1 ? text : text.slice(0, equals)),
      value: equals === -1 ? "" : unescapeQueryPart(text.slice(equals + 1)),
      enabled: true,
    };
    return isBlank(row) ? [] : [{ text, row }];
  });
}

/**
 * The request with `url` exactly as typed and its query rows brought in step.
 *
 * Rows the URL cannot show (switched off, or still blank) keep their place
 * among the rows read back from it.
 */
export function withApiGatewayUrl(request: ApiGatewayRequest, url: string): ApiGatewayRequest {
  const parsed = queryParameters(splitUrl(url).query).map(({ row }) => row);
  const query: ApiGatewayKeyValue[] = [];
  let next = 0;
  for (const row of request.query) {
    if (!inUrl(row)) {
      query.push(row);
    } else if (next < parsed.length) {
      query.push(parsed[next]!);
      next += 1;
    }
  }
  query.push(...parsed.slice(next));
  return { ...request, url, query };
}

/**
 * The request with `query` as its rows and the URL's query string rewritten to
 * match. A parameter whose row did not change keeps the text it was written
 * with, so editing one row does not re-escape the others, such as a signature.
 */
export function withApiGatewayQuery(
  request: ApiGatewayRequest,
  query: ReadonlyArray<ApiGatewayKeyValue>,
): ApiGatewayRequest {
  const { base, query: current, hash } = splitUrl(request.url);
  const written = new Map<string, string[]>();
  for (const { text, row } of queryParameters(current)) {
    const key = JSON.stringify([row.key, row.value]);
    const texts = written.get(key);
    if (texts) texts.push(text);
    else written.set(key, [text]);
  }
  const text = query
    .filter(inUrl)
    .map((row) => {
      const unchanged = written.get(JSON.stringify([row.key, row.value]))?.shift();
      if (unchanged !== undefined) return unchanged;
      const key = escapeQueryPart(row.key, /[&#=]/g);
      return row.value === "" ? key : `${key}=${escapeQueryPart(row.value, /[&#]/g)}`;
    })
    .join("&");
  return { ...request, url: `${base}${text === "" ? "" : `?${text}`}${hash}`, query };
}

/** Values by name from a variable set's rows. A later row wins over an earlier one. */
export function apiGatewayVariables(
  rows: ReadonlyArray<ApiGatewayKeyValue>,
): ReadonlyMap<string, string> {
  return new Map(rows.filter(isApiGatewayRowSent).map((row) => [row.key.trim(), row.value]));
}

export interface PreparedApiGatewayRequest {
  readonly input: ApiGatewayExecuteInput;
  /** Placeholders no variable filled. They are sent as written. */
  readonly unresolved: ReadonlyArray<string>;
}

/**
 * Turns a request as written into what goes on the wire: placeholders filled,
 * auth and body folded into the URL, headers, and body text.
 *
 * A header the user wrote wins over one derived from the auth or body
 * settings, so an explicit `Authorization` or `Content-Type` row is final.
 * The one exception is a multipart body, whose `Content-Type` has to name the
 * boundary the body was written with.
 */
export function prepareApiGatewayRequest(
  request: ApiGatewayRequest,
  variables: ReadonlyMap<string, string>,
): PreparedApiGatewayRequest {
  const unresolved = new Set<string>();
  // Characters placeholders may add in all. Past it they stay as written, so
  // a value used thousands of times, or doubling at every level, cannot grow
  // the request past what memory holds.
  let budget = 10_000_000;
  const fill = (text: string, depth = 0): string =>
    text.replace(API_GATEWAY_PLACEHOLDER, (placeholder, raw: string) => {
      const name = raw.trim();
      const value = variables.get(name);
      if (value === undefined) {
        if (name !== "") unresolved.add(name);
        return placeholder;
      }
      if (value.length > budget) return placeholder;
      budget -= value.length;
      // A value can be written with other variables, as `{{host}}/v2` for a base
      // URL. The depth ends one that, directly or not, names itself.
      return depth < 10 ? fill(value, depth + 1) : value;
    });
  const filledRows = (rows: ReadonlyArray<ApiGatewayKeyValue>) =>
    rows
      .filter(isApiGatewayRowSent)
      .map((row) => ({ key: fill(row.key).trim(), value: fill(row.value) }));

  let url = fill(request.url).trim();
  // `localhost:3000/health` is the common way to write a local URL.
  if (url !== "" && !API_GATEWAY_URL_SCHEME.test(url)) url = `http://${url}`;

  let headers: ApiGatewayHeader[] = filledRows(request.headers).map(({ key, value }) => ({
    name: key,
    value,
  }));
  const addDerivedHeader = (name: string, value: string) => {
    if (!headers.some((header) => header.name.toLowerCase() === name.toLowerCase())) {
      headers.push({ name, value });
    }
  };

  const { auth } = request;
  if (auth.type === "bearer") {
    const token = fill(auth.bearerToken).trim();
    if (token !== "") addDerivedHeader("Authorization", `Bearer ${token}`);
  } else if (auth.type === "basic") {
    const credentials = `${fill(auth.basicUsername)}:${fill(auth.basicPassword)}`;
    addDerivedHeader("Authorization", `Basic ${Base64.encode(credentials)}`);
  } else if (auth.type === "apiKey") {
    const name = fill(auth.apiKeyName).trim();
    const value = fill(auth.apiKeyValue);
    if (name !== "" && auth.apiKeyIn === "header") {
      addDerivedHeader(name, value);
    } else if (name !== "") {
      const { base, query, hash } = splitUrl(url);
      const pair = `${encodeApiGatewayComponent(name)}=${encodeApiGatewayComponent(value)}`;
      url = `${base}?${query === "" ? pair : `${query}&${pair}`}${hash}`;
    }
  }

  let body: string | undefined;
  // For a method without one, the body stays in the editor for a method that has it.
  if (apiGatewayMethodSendsBody(request.method)) {
    if (request.body.mode === "raw") {
      body = fill(request.body.raw);
      addDerivedHeader("Content-Type", RAW_CONTENT_TYPES[request.body.rawLanguage]);
    } else if (request.body.mode === "urlencoded") {
      const fields = filledRows(request.body.form);
      body = new URLSearchParams(fields.map(({ key, value }) => [key, value])).toString();
      addDerivedHeader("Content-Type", "application/x-www-form-urlencoded");
    } else if (request.body.mode === "multipart") {
      const fields = filledRows(request.body.form);
      // Random, as browsers make it, so that no field can hold it and end a part early.
      const boundary = `----T3CodeFormBoundary${randomToken()}`;
      body = `${fields
        .map(
          ({ key, value }) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartName(key)}"\r\n\r\n${value}\r\n`,
        )
        .join("")}--${boundary}--\r\n`;
      // Only this header names the boundary used above, so it replaces any written by hand.
      headers = [
        ...headers.filter((header) => header.name.toLowerCase() !== "content-type"),
        { name: "Content-Type", value: `multipart/form-data; boundary=${boundary}` },
      ];
    }
  }

  return {
    input: {
      method: request.method,
      url,
      headers,
      ...(body === undefined ? {} : { body }),
      followRedirects: request.followRedirects,
      timeoutMs: request.timeoutMs,
    },
    unresolved: [...unresolved],
  };
}
