import { EMPTY_API_GATEWAY_REQUEST } from "@t3tools/client-runtime/api-gateway";
import { ApiGatewayItemId, EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  API_GATEWAY_HISTORY_LIMIT,
  clearApiGatewayEnvironment,
  EMPTY_API_GATEWAY_ENVIRONMENT_STATE,
  serializeApiGatewayState,
  useApiGatewayStore,
} from "./apiGatewayStore";

const ENVIRONMENT = EnvironmentId.make("environment-1");

const environmentState = () =>
  useApiGatewayStore.getState().byEnvironment[ENVIRONMENT] ?? EMPTY_API_GATEWAY_ENVIRONMENT_STATE;

const openScratch = () =>
  useApiGatewayStore
    .getState()
    .openTab(ENVIRONMENT, { itemId: null, draft: EMPTY_API_GATEWAY_REQUEST });

describe("apiGatewayStore", () => {
  beforeEach(() => useApiGatewayStore.setState({ byEnvironment: {}, runs: {} }));

  it("focuses the tab already showing a saved request instead of opening a second", () => {
    const store = useApiGatewayStore.getState();
    const itemId = ApiGatewayItemId.make("list-users");
    store.openItem(ENVIRONMENT, itemId);
    const other = openScratch();
    expect(environmentState().activeTabId).toBe(other);

    store.openItem(ENVIRONMENT, itemId);

    const { tabs, activeTabId } = environmentState();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((tab) => tab.id === activeTabId)?.itemId).toBe(itemId);
  });

  it("moves focus to the tab that takes a closed tab's place, else to the one before", () => {
    const store = useApiGatewayStore.getState();
    const [first, second, third] = [openScratch(), openScratch(), openScratch()];
    store.activateTab(ENVIRONMENT, second);

    store.closeTab(ENVIRONMENT, second);
    expect(environmentState().activeTabId).toBe(third);

    store.closeTab(ENVIRONMENT, third);
    expect(environmentState().activeTabId).toBe(first);

    store.closeTab(ENVIRONMENT, first);
    expect(environmentState()).toMatchObject({ tabs: [], activeTabId: null });
  });

  it("keeps focus where it is when a background tab closes", () => {
    const store = useApiGatewayStore.getState();
    const [first, second] = [openScratch(), openScratch()];

    store.closeTab(ENVIRONMENT, first);

    expect(environmentState().activeTabId).toBe(second);
  });

  it("cancels the request still in flight from a tab that closes", () => {
    const store = useApiGatewayStore.getState();
    const tab = openScratch();
    let cancelled = false;
    store.setRun(tab, {
      phase: "sending",
      cancel: () => {
        cancelled = true;
      },
    });

    store.closeTab(ENVIRONMENT, tab);

    expect(cancelled).toBe(true);
    expect(useApiGatewayStore.getState().runs).toEqual({});
  });

  it("keeps the newest sends and drops the oldest past the limit", () => {
    const store = useApiGatewayStore.getState();
    for (let index = 0; index <= API_GATEWAY_HISTORY_LIMIT; index += 1) {
      store.recordHistory(ENVIRONMENT, {
        request: { ...EMPTY_API_GATEWAY_REQUEST, url: `https://api.test/${index}` },
        status: 200,
      });
    }

    const { history } = environmentState();
    expect(history).toHaveLength(API_GATEWAY_HISTORY_LIMIT);
    expect(history[0]?.request.url).toBe(`https://api.test/${API_GATEWAY_HISTORY_LIMIT}`);
    expect(history.at(-1)?.request.url).toBe("https://api.test/1");
  });

  it("forgets a removed environment, stopping what its tabs are still sending", () => {
    const store = useApiGatewayStore.getState();
    const tab = openScratch();
    store.recordHistory(ENVIRONMENT, { request: EMPTY_API_GATEWAY_REQUEST, status: 200 });
    let cancelled = false;
    store.setRun(tab, {
      phase: "sending",
      cancel: () => {
        cancelled = true;
      },
    });

    clearApiGatewayEnvironment(ENVIRONMENT);

    expect(cancelled).toBe(true);
    expect(useApiGatewayStore.getState()).toMatchObject({ byEnvironment: {}, runs: {} });
  });

  it("restores the tabs that still decode and drops only the ones that do not", () => {
    const merge = useApiGatewayStore.persist.getOptions().merge!;
    const valid = { id: "a", itemId: null, draft: EMPTY_API_GATEWAY_REQUEST };

    const restored = merge(
      {
        byEnvironment: {
          [ENVIRONMENT]: {
            tabs: [valid, { id: "b", itemId: null, draft: { method: "FETCH" } }],
            activeTabId: "a",
            activeVariableSetId: null,
            history: [{ id: "h", request: "not a request" }],
          },
        },
      },
      useApiGatewayStore.getState(),
    );

    expect(restored.byEnvironment[ENVIRONMENT]).toEqual({
      tabs: [valid],
      activeTabId: "a",
      activeVariableSetId: null,
      history: [],
    });
  });

  it("starts empty when the stored state is not in a shape it knows", () => {
    const merge = useApiGatewayStore.persist.getOptions().merge!;

    expect(
      merge({ byEnvironment: "corrupt" }, useApiGatewayStore.getState()).byEnvironment,
    ).toEqual({});
  });

  it("stores less as the state outgrows the storage it shares with the rest of the app", () => {
    const withBody = (chars: number) => ({
      ...EMPTY_API_GATEWAY_REQUEST,
      body: { ...EMPTY_API_GATEWAY_REQUEST.body, raw: "x".repeat(chars) },
    });
    const tab = (id: string, chars: number) => ({ id, itemId: null, draft: withBody(chars) });
    const sent = (id: string, chars: number) => ({ id, request: withBody(chars), status: 200 });
    const stored = (
      tabs: ReadonlyArray<ReturnType<typeof tab>>,
      history: ReadonlyArray<ReturnType<typeof sent>>,
    ) => {
      const serialized = serializeApiGatewayState({
        version: 1,
        state: {
          byEnvironment: {
            [ENVIRONMENT]: { tabs, activeTabId: null, activeVariableSetId: null, history },
          },
        },
      });
      const environment = (
        JSON.parse(serialized) as {
          state: {
            byEnvironment: Record<string, { tabs: { id: string }[]; history: { id: string }[] }>;
          };
        }
      ).state.byEnvironment[ENVIRONMENT];
      return {
        tabs: environment?.tabs.map((each) => each.id),
        history: environment?.history.map((each) => each.id),
      };
    };

    // Small: everything is kept.
    expect(stored([tab("draft", 100)], [sent("new", 100), sent("old", 100)])).toEqual({
      tabs: ["draft"],
      history: ["new", "old"],
    });
    // History goes from the oldest send, since sending again rebuilds it.
    expect(stored([tab("draft", 100)], [sent("new", 1_500_000), sent("old", 1_500_000)])).toEqual({
      tabs: ["draft"],
      history: ["new"],
    });
    // A draft too large to store is left out; the tabs around it are not.
    expect(stored([tab("small", 100), tab("huge", 3_000_000)], [])).toEqual({
      tabs: ["small"],
      history: [],
    });
  });
});
