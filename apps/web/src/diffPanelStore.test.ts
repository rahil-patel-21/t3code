import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({ byThreadKey: {} });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });

  it("persists selection while fold changes and no-op unfolds never write to storage", async () => {
    const { storage, name } = useDiffPanelStore.persist.getOptions();
    if (!storage || !name) throw new Error("Diff panel persistence storage is unavailable.");
    const setItem = vi.spyOn(storage, "setItem");
    try {
      useDiffPanelStore.getState().revealUncommitted(THREAD_REF, "src/app.ts");
      expect(setItem).toHaveBeenCalledOnce();
      const beforeFolding = await storage.getItem(name);
      expect(beforeFolding).toMatchObject({
        state: { byThreadKey: useDiffPanelStore.getState().byThreadKey },
      });
      setItem.mockClear();

      const scopeKey = "environment-1:thread-1:branch";
      useDiffPanelSessionStore
        .getState()
        .updateCollapsedFileKeys(scopeKey, new Set(), () => new Set(["src/app.ts"]));
      useDiffPanelSessionStore
        .getState()
        .updateCollapsedFileKeys(scopeKey, new Set(), (current) => current);

      expect(setItem).not.toHaveBeenCalled();
      const persisted = await storage.getItem(name);
      expect(persisted).toEqual(beforeFolding);
      expect(persisted?.state).not.toHaveProperty("collapsedFileKeysByScopeKey");
    } finally {
      setItem.mockRestore();
    }
  });

  it("defaults each thread to the uncommitted view", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });
  });

  it("defaults to the uncommitted view before a thread is selected", () => {
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, null)).toEqual({
      kind: "unstaged",
    });
  });

  it("clears any remembered file when the panel is opened without one", () => {
    const store = useDiffPanelStore.getState();
    store.revealUncommitted(THREAD_REF, "update.md");
    store.revealUncommitted(THREAD_REF);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });
  });

  it("re-reveals a working tree file each time it is requested", () => {
    const store = useDiffPanelStore.getState();
    store.revealUncommitted(THREAD_REF, "update.md");
    store.revealUncommitted(THREAD_REF, "update.md");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged", filePath: "update.md", revealRequestId: 2 });
  });

  it("keeps each thread's revealed file independent", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.revealUncommitted(THREAD_REF, "src/app.ts");
    store.revealUncommitted(otherThreadRef, "src/index.ts");

    const { byThreadKey } = useDiffPanelStore.getState();
    expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF)).toEqual({
      kind: "unstaged",
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
    expect(selectThreadDiffPanelSelection(byThreadKey, otherThreadRef)).toEqual({
      kind: "unstaged",
      filePath: "src/index.ts",
      revealRequestId: 1,
    });
  });

  it("forgets a removed thread's selection", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.revealUncommitted(THREAD_REF, "src/app.ts");
    store.revealUncommitted(otherThreadRef, "src/index.ts");

    store.removeThread(THREAD_REF);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, otherThreadRef),
    ).toEqual({ kind: "unstaged", filePath: "src/index.ts", revealRequestId: 1 });
  });
});
