/**
 * What one client keeps for API Gateway: its open tabs with their unsaved
 * edits, the variable set it sends with, and its history of sent requests.
 * Collections and variable sets are the server's and are not stored here.
 */
import {
  ApiGatewayItemId,
  ApiGatewayRequest,
  ApiGatewayVariableSetId,
  ForwardCompatibleArray,
  type ApiGatewayExecuteResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { createDeferredStorage, createMemoryStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

const API_GATEWAY_STORAGE_KEY = "t3code:api-gateway:v1";
export const API_GATEWAY_HISTORY_LIMIT = 50;

const ApiGatewayTab = Schema.Struct({
  id: Schema.String,
  /** The saved request this tab edits, or null for one that was never saved. */
  itemId: Schema.NullOr(ApiGatewayItemId),
  /** Edits not saved yet. Null while the tab shows its saved request as it is. */
  draft: Schema.NullOr(ApiGatewayRequest),
});
export type ApiGatewayTab = typeof ApiGatewayTab.Type;

const ApiGatewayHistoryEntry = Schema.Struct({
  id: Schema.String,
  /** As written when it was sent, placeholders included. */
  request: ApiGatewayRequest,
  /** Null when the request produced no response. */
  status: Schema.NullOr(Schema.Number),
});
export type ApiGatewayHistoryEntry = typeof ApiGatewayHistoryEntry.Type;

const ApiGatewayEnvironmentState = Schema.Struct({
  // Entries are dropped one by one when they no longer decode, so one stale
  // draft cannot take every open tab with it.
  tabs: ForwardCompatibleArray(ApiGatewayTab),
  activeTabId: Schema.NullOr(Schema.String),
  activeVariableSetId: Schema.NullOr(ApiGatewayVariableSetId),
  /** Newest first. */
  history: ForwardCompatibleArray(ApiGatewayHistoryEntry),
});
export type ApiGatewayEnvironmentState = typeof ApiGatewayEnvironmentState.Type;

const decodePersistedState = Schema.decodeUnknownOption(
  Schema.Struct({ byEnvironment: Schema.Record(Schema.String, ApiGatewayEnvironmentState) }),
);

/** The latest send from a tab. */
export type ApiGatewayRun =
  | { readonly phase: "sending"; readonly cancel: () => void }
  | {
      readonly phase: "done";
      readonly result: ApiGatewayExecuteResult;
      /** Placeholders that had no value and went out as written. */
      readonly unresolved: ReadonlyArray<string>;
    }
  | { readonly phase: "failed"; readonly title: string; readonly message: string };

export const EMPTY_API_GATEWAY_ENVIRONMENT_STATE: ApiGatewayEnvironmentState = {
  tabs: [],
  activeTabId: null,
  activeVariableSetId: null,
  history: [],
};

interface ApiGatewayStoreState {
  readonly byEnvironment: Readonly<Record<string, ApiGatewayEnvironmentState>>;
  /**
   * By tab id. Kept in memory only: responses are large and soon out of date.
   * ponytail: a response stays until its tab closes, up to 5 MB each. Drop the
   * least recent ones if that ever adds up.
   */
  readonly runs: Readonly<Record<string, ApiGatewayRun>>;
  /** The environment last picked to send from, so the page returns to it. Not stored. */
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  /** Opens and focuses a new tab, returning its id. */
  readonly openTab: (environmentId: EnvironmentId, tab: Omit<ApiGatewayTab, "id">) => string;
  /** Focuses the tab already showing this saved request, or opens one for it. */
  readonly openItem: (environmentId: EnvironmentId, itemId: ApiGatewayItemId) => void;
  readonly activateTab: (environmentId: EnvironmentId, tabId: string) => void;
  /** Closes the tab and cancels a request still in flight from it. */
  readonly closeTab: (environmentId: EnvironmentId, tabId: string) => void;
  readonly updateTab: (
    environmentId: EnvironmentId,
    tabId: string,
    patch: Partial<Omit<ApiGatewayTab, "id">>,
  ) => void;
  readonly setActiveVariableSet: (
    environmentId: EnvironmentId,
    variableSetId: ApiGatewayVariableSetId | null,
  ) => void;
  readonly recordHistory: (
    environmentId: EnvironmentId,
    entry: Omit<ApiGatewayHistoryEntry, "id">,
  ) => void;
  readonly clearHistory: (environmentId: EnvironmentId) => void;
  readonly setRun: (tabId: string, run: ApiGatewayRun) => void;
}

type PersistedApiGatewayState = Pick<ApiGatewayStoreState, "byEnvironment">;

/**
 * localStorage gives the whole app about 5 MB, and composer drafts live in it
 * too, so this store keeps to a share of it.
 */
const PERSIST_MAX_CHARS = 2_500_000;

// A tab or a send keeps its identity until it changes, so each is measured once
// rather than on every pause in typing.
const serializedSizes = new WeakMap<object, number>();
function serializedSize(entry: object): number {
  let size = serializedSizes.get(entry);
  if (size === undefined) {
    size = JSON.stringify(entry).length;
    serializedSizes.set(entry, size);
  }
  return size;
}

/**
 * What goes into storage for the state. Tabs are taken first, since a draft
 * exists nowhere else, then history from the newest send back. A tab or a send
 * that no longer fits is left out, and lasts only until the page is reloaded.
 */
export function serializeApiGatewayState(value: StorageValue<PersistedApiGatewayState>): string {
  let remaining = PERSIST_MAX_CHARS;
  const fits = (entry: object) => {
    const size = serializedSize(entry);
    if (size > remaining) return false;
    remaining -= size;
    return true;
  };
  const environments = Object.entries(value.state.byEnvironment);
  // Weighed for every environment before any history is.
  const tabs = environments.map(([, environment]) => environment.tabs.filter(fits));
  const byEnvironment = Object.fromEntries(
    environments.map(([environmentId, environment], index) => [
      environmentId,
      { ...environment, tabs: tabs[index], history: environment.history.filter(fits) },
    ]),
  );
  return JSON.stringify({ ...value, state: { byEnvironment } });
}

const browserStorage = typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();

// Every keystroke in a request changes this state, so the write is deferred
// and serialized once per pause rather than once per key.
const deferredStorage = createDeferredStorage<StorageValue<PersistedApiGatewayState>>(
  {
    getItem: (name) => browserStorage.getItem(name),
    removeItem: (name) => browserStorage.removeItem(name),
    setItem: (name, serialized) => {
      try {
        browserStorage.setItem(name, serialized);
      } catch {
        // The quota is full. The page keeps working from memory.
      }
    },
  },
  serializeApiGatewayState,
);

const persistStorage: PersistStorage<PersistedApiGatewayState> = {
  getItem: (name) => {
    const raw = deferredStorage.getItem(name);
    // `merge` decodes this from unknown, so the cast only satisfies zustand.
    return typeof raw === "string"
      ? (JSON.parse(raw) as StorageValue<PersistedApiGatewayState>)
      : null;
  },
  setItem: (name, value) => deferredStorage.setItem(name, value),
  removeItem: (name) => deferredStorage.removeItem(name),
};

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    deferredStorage.flush();
  });
}

export const useApiGatewayStore = create<ApiGatewayStoreState>()(
  persist(
    (set, get) => {
      const updateEnvironment = (
        environmentId: EnvironmentId,
        update: (state: ApiGatewayEnvironmentState) => ApiGatewayEnvironmentState,
      ) =>
        set((state) => ({
          byEnvironment: {
            ...state.byEnvironment,
            [environmentId]: update(
              state.byEnvironment[environmentId] ?? EMPTY_API_GATEWAY_ENVIRONMENT_STATE,
            ),
          },
        }));

      return {
        byEnvironment: {},
        runs: {},
        selectedEnvironmentId: null,
        selectEnvironment: (selectedEnvironmentId) => set({ selectedEnvironmentId }),
        openTab: (environmentId, tab) => {
          const id = randomUUID();
          updateEnvironment(environmentId, (state) => ({
            ...state,
            tabs: [...state.tabs, { ...tab, id }],
            activeTabId: id,
          }));
          return id;
        },
        openItem: (environmentId, itemId) => {
          const open = get().byEnvironment[environmentId]?.tabs.find(
            (tab) => tab.itemId === itemId,
          );
          if (open) get().activateTab(environmentId, open.id);
          else get().openTab(environmentId, { itemId, draft: null });
        },
        activateTab: (environmentId, tabId) =>
          updateEnvironment(environmentId, (state) => ({ ...state, activeTabId: tabId })),
        closeTab: (environmentId, tabId) => {
          const run = get().runs[tabId];
          if (run?.phase === "sending") run.cancel();
          set((state) => {
            const { [tabId]: _closed, ...runs } = state.runs;
            return { runs };
          });
          updateEnvironment(environmentId, (state) => {
            const index = state.tabs.findIndex((tab) => tab.id === tabId);
            if (index === -1) return state;
            const tabs = state.tabs.filter((tab) => tab.id !== tabId);
            return {
              ...state,
              tabs,
              // Focus moves to the tab that slid into this one's place, else the one before.
              activeTabId:
                state.activeTabId === tabId
                  ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
                  : state.activeTabId,
            };
          });
        },
        updateTab: (environmentId, tabId, patch) =>
          updateEnvironment(environmentId, (state) => ({
            ...state,
            tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
          })),
        setActiveVariableSet: (environmentId, activeVariableSetId) =>
          updateEnvironment(environmentId, (state) => ({ ...state, activeVariableSetId })),
        recordHistory: (environmentId, entry) =>
          updateEnvironment(environmentId, (state) => ({
            ...state,
            history: [{ ...entry, id: randomUUID() }, ...state.history].slice(
              0,
              API_GATEWAY_HISTORY_LIMIT,
            ),
          })),
        clearHistory: (environmentId) =>
          updateEnvironment(environmentId, (state) => ({ ...state, history: [] })),
        setRun: (tabId, run) => set((state) => ({ runs: { ...state.runs, [tabId]: run } })),
      };
    },
    {
      name: API_GATEWAY_STORAGE_KEY,
      version: 1,
      storage: persistStorage,
      partialize: (state) => ({ byEnvironment: state.byEnvironment }),
      merge: (persisted, current) => ({
        ...current,
        byEnvironment: Option.match(decodePersistedState(persisted), {
          onNone: () => ({}),
          onSome: (state) => state.byEnvironment,
        }),
      }),
    },
  ),
);

/**
 * Forgets what this client kept for an environment that was removed. Its
 * drafts and history can hold the credentials typed into them.
 */
export function clearApiGatewayEnvironment(environmentId: EnvironmentId): void {
  const store = useApiGatewayStore.getState();
  // Closing a tab also stops a request still in flight from it.
  for (const tab of store.byEnvironment[environmentId]?.tabs ?? []) {
    store.closeTab(environmentId, tab.id);
  }
  useApiGatewayStore.setState((state) => {
    const { [environmentId]: _removed, ...byEnvironment } = state.byEnvironment;
    return { byEnvironment };
  });
}
