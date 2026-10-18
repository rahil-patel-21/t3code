import {
  apiGatewayVariables,
  EMPTY_API_GATEWAY_REQUEST,
  prepareApiGatewayRequest,
  toCurlCommand,
} from "@t3tools/client-runtime/api-gateway";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ApiGatewayExecuteError,
  ApiGatewayItemId,
  ApiGatewayRequest,
  type ApiGatewayFolder,
  type ApiGatewayItem,
  type ApiGatewayOperation,
  type ApiGatewaySavedRequest,
  type ApiGatewayVariableSet,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { BracesIcon, FolderTreeIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  EMPTY_API_GATEWAY_ENVIRONMENT_STATE,
  useApiGatewayStore,
  type ApiGatewayHistoryEntry,
  type ApiGatewayRun,
  type ApiGatewayTab,
} from "~/apiGatewayStore";
import { APP_BASE_NAME } from "~/branding";
import { isElectron } from "~/env";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn, randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { apiGatewayEnvironment } from "~/state/apiGateway";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  apiGatewayFolderOptions,
  apiGatewayRequestLabel,
  duplicateApiGatewayItem,
} from "./apiGateway.logic";
import { ApiGatewayCollections } from "./ApiGatewayCollections";
import {
  ApiGatewayItemDialog,
  ApiGatewayVariablesDialog,
  type ApiGatewayItemDialogTarget,
} from "./ApiGatewayDialogs";
import { ApiGatewayMethodLabel } from "./ApiGatewayMethodLabel";
import { ApiGatewayRequestEditor } from "./ApiGatewayRequestEditor";
import { ApiGatewayResponse } from "./ApiGatewayResponse";

const NO_VARIABLE_SET = "none";

const sameRequest = Schema.toEquivalence(ApiGatewayRequest);
const isStorableRequest = Schema.is(ApiGatewayRequest);
const isExecuteError = Schema.is(ApiGatewayExecuteError);

const newItemId = () => ApiGatewayItemId.make(randomUUID());

const EXECUTE_ERROR_TITLES: Record<ApiGatewayExecuteError["reason"], string> = {
  "invalid-request": "The request was not sent",
  timeout: "The request timed out",
  network: "No response came back",
};

type FailedCommand = Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>;

function failureMessage(result: FailedCommand) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The environment did not answer.";
}

function failedRun(result: FailedCommand, unresolved: ReadonlyArray<string>): ApiGatewayRun {
  if (isAtomCommandInterrupted(result)) {
    return { phase: "failed", title: "Cancelled", message: "The request was stopped." };
  }
  const error = squashAtomCommandFailure(result);
  // An unfilled placeholder in the URL is the usual reason a request cannot be
  // sent at all, and the error for it names a host that does not look like one.
  const hint =
    unresolved.length === 0
      ? ""
      : ` Placeholders with no value: ${unresolved.map((name) => `{{${name}}}`).join(", ")}.`;
  return {
    phase: "failed",
    title: isExecuteError(error) ? EXECUTE_ERROR_TITLES[error.reason] : "The request was not sent",
    message: `${failureMessage(result)}${hint}`,
  };
}

/** Where a dialog's target puts an item, and the collection to create first when it asks for one. */
function placement(target: ApiGatewayItemDialogTarget): {
  readonly parentId: ApiGatewayItemId | null;
  readonly create: ReadonlyArray<ApiGatewayOperation>;
} {
  if (target.kind === "top") return { parentId: null, create: [] };
  if (target.kind === "folder") return { parentId: target.id, create: [] };
  const id = newItemId();
  return {
    parentId: id,
    create: [{ type: "item.put", item: { kind: "folder", id, parentId: null, name: target.name } }],
  };
}

type DialogState =
  | { readonly kind: "folder"; readonly parent: ApiGatewayFolder | null }
  /** By id, so the item is read fresh when the change is made. */
  | { readonly kind: "edit"; readonly itemId: ApiGatewayItemId }
  | { readonly kind: "save"; readonly tabId: string }
  | { readonly kind: "variables" };

function ApiGatewayWorkspaceView(props: {
  readonly environmentId: EnvironmentId;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const { environmentId } = props;
  const workspaceQuery = useEnvironmentQuery(
    apiGatewayEnvironment.workspace({ environmentId, input: {} }),
  );
  const workspace = workspaceQuery.data;
  const state = useApiGatewayStore(
    (store) => store.byEnvironment[environmentId] ?? EMPTY_API_GATEWAY_ENVIRONMENT_STATE,
  );
  const apply = useAtomCommand(apiGatewayEnvironment.apply, { reportFailure: false });
  const execute = useAtomCommand(apiGatewayEnvironment.execute, { reportFailure: false });
  const isMobile = useIsMobile();
  const [panelOpen, setPanelOpen] = useState(!isMobile);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => toastManager.add({ type: "success", title: "Copied as curl" }),
    onError: (copyError) =>
      toastManager.add({ type: "error", title: "Could not copy", description: copyError.message }),
  });

  const items = workspace?.items ?? null;
  const variableSets = workspace?.variableSets ?? [];
  const savedRequests = useMemo(() => {
    const byId = new Map<ApiGatewayItemId, ApiGatewaySavedRequest>();
    for (const item of items ?? []) if (item.kind === "request") byId.set(item.id, item);
    return byId;
  }, [items]);
  const savedOf = (tab: ApiGatewayTab) =>
    tab.itemId === null ? null : (savedRequests.get(tab.itemId) ?? null);
  /** What the tab would send: its edits, else the saved request it shows. */
  const requestOf = (tab: ApiGatewayTab) => tab.draft ?? savedOf(tab)?.request ?? null;

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
  const activeSaved = activeTab === null ? null : savedOf(activeTab);
  const activeRequest = activeTab === null ? null : requestOf(activeTab);
  const activeRun = useApiGatewayStore((store) =>
    activeTab === null ? undefined : store.runs[activeTab.id],
  );
  const activeVariableSet =
    variableSets.find((set) => set.id === state.activeVariableSetId) ?? null;
  const variables = useMemo(
    () => apiGatewayVariables(activeVariableSet?.variables ?? []),
    [activeVariableSet],
  );

  // A draft that says what the saved request says is no longer an edit.
  // Letting it go makes the tab follow the saved request again, including
  // changes other clients make to it. Runs when either side changes: an edit
  // typed back to what was saved, or a save coming back from the server.
  useEffect(() => {
    const store = useApiGatewayStore.getState();
    for (const tab of state.tabs) {
      const saved = tab.itemId === null ? undefined : savedRequests.get(tab.itemId);
      if (tab.draft !== null && saved !== undefined && sameRequest(tab.draft, saved.request)) {
        store.updateTab(environmentId, tab.id, { draft: null });
      }
    }
  }, [environmentId, savedRequests, state.tabs]);

  const applyOperations = useCallback(
    async (operations: ReadonlyArray<ApiGatewayOperation>, failureTitle: string) => {
      const result = await apply({ environmentId, input: { operations } });
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: failureTitle,
          description: failureMessage(result),
        });
      }
      return false;
    },
    [apply, environmentId],
  );

  /**
   * The tab as the store has it now. A keyboard shortcut can run in the same
   * event as an edit it commits, before this render has seen the edit.
   */
  const currentTab = (tabId: string) =>
    useApiGatewayStore
      .getState()
      .byEnvironment[environmentId]?.tabs.find((tab) => tab.id === tabId) ?? null;

  const send = async (tabId: string) => {
    const tab = currentTab(tabId);
    const request = tab === null ? null : requestOf(tab);
    const store = useApiGatewayStore.getState();
    if (request === null || request.url.trim() === "" || store.runs[tabId]?.phase === "sending") {
      return;
    }
    const prepared = prepareApiGatewayRequest(request, variables);
    const controller = new AbortController();
    const sending: ApiGatewayRun = { phase: "sending", cancel: () => controller.abort() };
    store.setRun(tabId, sending);
    const result = await execute({
      environmentId,
      input: { request: prepared.input, signal: controller.signal },
    });
    // A request the user stopped is not one they will want to find again.
    if (result._tag === "Success" || !isAtomCommandInterrupted(result)) {
      store.recordHistory(environmentId, {
        request,
        status: result._tag === "Success" ? result.value.status : null,
      });
    }
    // A newer send from this tab, or closing it, has taken this run's place.
    if (useApiGatewayStore.getState().runs[tabId] !== sending) return;
    store.setRun(
      tabId,
      result._tag === "Success"
        ? { phase: "done", result: result.value, unresolved: prepared.unresolved }
        : failedRun(result, prepared.unresolved),
    );
  };

  /** True when the tab holds edits that closing it, or reverting, would lose. */
  const isUnsaved = (tab: ApiGatewayTab) =>
    tab.draft !== null &&
    !sameRequest(tab.draft, savedOf(tab)?.request ?? EMPTY_API_GATEWAY_REQUEST);

  const save = async (tabId: string) => {
    const tab = currentTab(tabId);
    if (tab === null || workspace === null || !isUnsaved(tab) || tab.draft === null) return;
    const saved = savedOf(tab);
    if (saved === null) {
      setDialog({ kind: "save", tabId });
      return;
    }
    // The draft is left in place: the effect above drops it once the saved
    // request arrives back and matches, so the tab never shows the old one.
    await applyOperations(
      [{ type: "item.put", item: { ...saved, request: tab.draft } }],
      "Could not save the request",
    );
  };

  const edit = (tabId: string, request: ApiGatewayRequest) => {
    // Kept to what can be saved and stored, so a draft cannot be lost on reload.
    if (!isStorableRequest(request)) {
      toastManager.add({
        type: "error",
        title: "That is more than a request can hold",
        description:
          "A request takes a URL of up to 16,000 characters, a body of up to 2,000,000, and 500 rows in each list.",
      });
      return;
    }
    useApiGatewayStore.getState().updateTab(environmentId, tabId, { draft: request });
  };

  // Send and Save answer to the same keys wherever focus is on the page, even
  // on nothing. They are fixed keys rather than configurable keybindings:
  // nothing else on this page uses them, and mod+S has to be claimed here or
  // the browser offers to save the web page.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const action = event.key === "Enter" ? "send" : event.key.toLowerCase() === "s" ? "save" : null;
    if (action === null || event.defaultPrevented) return;
    // Dialogs and menus draw outside the page and keep their keys.
    const target = event.target;
    const onPage =
      target === document.body || (target instanceof Node && rootRef.current?.contains(target));
    if (!onPage) return;
    event.preventDefault();
    if (activeTab === null) return;
    if (action === "send") void send(activeTab.id);
    else void save(activeTab.id);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const tabLabel = (tab: ApiGatewayTab) =>
    savedOf(tab)?.name ??
    (tab.draft !== null
      ? apiGatewayRequestLabel(tab.draft)
      : items === null
        ? "Loading…"
        : "Deleted request");

  const closeTab = async (tab: ApiGatewayTab) => {
    if (
      isUnsaved(tab) &&
      !(await ensureLocalApi().dialogs.confirm(
        `Close "${tabLabel(tab)}"?\nIts unsaved changes will be lost.`,
      ))
    ) {
      return;
    }
    useApiGatewayStore.getState().closeTab(environmentId, tab.id);
  };

  const closePanelOnMobile = () => {
    if (isMobile) setPanelOpen(false);
  };

  const openBlankTab = () => {
    useApiGatewayStore
      .getState()
      .openTab(environmentId, { itemId: null, draft: EMPTY_API_GATEWAY_REQUEST });
    closePanelOnMobile();
  };

  const openRequest = (item: ApiGatewaySavedRequest) => {
    useApiGatewayStore.getState().openItem(environmentId, item.id);
    closePanelOnMobile();
  };

  const openHistory = (entry: ApiGatewayHistoryEntry) => {
    useApiGatewayStore.getState().openTab(environmentId, { itemId: null, draft: entry.request });
    closePanelOnMobile();
  };

  const createRequestIn = async (folder: ApiGatewayFolder) => {
    const id = newItemId();
    const stored = await applyOperations(
      [
        {
          type: "item.put",
          item: {
            kind: "request",
            id,
            parentId: folder.id,
            name: "New request",
            request: EMPTY_API_GATEWAY_REQUEST,
          },
        },
      ],
      "Could not create the request",
    );
    if (!stored) return;
    // Opened with a draft so the tab has something to show before the saved
    // request arrives; the two match, so the draft is dropped when it does.
    useApiGatewayStore
      .getState()
      .openTab(environmentId, { itemId: id, draft: EMPTY_API_GATEWAY_REQUEST });
    closePanelOnMobile();
  };

  const deleteItem = async (item: ApiGatewayItem) => {
    const hasContents = items?.some((candidate) => candidate.parentId === item.id) ?? false;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete "${item.name}"?\n${
        hasContents ? "Everything inside it is deleted too. " : ""
      }It is removed for every client of this environment.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    await applyOperations([{ type: "item.delete", id: item.id }], "Could not delete it");
  };

  const createFolder = (parent: ApiGatewayFolder | null, name: string) =>
    applyOperations(
      [
        {
          type: "item.put",
          item: { kind: "folder", id: newItemId(), parentId: parent?.id ?? null, name },
        },
      ],
      "Could not create it",
    );

  const renameOrMove = async (
    itemId: ApiGatewayItemId,
    name: string,
    target: ApiGatewayItemDialogTarget,
  ) => {
    const item = items?.find((candidate) => candidate.id === itemId);
    const { parentId, create } = placement(target);
    // Not offered for a request, which always sits in a folder.
    if (item === undefined || (item.kind === "request" && parentId === null)) return false;
    return applyOperations(
      [
        ...create,
        {
          type: "item.put",
          item:
            item.kind === "folder"
              ? { ...item, name, parentId }
              : { ...item, name, parentId: parentId ?? item.parentId },
        },
      ],
      "Could not save the change",
    );
  };

  const saveAs = async (tabId: string, name: string, target: ApiGatewayItemDialogTarget) => {
    const request = currentTab(tabId)?.draft ?? null;
    const { parentId, create } = placement(target);
    if (request === null || parentId === null) return false;
    const id = newItemId();
    const stored = await applyOperations(
      [...create, { type: "item.put", item: { kind: "request", id, parentId, name, request } }],
      "Could not save the request",
    );
    if (stored) useApiGatewayStore.getState().updateTab(environmentId, tabId, { itemId: id });
    return stored;
  };

  const editing =
    dialog?.kind === "edit"
      ? (items?.find((candidate) => candidate.id === dialog.itemId) ?? null)
      : null;
  // Built only while a dialog needs them: every folder's full path adds up.
  const folderOptions = useMemo(
    () =>
      items === null || (dialog?.kind !== "save" && dialog?.kind !== "edit")
        ? []
        : apiGatewayFolderOptions(
            items,
            dialog.kind === "edit" && editing?.kind === "folder" ? editing.id : undefined,
          ),
    [items, dialog, editing],
  );
  const cancelActiveRun = () => {
    if (activeRun?.phase === "sending") activeRun.cancel();
  };

  return (
    <div ref={rootRef} className="contents">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Collections and history"
                aria-pressed={panelOpen}
                onClick={() => setPanelOpen((open) => !open)}
              />
            }
          >
            <FolderTreeIcon />
          </TooltipTrigger>
          <TooltipPopup>Collections and history</TooltipPopup>
        </Tooltip>
        <WorkspaceBreadcrumb ariaLabel="API Gateway breadcrumb">
          <WorkspaceBreadcrumbItem current={props.environments.length < 2}>
            <h1>API Gateway</h1>
          </WorkspaceBreadcrumbItem>
          {props.environments.length < 2 ? null : (
            <>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current className="min-w-10">
                <Select
                  value={environmentId}
                  onValueChange={(next) => {
                    const environment = props.environments.find(
                      (candidate) => candidate.environmentId === next,
                    );
                    if (environment) {
                      useApiGatewayStore.getState().selectEnvironment(environment.environmentId);
                    }
                  }}
                >
                  <SelectTrigger size="compact" variant="ghost" aria-label="Send requests from">
                    <SelectValue>
                      {props.environments.find(
                        (candidate) => candidate.environmentId === environmentId,
                      )?.label ?? "Environment"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {props.environments.map((environment) => (
                      <SelectItem key={environment.environmentId} value={environment.environmentId}>
                        {environment.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </WorkspaceBreadcrumbItem>
            </>
          )}
        </WorkspaceBreadcrumb>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <Select
            value={activeVariableSet?.id ?? NO_VARIABLE_SET}
            onValueChange={(next) => {
              useApiGatewayStore
                .getState()
                .setActiveVariableSet(
                  environmentId,
                  variableSets.find((set) => set.id === next)?.id ?? null,
                );
            }}
          >
            <SelectTrigger
              size="compact"
              className="w-40 min-w-0"
              aria-label="Variable set to send with"
            >
              <SelectValue>{activeVariableSet?.name ?? "No variables"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={NO_VARIABLE_SET}>No variables</SelectItem>
              {variableSets.map((set) => (
                <SelectItem key={set.id} value={set.id}>
                  {set.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={workspace === null}
                  aria-label="Edit variable sets"
                  onClick={() => setDialog({ kind: "variables" })}
                />
              }
            >
              <BracesIcon />
            </TooltipTrigger>
            <TooltipPopup>Edit variable sets</TooltipPopup>
          </Tooltip>
        </div>
      </WorkspacePageHeader>

      {workspaceQuery.error === null ? null : (
        <div className="shrink-0 border-b border-border/60 p-2">
          <Alert variant="error">
            <AlertTitle>Collections and variable sets could not be loaded</AlertTitle>
            <AlertDescription>{workspaceQuery.error}</AlertDescription>
            <AlertAction>
              <Button
                type="button"
                size="compact"
                variant="outline"
                onClick={workspaceQuery.refresh}
              >
                Try again
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Hidden rather than removed, so it keeps its view and open folders. */}
        <aside
          className={cn(
            "flex min-h-0 shrink-0 flex-col border-e border-border/60",
            isMobile ? "w-full" : "w-64",
            !panelOpen && "hidden",
          )}
        >
          <ApiGatewayCollections
            items={items}
            failed={workspaceQuery.error !== null}
            history={state.history}
            activeItemId={activeTab?.itemId ?? null}
            onOpenRequest={openRequest}
            onOpenHistory={openHistory}
            onClearHistory={() => useApiGatewayStore.getState().clearHistory(environmentId)}
            onNewCollection={() => setDialog({ kind: "folder", parent: null })}
            onNewRequest={(folder) => void createRequestIn(folder)}
            onNewFolder={(parent) => setDialog({ kind: "folder", parent })}
            onEdit={(item) => setDialog({ kind: "edit", itemId: item.id })}
            onDuplicate={(item) =>
              void applyOperations(
                duplicateApiGatewayItem(items ?? [], item.id, newItemId),
                "Could not duplicate it",
              )
            }
            onDelete={(item) => void deleteItem(item)}
          />
        </aside>

        <div
          className={cn("flex min-h-0 min-w-0 flex-1 flex-col", isMobile && panelOpen && "hidden")}
        >
          <nav
            aria-label="Open requests"
            className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-2"
          >
            {state.tabs.map((tab) => {
              const label = tabLabel(tab);
              const method = requestOf(tab)?.method;
              const unsaved = isUnsaved(tab);
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "group/tab flex h-6 max-w-48 shrink-0 items-center gap-1 rounded-md ps-2 pe-1 text-xs",
                    tab.id === activeTab?.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    aria-current={tab.id === activeTab?.id ? "page" : undefined}
                    className="flex h-full min-w-0 cursor-pointer items-center gap-1.5"
                    onClick={() => useApiGatewayStore.getState().activateTab(environmentId, tab.id)}
                  >
                    {method === undefined ? null : <ApiGatewayMethodLabel method={method} short />}
                    <span className="truncate">{label}</span>
                  </button>
                  <PanelTabCloseButton
                    label={unsaved ? `Close ${label} (unsaved changes)` : `Close ${label}`}
                    onClick={() => void closeTab(tab)}
                  >
                    {unsaved ? <span className="size-1.5 rounded-full bg-current" /> : null}
                  </PanelTabCloseButton>
                </div>
              );
            })}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    className="shrink-0"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="New request"
                    onClick={openBlankTab}
                  />
                }
              >
                <PlusIcon />
              </TooltipTrigger>
              <TooltipPopup>New request</TooltipPopup>
            </Tooltip>
          </nav>

          {activeTab === null ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>Send a request</EmptyTitle>
                <EmptyDescription>
                  Requests go out from this environment&apos;s machine, so they can reach its
                  localhost and private network.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" onClick={openBlankTab}>
                  New request
                </Button>
              </EmptyContent>
            </Empty>
          ) : activeRequest === null ? (
            <Empty className="flex-1" size="compact">
              <EmptyHeader>
                <EmptyTitle>
                  {items !== null
                    ? "This request no longer exists"
                    : workspaceQuery.error !== null
                      ? "This request could not be loaded"
                      : "Loading the request…"}
                </EmptyTitle>
                {items === null ? null : (
                  <EmptyDescription>It was deleted from its collection.</EmptyDescription>
                )}
              </EmptyHeader>
              {items === null && workspaceQuery.error === null ? null : (
                <EmptyContent>
                  <Button type="button" variant="outline" onClick={() => void closeTab(activeTab)}>
                    Close tab
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          ) : (
            <>
              <div className="flex min-h-0 flex-1 basis-0 flex-col border-b border-border/60">
                <ApiGatewayRequestEditor
                  tabId={activeTab.id}
                  request={activeRequest}
                  onChange={(request) => edit(activeTab.id, request)}
                  isSending={activeRun?.phase === "sending"}
                  canSave={workspace !== null && isUnsaved(activeTab)}
                  onRevert={
                    activeSaved !== null && isUnsaved(activeTab)
                      ? () =>
                          useApiGatewayStore
                            .getState()
                            .updateTab(environmentId, activeTab.id, { draft: null })
                      : null
                  }
                  onSend={() => void send(activeTab.id)}
                  onCancel={cancelActiveRun}
                  onSave={() => void save(activeTab.id)}
                  onCopyAsCurl={() =>
                    copyToClipboard(
                      toCurlCommand(prepareApiGatewayRequest(activeRequest, variables).input),
                      undefined,
                    )
                  }
                />
              </div>
              <div className="flex min-h-0 flex-1 basis-0 flex-col">
                <ApiGatewayResponse run={activeRun} onCancel={cancelActiveRun} />
              </div>
            </>
          )}
        </div>
      </div>

      {dialog?.kind === "folder" ? (
        <ApiGatewayItemDialog
          title={dialog.parent === null ? "New collection" : `New folder in ${dialog.parent.name}`}
          submitLabel="Create"
          initialName=""
          location={null}
          onSubmit={(name) => createFolder(dialog.parent, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "edit" && editing !== null ? (
        <ApiGatewayItemDialog
          title={`Rename or move ${editing.name}`}
          submitLabel="Save"
          initialName={editing.name}
          location={{
            options: folderOptions,
            initial: editing.parentId,
            allowTopLevel: editing.kind === "folder",
          }}
          onSubmit={(name, target) => renameOrMove(editing.id, name, target)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "save" ? (
        <ApiGatewayItemDialog
          title="Save request"
          submitLabel="Save"
          initialName={apiGatewayRequestLabel(
            currentTab(dialog.tabId)?.draft ?? EMPTY_API_GATEWAY_REQUEST,
          )}
          location={{ options: folderOptions, initial: null, allowTopLevel: false }}
          onSubmit={(name, target) => saveAs(dialog.tabId, name, target)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "variables" ? (
        <ApiGatewayVariablesDialog
          variableSets={variableSets}
          initialId={state.activeVariableSetId}
          onSave={async (variableSet: ApiGatewayVariableSet) => {
            const isFirst = variableSets.length === 0;
            const stored = await applyOperations(
              [{ type: "variableSet.put", variableSet }],
              "Could not save the variable set",
            );
            // The first set someone makes is the one they mean to send with.
            if (stored && isFirst) {
              useApiGatewayStore.getState().setActiveVariableSet(environmentId, variableSet.id);
            }
            return stored;
          }}
          onDelete={async (variableSet) =>
            (await ensureLocalApi().dialogs.confirm(
              `Delete "${variableSet.name}"?\nIt is removed for every client of this environment.`,
              { variant: "destructive" },
            )) &&
            (await applyOperations(
              [{ type: "variableSet.delete", id: variableSet.id }],
              "Could not delete the variable set",
            ))
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The API Gateway page: an HTTP client whose requests are sent by an
 * environment. Unlike the other sidebar pages it does not go back on Escape:
 * it is mostly text fields, where Escape is pressed for other reasons.
 */
export function ApiGatewayPage() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selectedEnvironmentId = useApiGatewayStore((store) => store.selectedEnvironmentId);
  const supported = useMemo(
    () =>
      environments.filter(
        (environment) => environment.serverConfig?.environment.capabilities.apiGateway === true,
      ),
    [environments],
  );
  const environment =
    supported.find((candidate) => candidate.environmentId === selectedEnvironmentId) ??
    supported.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    supported[0] ??
    null;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {environment === null ? (
          <>
            <WorkspacePageHeader electron={isElectron} className="border-b border-border">
              <WorkspaceBreadcrumb ariaLabel="API Gateway breadcrumb">
                <WorkspaceBreadcrumbItem current>
                  <h1>API Gateway</h1>
                </WorkspaceBreadcrumbItem>
              </WorkspaceBreadcrumb>
            </WorkspacePageHeader>
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>API Gateway is not available yet</EmptyTitle>
                <EmptyDescription>
                  {environments.length === 0
                    ? "Connect an environment to send requests from it."
                    : `No connected environment runs a ${APP_BASE_NAME} version with API Gateway. Update ${APP_BASE_NAME} on that machine, or wait for it to finish connecting.`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </>
        ) : (
          <ApiGatewayWorkspaceView
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environments={supported}
          />
        )}
      </div>
    </SidebarInset>
  );
}
