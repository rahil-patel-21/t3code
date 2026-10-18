import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIcon,
  CheckIcon,
  FileDiffIcon,
  FileIcon,
  FilesIcon,
  GitBranchIcon,
  MessagesSquareIcon,
  SettingsIcon,
  WaypointsIcon,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useProject, useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useGitStackedAction } from "../../state/sourceControlActions";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import FileBrowserPanel from "../files/FileBrowserPanel";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebarPages } from "./SidebarChrome";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export type SidebarView = "threads" | "explorer" | "scm";

interface ThreadWorkspace {
  readonly threadRef: ScopedThreadRef;
  /** Set once the thread has started; commits carry it like the header's Git actions do. */
  readonly serverThreadId: ThreadId | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly projectName: string;
  /** Changes when a turn starts or finishes, so the file tree can pick up the agent's edits. */
  readonly turnMarker: string | null;
}

/** The folder the open thread or draft works in: its worktree, else the project root. */
function useActiveThreadWorkspace(): ThreadWorkspace | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const serverThread = useThreadShell(
    routeTarget?.kind === "server" ? routeTarget.threadRef : (draft?.promotedTo ?? null),
  );
  const source = serverThread ?? draft;
  const project = useProject(
    source ? scopeProjectRef(source.environmentId, source.projectId) : null,
  );
  const threadId = serverThread?.id ?? draft?.threadId;
  if (!source || !project || !threadId) return null;
  const latestRun = serverThread?.latestRun ?? null;
  return {
    threadRef: scopeThreadRef(source.environmentId, threadId),
    serverThreadId: serverThread?.id ?? null,
    environmentId: source.environmentId,
    projectId: source.projectId,
    cwd: source.worktreePath ?? project.workspaceRoot,
    projectName: project.title,
    turnMarker: latestRun ? `${latestRun.runId}:${latestRun.completedAt ?? ""}` : null,
  };
}

function useWorkspaceGitStatus(workspace: ThreadWorkspace | null) {
  return useEnvironmentQuery(
    workspace
      ? vcsEnvironment.status({
          environmentId: workspace.environmentId,
          input: { cwd: workspace.cwd },
        })
      : null,
  );
}

const ACTIVITY_VIEWS: ReadonlyArray<{ id: SidebarView; label: string; icon: LucideIcon }> = [
  { id: "threads", label: "Threads", icon: MessagesSquareIcon },
  { id: "explorer", label: "Explorer", icon: FilesIcon },
  { id: "scm", label: "Source Control", icon: GitBranchIcon },
];

function ActivityRailItem(props: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** Set for view switches, which toggle; page links mark the current page instead. */
  pressed?: boolean;
  badge?: number | null;
  /** A small status dot, shown when there is no count badge. */
  dot?: boolean;
  /** What the badge counts, for screen readers. */
  badgeLabel?: string | undefined;
  onClick: () => void;
}) {
  const { icon: Icon, badge = null } = props;
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={
                badge !== null
                  ? `${props.label}, ${badge} ${props.badgeLabel}`
                  : props.dot
                    ? `${props.label}, work in progress`
                    : props.label
              }
              {...(props.pressed === undefined
                ? { "aria-current": props.active ? ("page" as const) : undefined }
                : { "aria-pressed": props.pressed })}
              isActive={props.active}
              onClick={props.onClick}
              size="icon"
            />
          }
        >
          <Icon />
        </TooltipTrigger>
        <TooltipPopup side="right">{props.label}</TooltipPopup>
      </Tooltip>
      {badge === null && props.dot ? (
        <span className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-info ring-2 ring-sidebar" />
      ) : null}
      {badge === null ? null : (
        <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-3xs font-semibold tabular-nums leading-none text-primary-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </SidebarMenuItem>
  );
}

/** VS Code-style icon rail: sidebar views on top, app pages at the bottom. */
export function SidebarActivityBar(props: {
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  /** Reserves the titlebar row, where the sidebar toggle floats, above the first icon. */
  reserveTitlebar: boolean;
  isElectron: boolean;
}) {
  const workspace = useActiveThreadWorkspace();
  const changeCount = useWorkspaceGitStatus(workspace).data?.workingTree.files.length ?? 0;
  const badges: Partial<Record<SidebarView, { count: number; label: string }>> = {
    scm: { count: changeCount, label: "changed files" },
  };
  const anyThreadWorking = useThreadShells().some(
    (thread) => thread.archivedAt === null && resolveSidebarThreadStatus(thread) === "working",
  );
  const pathname = useLocation({ select: (location) => location.pathname });
  const { pullRequestsSupported, apiGatewaySupported, openPage } = useSidebarPages();

  return (
    <nav
      aria-label="Sidebar views"
      className="flex w-11 shrink-0 flex-col items-center border-e border-sidebar-border pb-1 max-md:pt-1"
    >
      {props.reserveTitlebar ? (
        <div
          aria-hidden="true"
          className={cn(
            "hidden h-[var(--workspace-topbar-height)] w-full shrink-0 md:block",
            props.isElectron && "drag-region",
          )}
        />
      ) : (
        <div aria-hidden="true" className="hidden h-1 shrink-0 md:block" />
      )}
      <SidebarMenu className="items-center">
        {ACTIVITY_VIEWS.map(({ id, label, icon }) => (
          <ActivityRailItem
            key={id}
            label={label}
            icon={icon}
            active={props.view === id}
            pressed={props.view === id}
            badge={badges[id]?.count || null}
            badgeLabel={badges[id]?.label}
            dot={id === "threads" && anyThreadWorking}
            onClick={() => props.onViewChange(id)}
          />
        ))}
        {apiGatewaySupported ? (
          <ActivityRailItem
            label="API Gateway"
            icon={WaypointsIcon}
            active={pathname === "/gateway"}
            onClick={() => openPage("api-gateway")}
          />
        ) : null}
      </SidebarMenu>
      <SidebarMenu className="mt-auto items-center">
        {pullRequestsSupported ? (
          <ActivityRailItem
            label="Pull Requests"
            icon={PullRequestGlyph.pullRequest}
            active={pathname.startsWith("/pull-requests")}
            onClick={() => openPage("pull-requests")}
          />
        ) : null}
        <ActivityRailItem
          label="Usage"
          icon={ChartNoAxesColumnIcon}
          active={pathname === "/usage"}
          onClick={() => openPage("usage")}
        />
        <SidebarUpdatePill placement="rail" />
        <ActivityRailItem
          label="Settings"
          icon={SettingsIcon}
          active={false}
          onClick={() => openPage("settings")}
        />
      </SidebarMenu>
    </nav>
  );
}

function SidebarViewHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 ps-3 pe-2">
      <h2 className="min-w-0 flex-1 truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </div>
  );
}

function SidebarViewMessage({ children }: { children: ReactNode }) {
  return <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

export function SidebarExplorerView() {
  const { workspace, options, openThreadKey, selectedKey, select } = usePickedProjectWorkspace();
  const navigate = useNavigate();
  const picker = (
    <SidebarProjectPicker options={options} selectedKey={selectedKey} onSelect={select} />
  );
  if (!workspace) {
    return (
      <>
        <SidebarViewHeader title="Explorer" />
        {picker}
        <SidebarViewMessage>
          Open a thread or choose a project to browse its files.
        </SidebarViewMessage>
      </>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pt-2">{picker}</div>
      <FileBrowserPanel
        key={`${workspace.environmentId}:${workspace.cwd}`}
        environmentId={workspace.environmentId}
        cwd={workspace.cwd}
        projectName={workspace.projectName}
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={(relativePath) => {
          useRightPanelStore.getState().openFile(workspace.threadRef, relativePath);
          // A picked project's file opens in its newest thread, so go there.
          if (scopedThreadKey(workspace.threadRef) !== openThreadKey) {
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(workspace.threadRef),
            });
          }
        }}
        workspaceMutationId={workspace.turnMarker}
      />
    </div>
  );
}

const projectKeyOf = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `${environmentId}:${projectId}`;

/**
 * Explorer, Source Control, and Agents follow the open thread until another project is
 * picked; the pick lasts until a different thread opens. A picked project shows its root
 * checkout, and its newest thread hosts the diff when a file is opened.
 *
 * ponytail: projects without a thread are not offered, since the diff needs a
 * thread to open in.
 */
function usePickedProjectWorkspace() {
  const openWorkspace = useActiveThreadWorkspace();
  const projects = useProjects();
  const threads = useThreadShells();
  const openThreadKey = openWorkspace ? scopedThreadKey(openWorkspace.threadRef) : null;
  const [pick, setPick] = useState<{ projectKey: string; openThreadKey: string | null } | null>(
    null,
  );
  const openProjectKey = openWorkspace
    ? projectKeyOf(openWorkspace.environmentId, openWorkspace.projectId)
    : null;
  const pickedProjectKey =
    pick && pick.openThreadKey === openThreadKey ? pick.projectKey : openProjectKey;

  const options = useMemo(() => {
    const newestThreadByProject = new Map<string, (typeof threads)[number]>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const key = projectKeyOf(thread.environmentId, thread.projectId);
      const current = newestThreadByProject.get(key);
      if (!current || thread.updatedAt > current.updatedAt) newestThreadByProject.set(key, thread);
    }
    return projects.flatMap((project) => {
      const key = projectKeyOf(project.environmentId, project.id);
      const thread = newestThreadByProject.get(key);
      return thread ? [{ key, project, thread }] : [];
    });
  }, [projects, threads]);

  let workspace: ThreadWorkspace | null = openWorkspace;
  if (pickedProjectKey !== openProjectKey) {
    const option = options.find((candidate) => candidate.key === pickedProjectKey);
    workspace = option
      ? {
          threadRef: scopeThreadRef(option.thread.environmentId, option.thread.id),
          // Commits from here are not attributed to a thread the user is not viewing.
          serverThreadId: null,
          environmentId: option.project.environmentId,
          projectId: option.project.id,
          cwd: option.project.workspaceRoot,
          projectName: option.project.title,
          turnMarker: null,
        }
      : openWorkspace;
  }

  return {
    workspace,
    options,
    openThreadKey,
    selectedKey: workspace ? projectKeyOf(workspace.environmentId, workspace.projectId) : null,
    select: (projectKey: string) => setPick({ projectKey, openThreadKey }),
  };
}

function SidebarProjectPicker(props: {
  options: ReadonlyArray<{ key: string; project: { title: string } }>;
  selectedKey: string | null;
  onSelect: (projectKey: string) => void;
}) {
  const selected = props.options.find((option) => option.key === props.selectedKey);
  if (props.options.length < 2 && selected) return null;
  return (
    <div className="shrink-0 px-3 pb-2">
      <Select
        value={props.selectedKey}
        onValueChange={(value) => {
          if (value) props.onSelect(value);
        }}
      >
        <SelectTrigger size="compact" aria-label="Project">
          <SelectValue>{selected?.project.title ?? "Choose a project"}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {props.options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.project.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function SidebarSourceControlView() {
  const { workspace, options, openThreadKey, selectedKey, select } = usePickedProjectWorkspace();
  const picker = (
    <SidebarProjectPicker options={options} selectedKey={selectedKey} onSelect={select} />
  );
  if (!workspace) {
    return (
      <>
        <SidebarViewHeader title="Source Control" />
        {picker}
        <SidebarViewMessage>
          Open a thread or choose a project to see its changes.
        </SidebarViewMessage>
      </>
    );
  }
  return (
    <SourceControlChanges
      key={`${workspace.environmentId}:${workspace.cwd}`}
      workspace={workspace}
      openThreadKey={openThreadKey}
      picker={picker}
    />
  );
}

// Status enumerates every untracked file (`git status -uall`), so the cost of a tick scales with
// the untracked tree rather than the changed one. Ten seconds keeps a large untracked directory
// from re-walking on every tick; focus and visibility changes still refresh immediately.
const LOCAL_STATUS_POLL_MS = 10_000;
const LOCAL_STATUS_RETRY_MS = 15_000;

/**
 * Keeps the change list near live while the view is open, including edits made
 * outside T3 Code. Only the working tree is re-read, and the server pushes an
 * update only when it differs, so an idle poll re-renders nothing.
 */
function useLiveLocalStatus(environmentId: EnvironmentId, cwd: string) {
  const refreshLocalStatus = useAtomCommand(vcsEnvironment.refreshLocalStatus, {
    reportFailure: false,
  });
  useEffect(() => {
    let timer: number | null = null;
    let stopped = false;
    const tick = async () => {
      timer = null;
      let delay = LOCAL_STATUS_POLL_MS;
      if (document.visibilityState === "visible") {
        const result = await refreshLocalStatus({ environmentId, input: { cwd } });
        // Older servers lack the method; back off instead of retrying every tick.
        if (result._tag !== "Success") delay = LOCAL_STATUS_RETRY_MS;
      }
      if (!stopped) timer = window.setTimeout(tick, delay);
    };
    // Coming back to the window refreshes at once; a tick in flight already will.
    const refreshNow = () => {
      if (timer === null || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void tick();
    };
    void tick();
    window.addEventListener("focus", refreshNow);
    document.addEventListener("visibilitychange", refreshNow);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", refreshNow);
      document.removeEventListener("visibilitychange", refreshNow);
    };
  }, [cwd, environmentId, refreshLocalStatus]);
}

function SourceControlChanges({
  workspace,
  openThreadKey,
  picker,
}: {
  workspace: ThreadWorkspace;
  /** The thread on screen; a picked project's newest thread may differ. */
  openThreadKey: string | null;
  picker: ReactNode;
}) {
  const navigate = useNavigate();
  const status = useWorkspaceGitStatus(workspace);
  useLiveLocalStatus(workspace.environmentId, workspace.cwd);
  const scope = useMemo(
    () => ({ environmentId: workspace.environmentId, cwd: workspace.cwd }),
    [workspace.environmentId, workspace.cwd],
  );
  const commit = useGitStackedAction(scope);
  const [message, setMessage] = useState("");
  const files = status.data?.workingTree.files ?? [];
  const canCommit = files.length > 0 && !commit.isPending;

  // The working tree diff takes the whole chat column, scrolled to `filePath` when given.
  const openWorkingTreeDiff = (filePath?: string) => {
    useDiffPanelStore.getState().revealUncommitted(workspace.threadRef, filePath);
    const rightPanel = useRightPanelStore.getState();
    rightPanel.open(workspace.threadRef, "diff");
    rightPanel.setMaximized(workspace.threadRef, true);
    showThread();
  };

  // A picked project's diff or file opens in its newest thread, so go there.
  const showThread = () => {
    if (scopedThreadKey(workspace.threadRef) === openThreadKey) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(workspace.threadRef),
    });
  };

  const runCommit = async () => {
    if (!canCommit) return;
    const commitMessage = message.trim();
    // An empty message lets the server write one, as the header's Commit does.
    const result = await commit.run({
      actionId: randomUUID(),
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(workspace.serverThreadId ? { threadId: workspace.serverThreadId } : {}),
    });
    if (result._tag === "Success") {
      setMessage("");
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Commit failed",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarViewHeader title="Source Control">
        {files.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Open changes"
                  onClick={() => openWorkingTreeDiff()}
                />
              }
            >
              <FileDiffIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Open changes</TooltipPopup>
          </Tooltip>
        ) : null}
      </SidebarViewHeader>
      {picker}
      {!status.data ? (
        <SidebarViewMessage>Loading changes…</SidebarViewMessage>
      ) : !status.data.isRepo ? (
        <SidebarViewMessage>This folder is not a Git repository.</SidebarViewMessage>
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-2 px-3 pb-3">
            <Textarea
              size="sm"
              rows={2}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void runCommit();
                }
              }}
              placeholder={`Message (${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+"}Enter to commit on "${status.data.refName ?? "HEAD"}"). Empty writes one for you.`}
              aria-label="Commit message"
            />
            <div className="grid">
              <Button
                type="button"
                size="sm"
                disabled={!canCommit}
                onClick={() => void runCommit()}
              >
                {commit.isPending ? <Spinner /> : <CheckIcon />}
                Commit
              </Button>
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-between px-3 pb-1 text-xs font-medium text-muted-foreground">
            <span>Changes</span>
            <span className="tabular-nums">{files.length}</span>
          </div>
          {files.length === 0 ? (
            <SidebarViewMessage>No changes.</SidebarViewMessage>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {files.map((file) => {
                const slash = file.path.lastIndexOf("/");
                return (
                  <li key={file.path} className="group/scm-file relative flex items-center">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 ps-1.5 pe-8 text-left text-xs hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openWorkingTreeDiff(file.path)}
                    >
                      <span className="shrink-0 font-medium text-foreground">
                        {file.path.slice(slash + 1)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {slash > 0 ? file.path.slice(0, slash) : ""}
                      </span>
                      {file.untracked ? (
                        <span className="shrink-0 font-mono text-2xs text-diff-addition">New</span>
                      ) : (
                        <DiffStatLabel
                          additions={file.insertions}
                          deletions={file.deletions}
                          layout="inline"
                          className="shrink-0 text-2xs"
                        />
                      )}
                    </button>
                    <div className="absolute end-1 hidden group-hover/scm-file:flex">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={`Open ${file.path}`}
                              onClick={() => {
                                useRightPanelStore
                                  .getState()
                                  .openFile(workspace.threadRef, file.path);
                                showThread();
                              }}
                            />
                          }
                        >
                          <FileIcon className="size-3" />
                        </TooltipTrigger>
                        <TooltipPopup side="top">Open file</TooltipPopup>
                      </Tooltip>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
