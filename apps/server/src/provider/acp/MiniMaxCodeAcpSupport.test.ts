import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  buildMiniMaxCodeAcpSpawnInput,
  currentMiniMaxCodeModelIdFromConfigOptions,
  isValidMiniMaxCodeThinkingEffort,
  miniMaxCodeAcpSpawnArgs,
  miniMaxCodeModelIdsFromConfigOptions,
  normalizeMiniMaxCodeThinkingEffort,
  resolveMiniMaxCodeAcpBaseModelId,
  resolveMiniMaxCodePermissionMode,
} from "./MiniMaxCodeAcpSupport.ts";

/**
 * Captured from `mcode acp` 0.5.5 `session/new`. The agent returns models, reasoning effort
 * and permission mode as session config options rather than an ACP `models` block.
 */
const THINKING_MODEL_CONFIG_OPTIONS = [
  {
    type: "select",
    id: "permissionMode",
    name: "Permission mode",
    category: "_permission",
    currentValue: "bypassPermissions",
    options: [
      { value: "default", name: "Ask" },
      { value: "auto", name: "Auto" },
      { value: "bypassPermissions", name: "Full access" },
    ],
    _meta: { "minimax-code/scope": "process" },
  },
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking",
    options: [
      { value: "m:minimax:MiniMax-M3.1-Flash-Preview:v:", name: "M3.1-Flash-Preview" },
      {
        value: "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking",
        name: "M3.1-Flash-Preview · thinking",
      },
      { value: "m:minimax:MiniMax-M3:v:", name: "M3" },
      { value: "m:minimax:MiniMax-M3:v:thinking", name: "M3 · thinking" },
    ],
  },
  {
    type: "select",
    id: "thinkingEffort",
    name: "Thinking effort",
    category: "thought_level",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Xhigh" },
      { value: "max", name: "Max" },
    ],
  },
] as const satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("resolveMiniMaxCodePermissionMode", () => {
  it("maps every T3 runtime mode onto a policy the CLI advertises", () => {
    expect(resolveMiniMaxCodePermissionMode("full-access")).toBe("bypassPermissions");
    expect(resolveMiniMaxCodePermissionMode("auto")).toBe("auto");
  });

  it("collapses both asking modes onto Ask, because the CLI has no accept-edits policy", () => {
    expect(resolveMiniMaxCodePermissionMode("approval-required")).toBe("default");
    expect(resolveMiniMaxCodePermissionMode("auto-accept-edits")).toBe("default");
  });

  it("defaults to Ask when T3 has no runtime mode yet", () => {
    expect(resolveMiniMaxCodePermissionMode(undefined)).toBe("default");
  });
});

describe("miniMaxCodeAcpSpawnArgs", () => {
  it("passes no flags, because mcode acp accepts none", () => {
    expect(miniMaxCodeAcpSpawnArgs()).toEqual(["acp"]);
  });
});

describe("buildMiniMaxCodeAcpSpawnInput", () => {
  it("resolves the configured binary and keeps the caller's cwd and environment", () => {
    expect(
      buildMiniMaxCodeAcpSpawnInput({ binaryPath: "/opt/mcode" }, "/work", { PATH: "/bin" }),
    ).toEqual({ command: "/opt/mcode", args: ["acp"], cwd: "/work", env: { PATH: "/bin" } });
  });

  it("falls back to the binary name when no path is configured", () => {
    expect(buildMiniMaxCodeAcpSpawnInput({ binaryPath: "" }, "/work").command).toBe("mcode");
    expect(buildMiniMaxCodeAcpSpawnInput(undefined, "/work").command).toBe("mcode");
  });
});

describe("resolveMiniMaxCodeAcpBaseModelId", () => {
  it("keeps a real model id and falls back to the product slug", () => {
    expect(resolveMiniMaxCodeAcpBaseModelId(" m:minimax:MiniMax-M3:v:thinking ")).toBe(
      "m:minimax:MiniMax-M3:v:thinking",
    );
    expect(resolveMiniMaxCodeAcpBaseModelId("   ")).toBe("minimax-code-default");
    expect(resolveMiniMaxCodeAcpBaseModelId(undefined)).toBe("minimax-code-default");
  });
});

describe("thinking effort", () => {
  it("accepts only values the session currently advertises", () => {
    expect(isValidMiniMaxCodeThinkingEffort("high", THINKING_MODEL_CONFIG_OPTIONS)).toBe(true);
    expect(isValidMiniMaxCodeThinkingEffort("turbo", THINKING_MODEL_CONFIG_OPTIONS)).toBe(false);
  });

  it("rejects every value when the option is absent, as it is for non-thinking models", () => {
    // The CLI answers this with -32602 "Thinking effort is not advertised for the
    // selected model", so the option's presence is the authority on sendability.
    const plainModelOptions = THINKING_MODEL_CONFIG_OPTIONS.filter(
      (option) => option.id !== "thinkingEffort",
    );
    expect(isValidMiniMaxCodeThinkingEffort("high", plainModelOptions)).toBe(false);
    expect(normalizeMiniMaxCodeThinkingEffort("high", plainModelOptions)).toBeUndefined();
  });

  it("drops an unadvertised value rather than forwarding it", () => {
    expect(normalizeMiniMaxCodeThinkingEffort(" high ", THINKING_MODEL_CONFIG_OPTIONS)).toBe(
      "high",
    );
    expect(normalizeMiniMaxCodeThinkingEffort("turbo", THINKING_MODEL_CONFIG_OPTIONS)).toBe(
      undefined,
    );
    expect(normalizeMiniMaxCodeThinkingEffort(undefined, THINKING_MODEL_CONFIG_OPTIONS)).toBe(
      undefined,
    );
  });
});

describe("model discovery from config options", () => {
  it("reads the model option's values in CLI order", () => {
    expect(miniMaxCodeModelIdsFromConfigOptions(THINKING_MODEL_CONFIG_OPTIONS)).toEqual([
      "m:minimax:MiniMax-M3.1-Flash-Preview:v:",
      "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking",
      "m:minimax:MiniMax-M3:v:",
      "m:minimax:MiniMax-M3:v:thinking",
    ]);
  });

  it("reports the session's current model", () => {
    expect(currentMiniMaxCodeModelIdFromConfigOptions(THINKING_MODEL_CONFIG_OPTIONS)).toBe(
      "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking",
    );
  });

  it("finds nothing when the agent sends no model option", () => {
    const withoutModel = THINKING_MODEL_CONFIG_OPTIONS.filter((option) => option.id !== "model");
    expect(miniMaxCodeModelIdsFromConfigOptions(withoutModel)).toEqual([]);
    expect(currentMiniMaxCodeModelIdFromConfigOptions(withoutModel)).toBeUndefined();
  });
});
