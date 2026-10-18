import {
  API_GATEWAY_MAX_FOLDER_DEPTH,
  API_GATEWAY_MAX_ITEMS,
  ApiGatewayItemId,
  ApiGatewayVariableSetId,
  type ApiGatewayItem,
  type ApiGatewayOperation,
  type ApiGatewayRequest,
  type ApiGatewayWorkspace,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { applyApiGatewayOperations } from "./workspaceOperations.ts";

const EMPTY: ApiGatewayWorkspace = { items: [], variableSets: [] };

const REQUEST: ApiGatewayRequest = {
  method: "GET",
  url: "https://example.com",
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
  timeoutMs: 30_000,
};

const folder = (id: string, parentId: string | null = null): ApiGatewayItem => ({
  kind: "folder",
  id: ApiGatewayItemId.make(id),
  parentId: parentId === null ? null : ApiGatewayItemId.make(parentId),
  name: id,
});

const request = (id: string, parentId: string): ApiGatewayItem => ({
  kind: "request",
  id: ApiGatewayItemId.make(id),
  parentId: ApiGatewayItemId.make(parentId),
  name: id,
  request: REQUEST,
});

const put = (item: ApiGatewayItem): ApiGatewayOperation => ({ type: "item.put", item });

function apply(workspace: ApiGatewayWorkspace, ...operations: ApiGatewayOperation[]) {
  return applyApiGatewayOperations(workspace, operations);
}

function applied(workspace: ApiGatewayWorkspace, ...operations: ApiGatewayOperation[]) {
  return Result.getOrThrow(apply(workspace, ...operations));
}

/** Why the operations were refused. Empty when they were not, so a wrong acceptance fails the match. */
function rejection(workspace: ApiGatewayWorkspace, ...operations: ApiGatewayOperation[]) {
  const result = apply(workspace, ...operations);
  return Result.isFailure(result) ? result.failure : "";
}

const ids = (workspace: ApiGatewayWorkspace) => workspace.items.map((item) => item.id);

describe("applyApiGatewayOperations", () => {
  it("builds a tree in one batch, each item seeing the ones put before it", () => {
    const workspace = applied(
      EMPTY,
      put(folder("api")),
      put(folder("users", "api")),
      put(request("list", "users")),
    );
    expect(ids(workspace)).toEqual(["api", "users", "list"]);
  });

  it("replaces an item in place, so editing a request does not reorder its siblings", () => {
    const start = applied(
      EMPTY,
      put(folder("api")),
      put(request("a", "api")),
      put(request("b", "api")),
    );
    const renamed = { ...request("a", "api"), name: "renamed" };
    const workspace = applied(start, put(renamed));
    expect(ids(workspace)).toEqual(["api", "a", "b"]);
    expect(workspace.items[1]?.name).toBe("renamed");
  });

  it("puts an item last among its new siblings when it changes folder", () => {
    const start = applied(
      EMPTY,
      put(folder("one")),
      put(folder("two")),
      put(request("a", "one")),
      put(request("b", "two")),
    );
    expect(ids(applied(start, put(request("a", "two"))))).toEqual(["one", "two", "b", "a"]);
  });

  it("deletes a folder together with everything inside it", () => {
    const start = applied(
      EMPTY,
      put(folder("api")),
      put(folder("users", "api")),
      put(request("list", "users")),
      put(folder("other")),
    );
    const workspace = applied(start, { type: "item.delete", id: ApiGatewayItemId.make("api") });
    expect(ids(workspace)).toEqual(["other"]);
  });

  it("deletes what is inside a folder even when it is stored ahead of the folder", () => {
    // Moving `api` puts it last, after the folder it holds.
    const start = applied(
      EMPTY,
      put(folder("api")),
      put(folder("users", "api")),
      put(folder("archive")),
      put(folder("api", "archive")),
    );
    expect(ids(start)).toEqual(["users", "archive", "api"]);

    const workspace = applied(start, { type: "item.delete", id: ApiGatewayItemId.make("archive") });
    expect(ids(workspace)).toEqual([]);
  });

  it("rejects an item whose folder is missing or is a request", () => {
    expect(rejection(EMPTY, put(request("a", "gone")))).toContain("no longer exists");
    const start = applied(EMPTY, put(folder("api")), put(request("a", "api")));
    expect(rejection(start, put(request("b", "a")))).toContain("no longer exists");
  });

  it("rejects moving a folder inside itself, which would detach its subtree", () => {
    const start = applied(EMPTY, put(folder("api")), put(folder("users", "api")));
    expect(rejection(start, put(folder("api", "users")))).toContain("into itself");
    expect(rejection(start, put(folder("api", "api")))).toContain("into itself");
  });

  it("lets a folder move somewhere that is not inside it", () => {
    const start = applied(EMPTY, put(folder("api")), put(folder("users", "api")), put(folder("b")));
    expect(ids(applied(start, put(folder("users", "b"))))).toEqual(["api", "b", "users"]);
  });

  it("stops folders nesting past the limit, counting the folders a moved one brings along", () => {
    const chain = Array.from({ length: API_GATEWAY_MAX_FOLDER_DEPTH }, (_, index) =>
      put(folder(`f${index}`, index === 0 ? null : `f${index - 1}`)),
    );
    const deepest = `f${API_GATEWAY_MAX_FOLDER_DEPTH - 1}`;
    const start = applied(EMPTY, ...chain, put(folder("pair")), put(folder("inner", "pair")));

    expect(rejection(start, put(folder("one-more", deepest)))).toContain("nest at most");
    // A request is not a level of its own.
    expect(Result.isSuccess(apply(start, put(request("leaf", deepest))))).toBe(true);
    // `pair` alone would fit one level above the deepest, but it holds `inner`.
    expect(rejection(start, put(folder("pair", `f${API_GATEWAY_MAX_FOLDER_DEPTH - 2}`)))).toContain(
      "nest at most",
    );
    expect(Result.isSuccess(apply(start, put(folder("inner", deepest))))).toBe(false);
    expect(
      Result.isSuccess(apply(start, put(folder("pair", `f${API_GATEWAY_MAX_FOLDER_DEPTH - 3}`)))),
    ).toBe(true);
  });

  it("rejects turning a folder into a request under the same id", () => {
    const start = applied(EMPTY, put(folder("api")), put(folder("users", "api")));
    expect(rejection(start, put(request("users", "api")))).toContain("cannot become a request");
  });

  it("stops adding items at the limit but still lets existing ones change", () => {
    const full: ApiGatewayWorkspace = {
      items: Array.from({ length: API_GATEWAY_MAX_ITEMS }, (_, index) => folder(`f${index}`)),
      variableSets: [],
    };
    expect(rejection(full, put(folder("one-more")))).toContain("at most");
    expect(Result.isSuccess(apply(full, put({ ...folder("f0"), name: "renamed" })))).toBe(true);
  });

  it("creates, replaces, and removes variable sets by id", () => {
    const id = ApiGatewayVariableSetId.make("staging");
    const created = applied(EMPTY, {
      type: "variableSet.put",
      variableSet: { id, name: "Staging", variables: [] },
    });
    const replaced = applied(created, {
      type: "variableSet.put",
      variableSet: {
        id,
        name: "Staging",
        variables: [{ key: "host", value: "staging.example.com", enabled: true }],
      },
    });
    expect(replaced.variableSets).toHaveLength(1);
    expect(replaced.variableSets[0]?.variables[0]?.value).toBe("staging.example.com");
    expect(applied(replaced, { type: "variableSet.delete", id }).variableSets).toEqual([]);
  });
});
