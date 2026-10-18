import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() => useDiffPanelStore.setState({ byThreadKey: {} }));

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
