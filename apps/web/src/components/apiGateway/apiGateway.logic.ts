import { API_GATEWAY_URL_SCHEME } from "@t3tools/client-runtime/api-gateway";
import {
  API_GATEWAY_MAX_NAME_LENGTH,
  type ApiGatewayExecuteResult,
  type ApiGatewayHttpMethod,
  type ApiGatewayItem,
  type ApiGatewayItemId,
  type ApiGatewayOperation,
  type ApiGatewayRequest,
} from "@t3tools/contracts";

export interface ApiGatewayTreeRow {
  readonly item: ApiGatewayItem;
  readonly depth: number;
}

function childrenByParent(items: ReadonlyArray<ApiGatewayItem>) {
  const children = new Map<ApiGatewayItemId | null, ApiGatewayItem[]>();
  for (const item of items) {
    const siblings = children.get(item.parentId);
    if (siblings) siblings.push(item);
    else children.set(item.parentId, [item]);
  }
  return children;
}

/**
 * The tree as the rows to draw, top to bottom: each collection followed by
 * its contents in stored order. A collapsed folder hides what is inside it.
 * An item whose folder no longer exists is left out.
 */
export function apiGatewayTreeRows(
  items: ReadonlyArray<ApiGatewayItem>,
  collapsed: ReadonlySet<ApiGatewayItemId> = new Set(),
): ReadonlyArray<ApiGatewayTreeRow> {
  const children = childrenByParent(items);
  const rows: ApiGatewayTreeRow[] = [];
  const visit = (parentId: ApiGatewayItemId | null, depth: number) => {
    for (const item of children.get(parentId) ?? []) {
      rows.push({ item, depth });
      if (item.kind === "folder" && !collapsed.has(item.id)) visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

export interface ApiGatewayFolderOption {
  readonly id: ApiGatewayItemId;
  /** The folder's path from its collection, such as `Billing / Invoices`. */
  readonly label: string;
}

/**
 * Every folder an item could be placed in. `moving` leaves out that folder and
 * everything under it, which a folder cannot be moved into.
 */
export function apiGatewayFolderOptions(
  items: ReadonlyArray<ApiGatewayItem>,
  moving?: ApiGatewayItemId,
): ReadonlyArray<ApiGatewayFolderOption> {
  const options: ApiGatewayFolderOption[] = [];
  const path: string[] = [];
  let skipBelowDepth: number | null = null;
  for (const { item, depth } of apiGatewayTreeRows(items)) {
    if (skipBelowDepth !== null && depth > skipBelowDepth) continue;
    skipBelowDepth = null;
    if (item.kind !== "folder") continue;
    if (item.id === moving) {
      skipBelowDepth = depth;
      continue;
    }
    path.length = depth;
    path.push(item.name);
    options.push({ id: item.id, label: path.join(" / ") });
  }
  return options;
}

/**
 * Operations that copy an item into the folder it is in, where the copy goes
 * last. A folder is copied with everything in it, each copy under a fresh id.
 */
export function duplicateApiGatewayItem(
  items: ReadonlyArray<ApiGatewayItem>,
  itemId: ApiGatewayItemId,
  newId: () => ApiGatewayItemId,
): ReadonlyArray<ApiGatewayOperation> {
  const source = items.find((item) => item.id === itemId);
  if (source === undefined) return [];
  const children = childrenByParent(items);
  const operations: ApiGatewayOperation[] = [];
  const copy = (item: ApiGatewayItem, parentId: ApiGatewayItemId | null) => {
    const id = newId();
    const name =
      item === source ? `${item.name} copy`.slice(0, API_GATEWAY_MAX_NAME_LENGTH) : item.name;
    operations.push({
      type: "item.put",
      item:
        item.kind === "folder"
          ? { ...item, id, parentId, name }
          : { ...item, id, parentId: parentId ?? item.parentId, name },
    });
    for (const child of children.get(item.id) ?? []) copy(child, id);
  };
  copy(source, source.parentId);
  return operations;
}

/**
 * `api.example.com/users`: what a request is called before it is given a name.
 * Never longer than a name may be, so it can be offered as one.
 */
export function apiGatewayRequestLabel(request: ApiGatewayRequest): string {
  const target = request.url
    .trim()
    .replace(API_GATEWAY_URL_SCHEME, "")
    // `user:password@`, which a label shown in tabs and offered as a name must not carry.
    .replace(/^[^/?#]*@/, "");
  const end = target.search(/[?#]/);
  const label = (end === -1 ? target : target.slice(0, end))
    .slice(0, API_GATEWAY_MAX_NAME_LENGTH)
    .trim();
  return label === "" ? "Untitled request" : label;
}

export type ApiGatewayTone = "success" | "info" | "warning" | "error" | "muted";

export function apiGatewayMethodTone(method: ApiGatewayHttpMethod): ApiGatewayTone {
  switch (method) {
    case "GET":
      return "success";
    case "POST":
      return "warning";
    case "PUT":
    case "PATCH":
      return "info";
    case "DELETE":
      return "error";
    case "HEAD":
    case "OPTIONS":
      return "muted";
  }
}

export function apiGatewayStatusTone(status: number): ApiGatewayTone {
  if (status >= 500) return "error";
  if (status >= 400) return "warning";
  if (status >= 300) return "info";
  if (status >= 200) return "success";
  return "muted";
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  418: "I'm a teapot",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** `404 Not Found`. The reason phrase is ours: HTTP/2 responses do not carry one. */
export function apiGatewayStatusLabel(status: number): string {
  const text = STATUS_TEXT[status];
  return text === undefined ? String(status) : `${status} ${text}`;
}

/** The most text the response viewer draws. A longer body is cut on screen only. */
export const API_GATEWAY_RESPONSE_DISPLAY_MAX_CHARS = 1_000_000;

/**
 * One JSON token: a `{{placeholder}}` (never valid JSON, so never mistaken for
 * it), a string, a structural character, or a number or literal.
 */
const JSON_TOKEN = /\{\{[^{}]+\}\}|"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g;

/**
 * JSON laid out two spaces to a level, as `JSON.stringify` lays it out, with
 * every token left as written. Parsing and printing it again would round a
 * number too long for a double, such as a 64-bit id, and drop repeated keys.
 * `{{placeholders}}` stay in place. Null when the layout would make the text
 * more than twice as long plus the display limit: deep nesting can make it a
 * hundred times longer.
 */
export function apiGatewayFormatJson(text: string): string | null {
  const limit = 2 * text.length + API_GATEWAY_RESPONSE_DISPLAY_MAX_CHARS;
  let formatted = "";
  let depth = 0;
  let previous = "";
  const newLine = () => `\n${"  ".repeat(depth)}`;
  for (const [token] of text.matchAll(JSON_TOKEN)) {
    if (token === "}" || token === "]") {
      depth -= 1;
      // An empty object or array stays on one line.
      formatted += previous === "{" || previous === "[" ? token : `${newLine()}${token}`;
    } else {
      if (previous === "{" || previous === "[" || previous === ",") formatted += newLine();
      formatted += token === ":" ? ": " : token;
      if (token === "{" || token === "[") depth += 1;
    }
    previous = token;
    if (formatted.length > limit) return null;
  }
  return formatted;
}

/** Whether the text parses as JSON. */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export type ApiGatewayResponseContent =
  | { readonly kind: "empty" }
  | {
      readonly kind: "text";
      /** Named for its type, so the viewer highlights it as that language. */
      readonly fileName: string;
      readonly text: string;
      /** The body re-indented, when it is JSON that parses. */
      readonly pretty: string | null;
    }
  | { readonly kind: "image"; readonly src: string }
  | { readonly kind: "binary" };

const TEXT_EXTENSIONS: ReadonlyArray<readonly [needle: string, extension: string]> = [
  ["json", "json"],
  ["html", "html"],
  ["xml", "xml"],
  ["javascript", "js"],
  ["css", "css"],
  ["yaml", "yaml"],
  ["markdown", "md"],
];

/** How to show a response body, decided by its content type and whether it is text. */
export function apiGatewayResponseContent(
  result: ApiGatewayExecuteResult,
): ApiGatewayResponseContent {
  const { body } = result;
  if (body.bytes === 0) return { kind: "empty" };
  const contentType = (
    result.headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? ""
  )
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (body.encoding === "base64") {
    // A cut-off image does not decode, so only a whole one is worth drawing.
    return contentType.startsWith("image/") && body.cutOff === null
      ? { kind: "image", src: `data:${contentType};base64,${body.data}` }
      : { kind: "binary" };
  }

  const looksLikeJson = contentType.includes("json") || /^\s*[[{]/.test(body.data);
  // Past the display limit the viewer shows only the start, which needs no layout.
  const pretty =
    looksLikeJson && body.data.length <= API_GATEWAY_RESPONSE_DISPLAY_MAX_CHARS && isJson(body.data)
      ? apiGatewayFormatJson(body.data)
      : null;
  const extension =
    pretty !== null
      ? "json"
      : (TEXT_EXTENSIONS.find(([needle]) => contentType.includes(needle))?.[1] ?? "txt");
  return { kind: "text", fileName: `response.${extension}`, text: body.data, pretty };
}
