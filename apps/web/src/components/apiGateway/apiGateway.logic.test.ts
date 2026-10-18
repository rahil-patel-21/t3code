import { EMPTY_API_GATEWAY_REQUEST } from "@t3tools/client-runtime/api-gateway";
import {
  API_GATEWAY_MAX_NAME_LENGTH,
  ApiGatewayItemId,
  type ApiGatewayExecuteResult,
  type ApiGatewayItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  apiGatewayFolderOptions,
  apiGatewayFormatJson,
  apiGatewayRequestLabel,
  apiGatewayResponseContent,
  apiGatewayStatusLabel,
  apiGatewayTreeRows,
  duplicateApiGatewayItem,
} from "./apiGateway.logic";

const id = ApiGatewayItemId.make;

const folder = (name: string, parent: string | null = null): ApiGatewayItem => ({
  kind: "folder",
  id: id(name),
  parentId: parent === null ? null : id(parent),
  name,
});

const request = (name: string, parent: string): ApiGatewayItem => ({
  kind: "request",
  id: id(name),
  parentId: id(parent),
  name,
  request: EMPTY_API_GATEWAY_REQUEST,
});

// Deliberately out of tree order: a child can be stored before its parent.
const ITEMS: ReadonlyArray<ApiGatewayItem> = [
  request("list", "users"),
  folder("api"),
  folder("users", "api"),
  request("health", "api"),
  folder("billing"),
  request("orphan", "deleted-folder"),
];

const response = (
  body: Partial<ApiGatewayExecuteResult["body"]> & { readonly data: string },
  contentType?: string,
): ApiGatewayExecuteResult => ({
  status: 200,
  url: "https://api.test",
  headers: contentType === undefined ? [] : [{ name: "Content-Type", value: contentType }],
  body: { encoding: "utf8", bytes: body.data.length, cutOff: null, ...body },
  totalMs: 2,
});

describe("apiGatewayTreeRows", () => {
  it("lists each collection with its contents beneath it, however the items are stored", () => {
    expect(apiGatewayTreeRows(ITEMS).map((row) => [row.item.name, row.depth])).toEqual([
      ["api", 0],
      ["users", 1],
      ["list", 2],
      ["health", 1],
      ["billing", 0],
    ]);
  });

  it("hides what is inside a collapsed folder but keeps the folder", () => {
    expect(apiGatewayTreeRows(ITEMS, new Set([id("api")])).map((row) => row.item.name)).toEqual([
      "api",
      "billing",
    ]);
  });
});

describe("apiGatewayFolderOptions", () => {
  it("names every folder by its path from the collection", () => {
    expect(apiGatewayFolderOptions(ITEMS).map((option) => option.label)).toEqual([
      "api",
      "api / users",
      "billing",
    ]);
  });

  it("leaves out the folder being moved and everything under it", () => {
    expect(apiGatewayFolderOptions(ITEMS, id("api")).map((option) => option.label)).toEqual([
      "billing",
    ]);
  });
});

describe("duplicateApiGatewayItem", () => {
  it("copies a folder with its whole subtree under new ids, into the folder it is in", () => {
    let next = 0;
    const operations = duplicateApiGatewayItem(ITEMS, id("api"), () => id(`copy-${(next += 1)}`));

    expect(
      operations.map((operation) =>
        operation.type === "item.put"
          ? [operation.item.id, operation.item.parentId, operation.item.name]
          : null,
      ),
    ).toEqual([
      ["copy-1", null, "api copy"],
      ["copy-2", "copy-1", "users"],
      ["copy-3", "copy-2", "list"],
      ["copy-4", "copy-1", "health"],
    ]);
  });

  it("copies a request into the same folder", () => {
    const [operation] = duplicateApiGatewayItem(ITEMS, id("health"), () => id("copy"));

    expect(operation).toMatchObject({
      type: "item.put",
      item: { kind: "request", id: "copy", parentId: "api", name: "health copy" },
    });
  });
});

describe("apiGatewayResponseContent", () => {
  it("re-indents JSON and names it so the viewer highlights it as JSON", () => {
    expect(
      apiGatewayResponseContent(response({ data: '{"a":[1,2]}' }, "application/json")),
    ).toEqual({
      kind: "text",
      fileName: "response.json",
      text: '{"a":[1,2]}',
      pretty: '{\n  "a": [\n    1,\n    2\n  ]\n}',
    });
  });

  it("recognises JSON sent without a JSON content type", () => {
    expect(apiGatewayResponseContent(response({ data: "[1]" }, "text/plain"))).toMatchObject({
      fileName: "response.json",
      pretty: "[\n  1\n]",
    });
  });

  it("shows JSON that does not parse, such as one cut off by the size cap, as it arrived", () => {
    expect(
      apiGatewayResponseContent(response({ data: '{"a":', cutOff: "size" }, "application/json")),
    ).toMatchObject({ kind: "text", fileName: "response.json", text: '{"a":', pretty: null });
  });

  it("lays JSON out without changing a token, as parsing and printing it would", () => {
    const body = '{"id":9007199254740993,"big":1e400,"a":1,"a":2,"s":"\\u00e9 {x}","e":[],"o":{}}';

    expect(apiGatewayResponseContent(response({ data: body }, "application/json"))).toMatchObject({
      pretty: [
        "{",
        '  "id": 9007199254740993,',
        '  "big": 1e400,',
        '  "a": 1,',
        '  "a": 2,',
        '  "s": "\\u00e9 {x}",',
        '  "e": [],',
        '  "o": {}',
        "}",
      ].join("\n"),
    });
  });

  it("leaves JSON as it arrived when re-indenting would multiply its size", () => {
    // 40 levels deep around 20,000 short entries: two characters each, 80 of indentation.
    const deep = `${"[".repeat(40)}${"1,".repeat(20_000)}1${"]".repeat(40)}`;

    expect(apiGatewayResponseContent(response({ data: deep }, "application/json"))).toMatchObject({
      fileName: "response.json",
      pretty: null,
    });
  });

  it("picks the language from the content type for other text", () => {
    expect(
      apiGatewayResponseContent(response({ data: "<p>hi</p>" }, "text/html; charset=utf-8")),
    ).toMatchObject({ kind: "text", fileName: "response.html", pretty: null });
  });

  it("draws a whole image and refuses other binary bodies", () => {
    const image = response({ encoding: "base64", data: "iVBORw0KGgo=" }, "image/png");
    expect(apiGatewayResponseContent(image)).toEqual({
      kind: "image",
      src: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(
      apiGatewayResponseContent({ ...image, body: { ...image.body, cutOff: "timeout" } }),
    ).toEqual({ kind: "binary" });
    expect(
      apiGatewayResponseContent(
        response({ encoding: "base64", data: "AAEC" }, "application/octet-stream"),
      ),
    ).toEqual({ kind: "binary" });
  });

  it("says so when there is no body", () => {
    expect(apiGatewayResponseContent(response({ data: "" }))).toEqual({ kind: "empty" });
  });
});

describe("apiGatewayFormatJson", () => {
  it("lays out a request body around the placeholders in it", () => {
    expect(apiGatewayFormatJson('{"id":{{id}},"name":"{{name}}","tags":[{{tag}}]}')).toBe(
      [
        "{",
        '  "id": {{id}},',
        '  "name": "{{name}}",',
        '  "tags": [',
        "    {{tag}}",
        "  ]",
        "}",
      ].join("\n"),
    );
  });
});

describe("labels", () => {
  it("names an unnamed request after where it goes", () => {
    expect(
      apiGatewayRequestLabel({
        ...EMPTY_API_GATEWAY_REQUEST,
        url: "https://api.test/users?page=2#top",
      }),
    ).toBe("api.test/users");
    expect(apiGatewayRequestLabel(EMPTY_API_GATEWAY_REQUEST)).toBe("Untitled request");
  });

  it("leaves credentials written in the URL out of the label", () => {
    expect(
      apiGatewayRequestLabel({
        ...EMPTY_API_GATEWAY_REQUEST,
        url: "https://ada:s3cret@api.test/me",
      }),
    ).toBe("api.test/me");
  });

  it("keeps the label short enough to be offered as the request's name", () => {
    const label = apiGatewayRequestLabel({
      ...EMPTY_API_GATEWAY_REQUEST,
      url: `https://api.test/${"segment/".repeat(60)}`,
    });
    expect(label).toHaveLength(API_GATEWAY_MAX_NAME_LENGTH);
  });

  it("adds a reason phrase to the statuses it knows", () => {
    expect(apiGatewayStatusLabel(404)).toBe("404 Not Found");
    expect(apiGatewayStatusLabel(299)).toBe("299");
  });
});
