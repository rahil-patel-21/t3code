// @vitest-environment jsdom

import { EMPTY_API_GATEWAY_REQUEST } from "@t3tools/client-runtime/api-gateway";
import {
  ApiGatewayExecuteError,
  ApiGatewayItemId,
  ApiGatewayVariableSetId,
  EnvironmentId,
  type ApiGatewayExecuteInput,
  type ApiGatewayExecuteResult,
  type ApiGatewayItem,
  type ApiGatewayOperation,
  type ApiGatewayWorkspace,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  workspace: null as unknown,
  workspaceError: null as string | null,
  refresh: vi.fn(),
  isMobile: false,
  apply: vi.fn(),
  execute: vi.fn(),
  confirm: vi.fn(),
  showMenu: vi.fn(),
}));

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => testState.isMobile }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    dialogs: { confirm: testState.confirm },
    contextMenu: { show: testState.showMenu },
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment-1",
        label: "This Mac",
        serverConfig: { environment: { capabilities: { apiGateway: true } } },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "environment-1",
}));
vi.mock("../../state/apiGateway", () => ({
  apiGatewayEnvironment: { apply: "apply", execute: "execute", workspace: () => "workspace" },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: testState.workspace,
    error: testState.workspaceError,
    refresh: testState.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "apply" ? testState.apply : testState.execute),
}));
// The real viewer draws through a worker pool that jsdom does not have.
vi.mock("../files/AttachmentFilePreview", () => ({
  ReadOnlySourcePreview: (props: { readonly text: string }) => (
    <pre data-response-body>{props.text}</pre>
  ),
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));

import { useApiGatewayStore } from "../../apiGatewayStore";
import { ApiGatewayPage } from "./ApiGatewayPage";

const ENVIRONMENT = EnvironmentId.make("environment-1");
const EMPTY_WORKSPACE: ApiGatewayWorkspace = { items: [], variableSets: [] };

const RESULT: ApiGatewayExecuteResult = {
  status: 200,
  url: "http://api.test/users?page=2",
  headers: [{ name: "content-type", value: "application/json" }],
  body: { encoding: "utf8", data: '{"ok":true}', bytes: 11, cutOff: null },
  totalMs: 12,
};

let root: Root;
let container: HTMLDivElement;

const render = () => act(async () => root.render(<ApiGatewayPage />));

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useApiGatewayStore.setState({ byEnvironment: {}, runs: {}, selectedEnvironmentId: null });
  testState.workspace = EMPTY_WORKSPACE;
  testState.workspaceError = null;
  testState.isMobile = false;
  testState.refresh.mockReset();
  testState.apply.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.execute.mockReset().mockResolvedValue(AsyncResult.success(RESULT));
  testState.confirm.mockReset().mockResolvedValue(true);
  testState.showMenu.mockReset().mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function labelled<T extends HTMLElement>(label: string): T {
  const element = document.body.querySelector<T>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Nothing is labelled "${label}"`);
  return element;
}

function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const element = [...within.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!element) throw new Error(`No "${text}" button`);
  return element;
}

/** The first button with a piece of text of its own, such as a tree row by its name. */
function buttonHolding(text: string): HTMLButtonElement {
  const element = [...document.body.querySelectorAll("button span")]
    .find((candidate) => candidate.textContent === text)
    ?.closest("button");
  if (!element) throw new Error(`No button holds "${text}"`);
  return element;
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

const click = (element: HTMLElement) => act(async () => element.click());

const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    // React tracks the value it last wrote, so the change has to go through the native setter.
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

/** Presses mod+`key` on `target` and says whether the page claimed it. */
async function press(target: EventTarget, key: string) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const environmentState = () => useApiGatewayStore.getState().byEnvironment[ENVIRONMENT];
const tabs = () => environmentState()?.tabs ?? [];
const sentRequest = () =>
  (testState.execute.mock.calls.at(-1)![0] as { input: { request: ApiGatewayExecuteInput } }).input
    .request;
const appliedOperations = () =>
  (
    testState.apply.mock.calls.at(-1)![0] as {
      input: { operations: ReadonlyArray<ApiGatewayOperation> };
    }
  ).input.operations;

const COLLECTION: ApiGatewayItem = {
  kind: "folder",
  id: ApiGatewayItemId.make("api"),
  parentId: null,
  name: "API",
};
const SAVED_REQUEST: ApiGatewayItem = {
  kind: "request",
  id: ApiGatewayItemId.make("list"),
  parentId: COLLECTION.id,
  name: "List users",
  request: { ...EMPTY_API_GATEWAY_REQUEST, url: "https://api.test/users" },
};

const paste = (input: HTMLInputElement, text: string) =>
  act(async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    input.dispatchEvent(event);
  });

async function openRequest(url: string) {
  await click(button("New request"));
  await type(labelled<HTMLInputElement>("Request URL"), url);
}

async function showWorkspace(workspace: ApiGatewayWorkspace) {
  testState.workspace = workspace;
  await render();
}

describe("ApiGatewayPage", () => {
  it("sends what is in the editor from the environment and shows what came back", async () => {
    await openRequest("api.test/users?page=2");
    await click(button("Send"));

    expect(testState.execute).toHaveBeenCalledOnce();
    expect(testState.execute.mock.calls[0]![0]).toMatchObject({
      environmentId: ENVIRONMENT,
      input: { request: { method: "GET", url: "http://api.test/users?page=2", headers: [] } },
    });
    expect(document.body.textContent).toContain("200 OK");
    expect(document.querySelector("[data-response-body]")?.textContent).toBe('{\n  "ok": true\n}');
    expect(environmentState()?.history).toMatchObject([
      { status: 200, request: { url: "api.test/users?page=2" } },
    ]);
  });

  it("fills placeholders from the variable set chosen to send with", async () => {
    const setId = ApiGatewayVariableSetId.make("staging");
    useApiGatewayStore.getState().setActiveVariableSet(ENVIRONMENT, setId);
    await showWorkspace({
      items: [],
      variableSets: [
        {
          id: setId,
          name: "Staging",
          variables: [{ key: "host", value: "https://staging.test", enabled: true }],
        },
      ],
    });

    await openRequest("{{host}}/users/{{id}}");
    await click(button("Send"));

    expect(sentRequest().url).toBe("https://staging.test/users/{{id}}");
    expect(document.body.textContent).toContain("Sent with placeholders that had no value: {{id}}");
  });

  it("says why when a request produced no response", async () => {
    testState.execute.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ApiGatewayExecuteError({
            reason: "network",
            message: "connect ECONNREFUSED 127.0.0.1:9",
          }),
        ),
      ),
    );
    await openRequest("http://127.0.0.1:9");
    await click(button("Send"));

    expect(document.body.textContent).toContain("No response came back");
    expect(document.body.textContent).toContain("connect ECONNREFUSED 127.0.0.1:9");
    expect(environmentState()?.history[0]?.status).toBeNull();
  });

  it("points at unfilled placeholders when a request could not be sent", async () => {
    testState.execute.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new ApiGatewayExecuteError({
            reason: "network",
            message: "getaddrinfo ENOTFOUND {{host}}",
          }),
        ),
      ),
    );
    await openRequest("{{host}}/users");
    await click(button("Send"));

    expect(document.body.textContent).toContain(
      "getaddrinfo ENOTFOUND {{host}} Placeholders with no value: {{host}}.",
    );
  });

  it("cancels the request in flight when asked, and keeps it out of history", async () => {
    // The call ends the way a cancelled RPC does: interrupted, once its signal aborts.
    testState.execute.mockImplementation(
      ({ input }: { input: { signal: AbortSignal } }) =>
        new Promise((resolve) => {
          input.signal.addEventListener("abort", () =>
            resolve(AsyncResult.failure(Cause.interrupt())),
          );
        }),
    );
    await openRequest("https://api.test/slow");
    await click(button("Send"));
    expect(document.body.textContent).toContain("Sending…");

    await click(button("Cancel"));

    expect(document.body.textContent).toContain("Cancelled");
    expect(environmentState()?.history).toEqual([]);
  });

  it("drops a response that arrives after its tab was closed", async () => {
    let answer: (result: unknown) => void = () => {};
    testState.execute.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openRequest("https://api.test/slow");
    await click(button("Send"));
    await click(labelled("Close api.test/slow (unsaved changes)"));

    await act(async () => answer(AsyncResult.success(RESULT)));

    expect(tabs()).toEqual([]);
    expect(useApiGatewayStore.getState().runs).toEqual({});
  });

  it("sends and saves from the keyboard wherever focus is, and keeps the browser's save away", async () => {
    testState.execute.mockReturnValue(new Promise(() => {}));
    await click(button("New request"));

    // Nothing typed yet: the browser must still not get to "save page".
    expect(await press(document.body, "s")).toBe(true);
    expect(dialog()).toBeNull();

    await type(labelled<HTMLInputElement>("Request URL"), "https://api.test/users");
    // Focus on nothing at all, as after clicking the response text.
    expect(await press(document.body, "Enter")).toBe(true);
    expect(testState.execute).toHaveBeenCalledOnce();
    // Still sending: a second press does not send again.
    await press(document.body, "Enter");
    expect(testState.execute).toHaveBeenCalledOnce();

    expect(await press(labelled("Request URL"), "s")).toBe(true);
    expect(dialog()).not.toBeNull();
  });

  it("saves a new request into a collection made for it, then follows the saved copy", async () => {
    await openRequest("https://api.test/users");
    await click(button("Save"));
    await click(button("Save", dialog()!));

    const items = appliedOperations().flatMap((operation) =>
      operation.type === "item.put" ? [operation.item] : [],
    );
    expect(items).toMatchObject([
      { kind: "folder", parentId: null, name: "My collection" },
      {
        kind: "request",
        parentId: items[0]!.id,
        name: "api.test/users",
        request: { url: "https://api.test/users" },
      },
    ]);
    expect(tabs()[0]).toMatchObject({ itemId: items[1]!.id });

    // The server's next snapshot holds the saved request. The draft equals it,
    // so the tab lets the draft go and there is nothing left to save.
    await showWorkspace({ items, variableSets: [] });

    expect(tabs()[0]?.draft).toBeNull();
    expect(button("Save").disabled).toBe(true);
    expect(labelled<HTMLInputElement>("Request URL").value).toBe("https://api.test/users");
  });

  it("writes an edited saved request back under the same item", async () => {
    await showWorkspace({ items: [COLLECTION, SAVED_REQUEST], variableSets: [] });

    await click(buttonHolding("List users"));
    await type(labelled<HTMLInputElement>("Request URL"), "https://api.test/users?active=1");
    await click(button("Save"));

    expect(appliedOperations()).toMatchObject([
      {
        type: "item.put",
        item: {
          id: "list",
          name: "List users",
          request: {
            url: "https://api.test/users?active=1",
            query: [{ key: "active", value: "1", enabled: true }],
          },
        },
      },
    ]);
  });

  it("follows the saved request again once an edit is typed back to it", async () => {
    await showWorkspace({ items: [COLLECTION, SAVED_REQUEST], variableSets: [] });
    await click(buttonHolding("List users"));
    const url = labelled<HTMLInputElement>("Request URL");

    await type(url, "https://api.test/users?x=1");
    expect(tabs()[0]?.draft).not.toBeNull();
    await type(url, "https://api.test/users");

    expect(tabs()[0]?.draft).toBeNull();
  });

  it("renames an item as the environment has it now, not as it was when the menu opened", async () => {
    await showWorkspace({ items: [COLLECTION, SAVED_REQUEST], variableSets: [] });
    testState.showMenu.mockResolvedValue("edit");
    await click(labelled("Actions for List users"));
    // Another client changes the request while the dialog is open.
    const changed = {
      ...SAVED_REQUEST,
      request: { ...EMPTY_API_GATEWAY_REQUEST, url: "https://api.test/v2/users" },
    };
    await showWorkspace({ items: [COLLECTION, changed], variableSets: [] });

    await type(dialog()!.querySelector("input")!, "Every user");
    await click(button("Save", dialog()!));

    expect(appliedOperations()).toMatchObject([
      {
        type: "item.put",
        item: {
          id: "list",
          name: "Every user",
          parentId: "api",
          request: { url: "https://api.test/v2/users" },
        },
      },
    ]);
  });

  it("says so when the saved request a tab shows is deleted, and lets the tab go", async () => {
    await showWorkspace({ items: [COLLECTION, SAVED_REQUEST], variableSets: [] });
    await click(buttonHolding("List users"));

    await showWorkspace({ items: [COLLECTION], variableSets: [] });
    expect(document.body.textContent).toContain("This request no longer exists");

    await click(button("Close tab"));
    expect(tabs()).toEqual([]);
  });

  it("keeps the URL and the parameter rows in step, whichever one is edited", async () => {
    await openRequest("https://api.test/users?page=2");
    expect(labelled<HTMLInputElement>("Name of parameter 1").value).toBe("page");
    expect(labelled<HTMLInputElement>("Value of parameter 1").value).toBe("2");

    // The trailing blank row is how a parameter is added.
    await type(labelled<HTMLInputElement>("Name of parameter 2"), "sort");
    await type(labelled<HTMLInputElement>("Value of parameter 2"), "name");
    expect(labelled<HTMLInputElement>("Request URL").value).toBe(
      "https://api.test/users?page=2&sort=name",
    );

    // Switched off, a parameter leaves the URL but stays in the list.
    await click(labelled("Send parameter 1"));
    expect(labelled<HTMLInputElement>("Request URL").value).toBe(
      "https://api.test/users?sort=name",
    );
    expect(labelled<HTMLInputElement>("Name of parameter 1").value).toBe("page");
  });

  it("refuses an edit that makes the request larger than one can be stored", async () => {
    await openRequest("https://api.test");

    await type(labelled<HTMLInputElement>("Request URL"), `https://api.test/${"x".repeat(16_000)}`);

    expect(tabs()[0]?.draft?.url).toBe("https://api.test");
  });

  it("turns a pasted curl command into the whole request", async () => {
    await click(button("New request"));
    await paste(
      labelled<HTMLInputElement>("Request URL"),
      `curl -X POST https://api.test/users -H 'Content-Type: application/json' -H 'X-Trace: on' -d '{"name":"Ada"}'`,
    );
    expect(labelled<HTMLInputElement>("Request URL").value).toBe("https://api.test/users");

    await click(button("Send"));

    expect(sentRequest()).toMatchObject({
      method: "POST",
      url: "https://api.test/users",
      headers: [
        { name: "Content-Type", value: "application/json" },
        { name: "X-Trace", value: "on" },
      ],
      body: '{"name":"Ada"}',
    });
  });

  it("leaves a URL that merely starts with the word curl alone when it is typed", async () => {
    await openRequest("curl https://api.test");

    expect(labelled<HTMLInputElement>("Request URL").value).toBe("curl https://api.test");
  });

  it("sends the body typed in the editor with the content type of its language", async () => {
    await click(button("New request"));
    await paste(labelled<HTMLInputElement>("Request URL"), "curl -X PUT https://api.test/users/1");
    await click(button("Body"));
    await click(button("Raw"));
    await type(labelled<HTMLTextAreaElement>("Request body"), '{"name":"{{name}}"}');
    await click(button("Send"));

    expect(sentRequest()).toMatchObject({
      method: "PUT",
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: '{"name":"{{name}}"}',
    });
  });

  it("opens a request from history in a tab of its own", async () => {
    await openRequest("https://api.test/users");
    await click(button("Send"));
    await click(labelled("Close api.test/users (unsaved changes)"));
    expect(tabs()).toHaveLength(0);

    await click(button("History"));
    await click(buttonHolding("api.test/users"));

    expect(tabs()).toMatchObject([
      { itemId: null, draft: { method: "GET", url: "https://api.test/users" } },
    ]);
  });

  it("creates a collection from the side panel", async () => {
    await click(labelled("New collection"));
    await type(dialog()!.querySelector("input")!, "  Billing  ");
    await click(button("Create", dialog()!));

    expect(appliedOperations()).toMatchObject([
      { type: "item.put", item: { kind: "folder", parentId: null, name: "Billing" } },
    ]);
    expect(dialog()).toBeNull();
  });

  it("keeps the dialog open when the environment refuses the change", async () => {
    testState.apply.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("API Gateway keeps at most 2000 items."))),
    );
    await click(labelled("New collection"));
    await type(dialog()!.querySelector("input")!, "Billing");
    await click(button("Create", dialog()!));

    expect(dialog()).not.toBeNull();
  });

  it("deletes an item from its menu only once the deletion is confirmed", async () => {
    testState.showMenu.mockResolvedValue("delete");
    testState.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await showWorkspace({ items: [COLLECTION, SAVED_REQUEST], variableSets: [] });

    await click(labelled("Actions for API"));
    expect(testState.apply).not.toHaveBeenCalled();

    await click(labelled("Actions for API"));
    expect(appliedOperations()).toEqual([{ type: "item.delete", id: "api" }]);
    expect(testState.confirm.mock.calls[1]![0]).toContain("Everything inside it is deleted too.");
  });

  it("saves a variable set and starts sending with the first one made", async () => {
    await click(labelled("Edit variable sets"));
    await type(labelled<HTMLInputElement>("Name of variable 1"), "host");
    await type(labelled<HTMLInputElement>("Value of variable 1"), "https://staging.test");
    await click(button("Save", dialog()!));

    const [operation] = appliedOperations();
    expect(operation).toMatchObject({
      type: "variableSet.put",
      variableSet: {
        name: "New variable set",
        variables: [{ key: "host", value: "https://staging.test", enabled: true }],
      },
    });
    expect(environmentState()?.activeVariableSetId).toBe(
      operation?.type === "variableSet.put" ? operation.variableSet.id : null,
    );
  });

  it("leaves sending without variables alone when a set is edited", async () => {
    await showWorkspace({
      items: [],
      variableSets: [
        { id: ApiGatewayVariableSetId.make("local"), name: "Local", variables: [] },
        { id: ApiGatewayVariableSetId.make("production"), name: "Production", variables: [] },
      ],
    });
    await click(labelled("Edit variable sets"));
    await type(labelled<HTMLInputElement>("Name of variable 1"), "host");
    await click(button("Save", dialog()!));

    expect(testState.apply).toHaveBeenCalledOnce();
    expect(environmentState()?.activeVariableSetId ?? null).toBeNull();
  });

  it("asks before closing the variables dialog over edits that were not saved", async () => {
    testState.confirm.mockResolvedValue(false);
    await click(labelled("Edit variable sets"));
    await type(labelled<HTMLInputElement>("Name of variable 1"), "host");

    await click(button("Close", dialog()!));

    expect(testState.confirm).toHaveBeenCalledOnce();
    expect(dialog()).not.toBeNull();
  });

  it("asks before closing a tab whose edits were not saved, and keeps it on no", async () => {
    testState.confirm.mockResolvedValue(false);
    await openRequest("https://api.test/users");

    await click(labelled("Close api.test/users (unsaved changes)"));

    expect(testState.confirm).toHaveBeenCalledOnce();
    expect(tabs()).toHaveLength(1);
  });

  it("closes an untouched tab without asking", async () => {
    await click(button("New request"));

    await click(labelled("Close Untitled request"));

    expect(testState.confirm).not.toHaveBeenCalled();
    expect(tabs()).toHaveLength(0);
  });

  it("shows why the workspace did not load, with the side panel closed too", async () => {
    testState.isMobile = true;
    testState.workspace = null;
    testState.workspaceError =
      "The authenticated token is missing required scope: terminal:operate.";
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    expect(document.body.textContent).toContain(
      "Collections and variable sets could not be loaded",
    );
    expect(document.body.textContent).toContain("missing required scope: terminal:operate");
    await click(button("Try again"));
    expect(testState.refresh).toHaveBeenCalledOnce();
  });
});
