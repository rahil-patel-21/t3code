import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentSessionProjectSession, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { agentSessionImport, agentSessionProjectSessions } from "~/state/agentSessions";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { toastManager } from "../ui/toast";

const FOCUS_REFRESH_MIN_AGE_MS = 10_000;

const SOURCE_LABEL = { claudeAgent: "Claude", codex: "Codex" } as const;

/**
 * Claude Code / Codex sessions run in a terminal for the active project that T3
 * has not caught up with: new ones to import, imported ones with new messages
 * to sync. Rechecked every couple of minutes and when the window regains focus;
 * hidden when up to date.
 */
export function CliSessionsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}) {
  const query = useEnvironmentQuery(
    agentSessionProjectSessions({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const importSession = useAtomCommand(agentSessionImport, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const { refresh } = query;
  const latestRef = useRef({ updatedAt: query.dataUpdatedAt, pending: query.isPending });
  useEffect(() => {
    latestRef.current = { updatedAt: query.dataUpdatedAt, pending: query.isPending };
  });

  // Listing reads transcripts server-side, so rapid window switching reuses a fresh result
  // and never stacks a second listing behind one still running.
  useEffect(() => {
    const onFocus = () => {
      const { updatedAt, pending } = latestRef.current;
      if (!pending && Date.now() - (updatedAt ?? 0) > FOCUS_REFRESH_MIN_AGE_MS) refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const sessions = query.data?.sessions ?? [];
  if (sessions.length === 0) return null;
  const updateCount = sessions.filter((session) => session.state === "updated").length;

  const run = async (session: AgentSessionProjectSession) => {
    setBusyIds((current) => new Set(current).add(session.providerSessionId));
    const result = await importSession({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        expectedWorkspaceRoot: props.workspaceRoot,
        providerSessionIds: [session.providerSessionId],
      },
    });
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(session.providerSessionId);
      return next;
    });
    if (result._tag === "Success" && result.value.importedCount === 0) {
      // The server skips transcripts it cannot read or that exceed its import limits.
      toastManager.add({
        type: "warning",
        title:
          session.state === "available" ? "Session was not imported" : "Session was not synced",
        description: "Its transcript could not be read. Try again after the session is idle.",
      });
    } else if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title:
          session.state === "available" ? "Could not import session" : "Could not sync session",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
    refresh();
  };

  return (
    <div className="mb-1 px-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0", expanded && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate">Terminal sessions</span>
        <span className="shrink-0 tabular-nums">
          {updateCount > 0 ? `${updateCount} updated · ` : ""}
          {sessions.length}
        </span>
      </button>
      {expanded && (
        <ul className="flex flex-col gap-px">
          {sessions.map((session) => {
            const busy = busyIds.has(session.providerSessionId);
            return (
              <li
                key={session.threadId}
                className="flex h-8 items-center gap-2 rounded-md pr-1 pl-6 text-xs hover:bg-sidebar-row-hover"
              >
                <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                  {session.title}
                </span>
                <span className="shrink-0 text-sidebar-muted-foreground">
                  {SOURCE_LABEL[session.source]} · {formatRelativeTimeLabel(session.updatedAt)}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(session)}
                  className="shrink-0 cursor-pointer rounded border border-sidebar-border px-1.5 py-0.5 text-2xs font-medium text-sidebar-foreground hover:bg-sidebar-row-hover disabled:pointer-events-none disabled:opacity-60"
                >
                  {session.state === "updated"
                    ? busy
                      ? "Syncing…"
                      : `Sync ${session.newMessageCount}`
                    : busy
                      ? "Importing…"
                      : "Import"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
