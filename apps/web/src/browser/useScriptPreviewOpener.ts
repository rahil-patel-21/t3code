import type { ProjectScript, ScopedThreadRef } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useCallback, useEffect, useRef, useState } from "react";

import { readLocalApi } from "~/localApi";
import { useDiscoveredPortsState } from "~/portDiscoveryState";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { canOpenLinksInApp } from "./browserLinkTarget";
import { openUrlInPreview } from "./openFileInPreview";

interface PendingPreview {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly port: number;
  readonly target: "app" | "browser";
}

// Stop waiting (and stop the server probing the URL) if the server never comes up.
const PENDING_PREVIEW_TIMEOUT_MS = 2 * 60_000;

function urlPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Opens a script's `previewUrl` (when `autoOpenPreview` is set) in the in-app
 * preview or the system browser. Local URLs wait until port discovery sees the
 * server listening, so the page does not load before the dev server is up.
 */
export function useScriptPreviewOpener(): (
  threadRef: ScopedThreadRef,
  script: ProjectScript,
) => void {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const discovery = useDiscoveredPortsState(
    pending?.threadRef.environmentId ?? null,
    pending ? [pending.url] : undefined,
  );

  const open = useCallback(
    async (preview: Omit<PendingPreview, "port">) => {
      if (preview.target === "app" && canOpenLinksInApp(preview.threadRef)) {
        const result = await openUrlInPreview({
          threadRef: preview.threadRef,
          url: preview.url,
          openPreview,
        });
        if (result._tag === "Success") return;
      }
      await readLocalApi()?.shell.openExternal(preview.url);
    },
    [openPreview],
  );
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    if (!pending || !discovery.servers.some((server) => server.port === pending.port)) return;
    setPending(null);
    void openRef.current(pending);
  }, [discovery.servers, pending]);

  useEffect(() => {
    if (!pending) return;
    const timeout = window.setTimeout(() => setPending(null), PENDING_PREVIEW_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [pending]);

  return useCallback((threadRef, script) => {
    if (!script.previewUrl || !script.autoOpenPreview) return;
    const target = script.previewTarget ?? "app";
    let url: URL;
    try {
      url = new URL(script.previewUrl);
    } catch {
      return;
    }
    // ponytail: only one pending preview; a newer run replaces it.
    if (isLoopbackHost(url.hostname)) {
      setPending({ threadRef, url: url.href, port: urlPort(url), target });
      return;
    }
    void openRef.current({ threadRef, url: url.href, target });
  }, []);
}
