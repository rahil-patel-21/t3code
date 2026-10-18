import { API_GATEWAY_URL_SCHEME } from "@t3tools/client-runtime/api-gateway";
import type {
  ApiGatewayFolder,
  ApiGatewayItem,
  ApiGatewayItemId,
  ApiGatewaySavedRequest,
} from "@t3tools/contracts";
import { ChevronRightIcon, EllipsisIcon, FolderPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ApiGatewayHistoryEntry } from "~/apiGatewayStore";
import { cn } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";

import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { apiGatewayStatusTone, apiGatewayTreeRows } from "./apiGateway.logic";
import { API_GATEWAY_TONE_TEXT, ApiGatewayMethodLabel } from "./ApiGatewayMethodLabel";

type ItemAction = "new-request" | "new-folder" | "edit" | "duplicate" | "delete";

export interface ApiGatewayCollectionsProps {
  /** Null until the environment has sent its workspace. */
  readonly items: ReadonlyArray<ApiGatewayItem> | null;
  /** True when the workspace could not be loaded. The page says why. */
  readonly failed: boolean;
  readonly history: ReadonlyArray<ApiGatewayHistoryEntry>;
  /** The saved request open in the focused tab, highlighted in the tree. */
  readonly activeItemId: ApiGatewayItemId | null;
  readonly onOpenRequest: (item: ApiGatewaySavedRequest) => void;
  readonly onOpenHistory: (entry: ApiGatewayHistoryEntry) => void;
  readonly onClearHistory: () => void;
  readonly onNewCollection: () => void;
  readonly onNewRequest: (folder: ApiGatewayFolder) => void;
  readonly onNewFolder: (folder: ApiGatewayFolder) => void;
  readonly onEdit: (item: ApiGatewayItem) => void;
  readonly onDuplicate: (item: ApiGatewayItem) => void;
  readonly onDelete: (item: ApiGatewayItem) => void;
}

const ROW_CLASS =
  "group/row flex h-7 w-full items-center gap-1 rounded-md pe-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground";

/** Saved requests by collection, and this client's history of sent ones. */
export function ApiGatewayCollections(props: ApiGatewayCollectionsProps) {
  const [view, setView] = useState<"collections" | "history">("collections");
  const [collapsed, setCollapsed] = useState<ReadonlySet<ApiGatewayItemId>>(() => new Set());
  const rows = useMemo(
    () => (props.items === null ? [] : apiGatewayTreeRows(props.items, collapsed)),
    [props.items, collapsed],
  );

  const toggleFolder = (id: ApiGatewayItemId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const showItemMenu = async (item: ApiGatewayItem, position: { x: number; y: number }) => {
    const action = await ensureLocalApi().contextMenu.show<ItemAction>(
      [
        ...(item.kind === "folder"
          ? [
              { id: "new-request" as const, label: "New request" },
              { id: "new-folder" as const, label: "New folder", icon: "folder" },
            ]
          : []),
        {
          id: "edit",
          label: "Rename or move…",
          icon: "pencil",
          separatorBefore: item.kind === "folder",
        },
        { id: "duplicate", label: "Duplicate", icon: "copy" },
        { id: "delete", label: "Delete", icon: "trash", destructive: true, separatorBefore: true },
      ],
      position,
    );
    if (action === "edit") props.onEdit(item);
    else if (action === "duplicate") props.onDuplicate(item);
    else if (action === "delete") props.onDelete(item);
    else if (item.kind === "folder" && action === "new-request") props.onNewRequest(item);
    else if (item.kind === "folder" && action === "new-folder") props.onNewFolder(item);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <ToggleGroup
          aria-label="Side panel view"
          value={[view]}
          onValueChange={(next) => {
            if (next[0] === "collections" || next[0] === "history") setView(next[0]);
          }}
        >
          <Toggle value="collections">Collections</Toggle>
          <Toggle value="history">History</Toggle>
        </ToggleGroup>
        {view === "collections" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  className="ml-auto"
                  size="icon-sm"
                  variant="ghost"
                  disabled={props.items === null}
                  onClick={props.onNewCollection}
                  aria-label="New collection"
                />
              }
            >
              <FolderPlusIcon />
            </TooltipTrigger>
            <TooltipPopup>New collection</TooltipPopup>
          </Tooltip>
        ) : (
          <Button
            type="button"
            className="ml-auto"
            size="compact"
            variant="ghost"
            disabled={props.history.length === 0}
            onClick={props.onClearHistory}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {view === "collections" ? (
          rows.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {props.items !== null
                ? "No collections yet. Create one to keep requests you want to run again."
                : props.failed
                  ? "Collections could not be loaded."
                  : "Loading collections…"}
            </p>
          ) : (
            // ponytail: every row is drawn. Virtualize if collections near the
            // 2,000-item limit are ever slow to switch tabs with.
            rows.map(({ item, depth }) => (
              <div
                key={item.id}
                className={cn(
                  ROW_CLASS,
                  item.id === props.activeItemId && "bg-accent text-foreground hover:bg-accent",
                )}
                style={{ paddingInlineStart: 6 + depth * 12 }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void showItemMenu(item, { x: event.clientX, y: event.clientY });
                }}
              >
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                  aria-current={item.id === props.activeItemId ? true : undefined}
                  aria-expanded={item.kind === "folder" ? !collapsed.has(item.id) : undefined}
                  onClick={() =>
                    item.kind === "folder" ? toggleFolder(item.id) : props.onOpenRequest(item)
                  }
                >
                  {item.kind === "folder" ? (
                    <ChevronRightIcon
                      className={cn("size-3 shrink-0", !collapsed.has(item.id) && "rotate-90")}
                    />
                  ) : (
                    <ApiGatewayMethodLabel
                      method={item.request.method}
                      short
                      className="w-8 shrink-0"
                    />
                  )}
                  <span className={cn("truncate", depth === 0 && "font-medium text-foreground")}>
                    {item.name}
                  </span>
                </button>
                <button
                  type="button"
                  className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-0 pointer-coarse:opacity-100 hover:bg-muted focus-visible:opacity-100 group-hover/row:opacity-100"
                  aria-label={`Actions for ${item.name}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    void showItemMenu(item, { x: rect.left, y: rect.bottom });
                  }}
                >
                  <EllipsisIcon className="size-3.5" />
                </button>
              </div>
            ))
          )
        ) : props.history.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Requests you send from this device are listed here.
          </p>
        ) : (
          props.history.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={cn(ROW_CLASS, "cursor-pointer gap-1.5 ps-1.5 pe-2")}
              onClick={() => props.onOpenHistory(entry)}
            >
              <ApiGatewayMethodLabel
                method={entry.request.method}
                short
                className="w-8 shrink-0 text-left"
              />
              <span className="min-w-0 flex-1 truncate text-left font-mono">
                {entry.request.url.replace(API_GATEWAY_URL_SCHEME, "")}
              </span>
              <span
                className={cn(
                  "shrink-0 text-2xs tabular-nums",
                  API_GATEWAY_TONE_TEXT[
                    entry.status === null ? "muted" : apiGatewayStatusTone(entry.status)
                  ],
                )}
              >
                {entry.status ?? "failed"}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
