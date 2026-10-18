import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { agentSessionImport, agentSessionRescan } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";

interface ImportTarget {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

function pluralSessions(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

/**
 * Imports Claude Code and Codex sessions run outside T3 Code (in a terminal)
 * into the given projects. Each environment is rescanned first because the
 * server imports from its latest scan, which misses sessions started since.
 * Already imported sessions are skipped server-side, so this is safe to repeat.
 */
export function useImportTerminalSessions() {
  const rescan = useAtomCommand(agentSessionRescan, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const [isImporting, setIsImporting] = useState(false);
  const importingRef = useRef(false);

  const importSessions = useCallback(
    async (projects: ReadonlyArray<ImportTarget>) => {
      if (importingRef.current || projects.length === 0) return;
      importingRef.current = true;
      setIsImporting(true);
      // `importedCount` also counts sessions imported earlier, so report what was found.
      let found = 0;
      let skipped = 0;
      let failure: unknown = null;
      try {
        const scanned = new Map<EnvironmentId, boolean>();
        for (const project of projects) {
          let scanOk = scanned.get(project.environmentId);
          if (scanOk === undefined) {
            const scan = await rescan({ environmentId: project.environmentId, input: {} });
            scanOk = scan._tag === "Success";
            if (scan._tag === "Failure" && !isAtomCommandInterrupted(scan)) {
              failure ??= squashAtomCommandFailure(scan);
            }
            scanned.set(project.environmentId, scanOk);
          }
          if (!scanOk) continue;
          const result = await importThreads({
            environmentId: project.environmentId,
            input: { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
          });
          if (result._tag === "Success") {
            found += result.value.importedCount;
            skipped += result.value.skippedCount;
          } else if (!isAtomCommandInterrupted(result)) {
            failure ??= squashAtomCommandFailure(result);
          }
        }
      } finally {
        importingRef.current = false;
        setIsImporting(false);
      }

      if (failure !== null) {
        toastManager.add({
          type: "error",
          title: "Could not import terminal sessions",
          description: failure instanceof Error ? failure.message : "An error occurred.",
        });
      } else if (skipped > 0) {
        toastManager.add({
          type: "warning",
          title: `${pluralSessions(skipped)} could not be imported`,
          description: "Unreadable sessions are skipped. Import again to continue a large batch.",
        });
      } else if (found === 0) {
        toastManager.add({
          type: "info",
          title: "No terminal sessions found",
          description: "Claude Code and Codex have no sessions here from the last 30 days.",
        });
      } else {
        toastManager.add({
          type: "success",
          title: "Terminal sessions imported",
          description: `Found ${pluralSessions(found)} from the last 30 days.`,
        });
      }
    },
    [importThreads, rescan],
  );

  return { importSessions, isImporting };
}
