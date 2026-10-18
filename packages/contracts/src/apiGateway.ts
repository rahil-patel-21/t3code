import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * API Gateway: an HTTP client that runs on the environment.
 *
 * The server sends each request, so a request reaches whatever the
 * environment's machine can reach (its localhost, its VPN) and is never subject
 * to a browser's CORS rules. Collections and variable sets are stored by the
 * server and shared by every client of that environment. Open tabs, unsaved
 * edits, and history stay with the client that made them.
 *
 * The workspace is persisted as written, so a field added to anything it holds
 * must be optional: a required one would make every existing file undecodable.
 */

/** Collections, folders, and requests one environment keeps, in total. */
export const API_GATEWAY_MAX_ITEMS = 2_000;
/** How deep folders nest, the collection being the first level. */
export const API_GATEWAY_MAX_FOLDER_DEPTH = 10;
export const API_GATEWAY_MAX_VARIABLE_SETS = 100;
export const API_GATEWAY_MAX_NAME_LENGTH = 200;
/** Response bytes read per request. A longer body is cut here and says so. */
export const API_GATEWAY_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const API_GATEWAY_DEFAULT_TIMEOUT_MS = 30_000;
/**
 * As long as the server's HTTP client waits for headers, so a longer limit
 * could not be kept. Opening the connection has a limit of its own, 10
 * seconds, which a longer timeout does not extend.
 */
export const API_GATEWAY_MAX_TIMEOUT_MS = 5 * 60_000;

const text = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const ShortText = text(2_000);
const LongText = text(200_000);
const ApiGatewayName = TrimmedNonEmptyString.check(Schema.isMaxLength(API_GATEWAY_MAX_NAME_LENGTH));
/** Ids are made by clients, so their size is bounded like everything else they send. */
const ApiGatewayId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));

export const ApiGatewayHttpMethod = Schema.Literals([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type ApiGatewayHttpMethod = typeof ApiGatewayHttpMethod.Type;

/**
 * False for GET and HEAD. The server's HTTP client refuses a body on either,
 * so a request keeps its body in the editor and goes out without it.
 */
export const apiGatewayMethodSendsBody = (method: ApiGatewayHttpMethod): boolean =>
  method !== "GET" && method !== "HEAD";

/** One editable row. Query parameters, headers, form fields, and variables all use it. */
export const ApiGatewayKeyValue = Schema.Struct({
  key: ShortText,
  value: LongText,
  /** A row switched off stays in the list but is left out of the request. */
  enabled: Schema.Boolean,
});
export type ApiGatewayKeyValue = typeof ApiGatewayKeyValue.Type;

const ApiGatewayRows = Schema.Array(ApiGatewayKeyValue).check(Schema.isMaxLength(500));

export const ApiGatewayAuthType = Schema.Literals(["none", "bearer", "basic", "apiKey"]);
export type ApiGatewayAuthType = typeof ApiGatewayAuthType.Type;

/**
 * Every auth form keeps its own fields, so switching the type and back loses
 * nothing. Only the form named by `type` is applied to the request.
 */
export const ApiGatewayAuth = Schema.Struct({
  type: ApiGatewayAuthType,
  bearerToken: LongText,
  basicUsername: ShortText,
  basicPassword: ShortText,
  apiKeyName: ShortText,
  apiKeyValue: LongText,
  apiKeyIn: Schema.Literals(["header", "query"]),
});
export type ApiGatewayAuth = typeof ApiGatewayAuth.Type;

export const ApiGatewayBodyMode = Schema.Literals(["none", "raw", "urlencoded", "multipart"]);
export type ApiGatewayBodyMode = typeof ApiGatewayBodyMode.Type;

export const ApiGatewayRawLanguage = Schema.Literals(["json", "text", "xml", "html"]);
export type ApiGatewayRawLanguage = typeof ApiGatewayRawLanguage.Type;

/** Like auth, each mode keeps its content while another mode is selected. */
export const ApiGatewayBody = Schema.Struct({
  mode: ApiGatewayBodyMode,
  rawLanguage: ApiGatewayRawLanguage,
  raw: text(2_000_000),
  /** Fields for both form modes. */
  form: ApiGatewayRows,
});
export type ApiGatewayBody = typeof ApiGatewayBody.Type;

const ApiGatewayTimeoutMs = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: API_GATEWAY_MAX_TIMEOUT_MS }),
);

/**
 * A request as the user wrote it. `{{name}}` placeholders are still in place;
 * the client fills them from the active variable set when sending.
 */
export const ApiGatewayRequest = Schema.Struct({
  method: ApiGatewayHttpMethod,
  /** Sent as written, query string included. */
  url: text(16_000),
  /** The URL's query string as rows, plus any rows switched off, which the URL omits. */
  query: ApiGatewayRows,
  headers: ApiGatewayRows,
  auth: ApiGatewayAuth,
  body: ApiGatewayBody,
  followRedirects: Schema.Boolean,
  timeoutMs: ApiGatewayTimeoutMs,
});
export type ApiGatewayRequest = typeof ApiGatewayRequest.Type;

export const ApiGatewayItemId = ApiGatewayId.pipe(Schema.brand("ApiGatewayItemId"));
export type ApiGatewayItemId = typeof ApiGatewayItemId.Type;

export const ApiGatewayFolder = Schema.Struct({
  kind: Schema.Literal("folder"),
  id: ApiGatewayItemId,
  /** Null for a collection, which is a folder at the top of the tree. */
  parentId: Schema.NullOr(ApiGatewayItemId),
  name: ApiGatewayName,
});
export type ApiGatewayFolder = typeof ApiGatewayFolder.Type;

export const ApiGatewaySavedRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  id: ApiGatewayItemId,
  parentId: ApiGatewayItemId,
  name: ApiGatewayName,
  request: ApiGatewayRequest,
});
export type ApiGatewaySavedRequest = typeof ApiGatewaySavedRequest.Type;

export const ApiGatewayItem = Schema.Union([ApiGatewayFolder, ApiGatewaySavedRequest]);
export type ApiGatewayItem = typeof ApiGatewayItem.Type;

export const ApiGatewayVariableSetId = ApiGatewayId.pipe(Schema.brand("ApiGatewayVariableSetId"));
export type ApiGatewayVariableSetId = typeof ApiGatewayVariableSetId.Type;

/** Named values for `{{name}}` placeholders, such as one set per deployment stage. */
export const ApiGatewayVariableSet = Schema.Struct({
  id: ApiGatewayVariableSetId,
  name: ApiGatewayName,
  variables: ApiGatewayRows,
});
export type ApiGatewayVariableSet = typeof ApiGatewayVariableSet.Type;

/**
 * Everything the environment stores. Sent whole: first on subscribe, then
 * again after every change. Siblings are shown in the order they appear in
 * `items`.
 */
export const ApiGatewayWorkspace = Schema.Struct({
  items: Schema.Array(ApiGatewayItem),
  variableSets: Schema.Array(ApiGatewayVariableSet),
});
export type ApiGatewayWorkspace = typeof ApiGatewayWorkspace.Type;

export const ApiGatewayOperation = Schema.Union([
  /**
   * Creates the item, or replaces the one with the same id. A new item, or one
   * given a different parent, goes last among its siblings.
   */
  Schema.Struct({ type: Schema.Literal("item.put"), item: ApiGatewayItem }),
  /** Removes the item and, for a folder, everything inside it. */
  Schema.Struct({ type: Schema.Literal("item.delete"), id: ApiGatewayItemId }),
  Schema.Struct({ type: Schema.Literal("variableSet.put"), variableSet: ApiGatewayVariableSet }),
  Schema.Struct({ type: Schema.Literal("variableSet.delete"), id: ApiGatewayVariableSetId }),
]);
export type ApiGatewayOperation = typeof ApiGatewayOperation.Type;

/**
 * Applied together: if one operation is rejected, none of them take effect.
 * A batch can be as long as the workspace can be large, which is what copying
 * a whole collection takes: one operation per item in it.
 */
export const ApiGatewayApplyInput = Schema.Struct({
  operations: Schema.Array(ApiGatewayOperation).check(Schema.isMaxLength(API_GATEWAY_MAX_ITEMS)),
});
export type ApiGatewayApplyInput = typeof ApiGatewayApplyInput.Type;

export class ApiGatewayWorkspaceError extends Schema.TaggedError<ApiGatewayWorkspaceError>()(
  "ApiGatewayWorkspaceError",
  {
    message: Schema.String,
  },
) {}

/**
 * One header of a request or a response. Not length-limited: a response's
 * headers are whatever the server sent, and a limit here would turn an
 * unusual response into a failed call.
 */
export const ApiGatewayHeader = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
});
export type ApiGatewayHeader = typeof ApiGatewayHeader.Type;

/**
 * A request ready for the wire: placeholders filled, auth and body already
 * folded in. The limits leave room above a stored request's for what that
 * adds: a scheme, an auth header, the values of variables.
 */
export const ApiGatewayExecuteInput = Schema.Struct({
  method: ApiGatewayHttpMethod,
  /** An absolute http or https URL. */
  url: text(64_000),
  headers: Schema.Array(Schema.Struct({ name: ShortText, value: LongText })).check(
    Schema.isMaxLength(510),
  ),
  body: Schema.optionalKey(text(10_000_000)),
  followRedirects: Schema.Boolean,
  timeoutMs: ApiGatewayTimeoutMs,
});
export type ApiGatewayExecuteInput = typeof ApiGatewayExecuteInput.Type;

/**
 * Why a body stopped short: it passed `API_GATEWAY_MAX_RESPONSE_BYTES`, the
 * timeout ran out while it was still arriving, or the connection failed.
 */
export const ApiGatewayBodyCutOff = Schema.Literals(["size", "timeout", "connection"]);
export type ApiGatewayBodyCutOff = typeof ApiGatewayBodyCutOff.Type;

export const ApiGatewayResponseBody = Schema.Struct({
  /** `utf8` when the bytes are text; anything else arrives as `base64`. */
  encoding: Schema.Literals(["utf8", "base64"]),
  data: Schema.String,
  /** Bytes read. */
  bytes: NonNegativeInt,
  /** Set when `data` holds only the start of the body. Null for a whole one. */
  cutOff: Schema.NullOr(ApiGatewayBodyCutOff),
});
export type ApiGatewayResponseBody = typeof ApiGatewayResponseBody.Type;

export const ApiGatewayExecuteResult = Schema.Struct({
  status: Schema.Int,
  /** Where the response came from. Differs from the request URL after a redirect. */
  url: Schema.String,
  headers: Schema.Array(ApiGatewayHeader),
  body: ApiGatewayResponseBody,
  /** Milliseconds from sending until the body was read, or stopped being read. */
  totalMs: NonNegativeInt,
});
export type ApiGatewayExecuteResult = typeof ApiGatewayExecuteResult.Type;

/**
 * The request never produced a response. An HTTP error status is a result,
 * not this, and so is a response whose body stopped short.
 */
export class ApiGatewayExecuteError extends Schema.TaggedError<ApiGatewayExecuteError>()(
  "ApiGatewayExecuteError",
  {
    reason: Schema.Literals(["invalid-request", "timeout", "network"]),
    message: Schema.String,
  },
) {}
