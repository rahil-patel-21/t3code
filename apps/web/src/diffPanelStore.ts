import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * The diff panel has one view: uncommitted working-tree changes. `filePath`
 * scrolls that view to a file; `revealRequestId` counts reveals so the viewer
 * re-scrolls when the same file is revealed twice.
 */
export interface DiffPanelSelection {
  readonly kind: "unstaged";
  readonly filePath?: string;
  readonly revealRequestId?: number;
}

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "unstaged" };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  /** Opens the panel, optionally scrolling the working tree view to `filePath`. */
  revealUncommitted: (ref: ScopedThreadRef, filePath?: string) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      revealUncommitted: (ref, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: filePath
                ? {
                    kind: "unstaged",
                    filePath,
                    revealRequestId: (previous?.revealRequestId ?? 0) + 1,
                  }
                : { kind: "unstaged" },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      // v3 drops the persisted branch-range base refs and turn selections; the
      // stored shape no longer matches, so v2 state is discarded.
      version: 3,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}
