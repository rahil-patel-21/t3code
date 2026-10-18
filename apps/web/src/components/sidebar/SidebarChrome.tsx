import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon, WaypointsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments, usePullRequestsSupported } from "../../state/environments";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

function useSidebarPillLabel() {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  return environmentIdentificationMode === "pill"
    ? resolveEnvironmentIdentificationPillLabel(stageLabel)
    : null;
}

/**
 * Beside the activity rail the header band only holds the phone sheet's close button and the
 * optional environment pill. On desktop without the pill it is empty, so the rail and panel
 * start at the top and the toggle button floats over the rail's first row.
 */
export function useSidebarHeaderBand() {
  return useSidebarPillLabel() !== null;
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  collapseOnDesktop = false,
}: {
  isElectron: boolean;
  collapseOnDesktop?: boolean;
}) {
  const pillLabel = useSidebarPillLabel();

  // ponytail: plain header by choice, no wordmark or stage artwork.
  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        collapseOnDesktop && !pillLabel && "md:hidden",
        isElectron && "drag-region",
      )}
    >
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      {pillLabel ? (
        <Badge
          className="ml-1 hidden md:ml-[var(--workspace-titlebar-content-left)] @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </div>
  );
});

export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandMark onBackdrop={false} />
      </div>
    </div>
  );
}

function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
      <span
        className={cn(
          "truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Code
      </span>
    </span>
  );
}
function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export type SidebarPage = "settings" | "usage" | "pull-requests" | "api-gateway";

/** Opens the app's own pages from the footer menu or the icon rail, closing the phone sheet first. */
export function useSidebarPages() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = usePullRequestsSupported();
  // Requests are sent by a server, so the page needs one that can.
  const apiGatewaySupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.apiGateway === true,
  );
  const openPage = (page: SidebarPage) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (page === "pull-requests") {
      void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
    } else if (page === "api-gateway") {
      void navigate({ to: "/gateway" });
    } else {
      void navigate({ to: page === "settings" ? "/settings" : "/usage" });
    }
  };
  return { pullRequestsSupported, apiGatewaySupported, openPage };
}

/** `activityRail`: the sidebar's icon rail holds the page links and update control. */
export const SidebarUtilityMenu = memo(function SidebarUtilityMenu({
  activityRail = false,
}: {
  activityRail?: boolean;
}) {
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const { pullRequestsSupported, apiGatewaySupported, openPage } = useSidebarPages();

  const handleBackClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigateToMainApp();
  };

  if (activityRail && !isOnUtilityPage) return null;

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={() => openPage("settings")}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={() => openPage("pull-requests")}
            />
          ) : null}
          {apiGatewaySupported ? (
            <SidebarUtilityItem
              icon={<WaypointsIcon />}
              label="API Gateway"
              onClick={() => openPage("api-gateway")}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={() => openPage("usage")}
          />
        </>
      )}
      {activityRail ? null : <SidebarUpdatePill />}
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  activityRail = false,
}: {
  activityRail?: boolean;
}) {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu activityRail={activityRail} />
    </SidebarFooter>
  );
});
