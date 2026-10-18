import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import { MiniMaxCodeSettings } from "@t3tools/contracts";

import {
  buildInitialMiniMaxCodeProviderSnapshot,
  buildMiniMaxCodeModelsFromConfigOptions,
  miniMaxCodeUsageLimits,
  parseMiniMaxCodeProviderList,
} from "./MiniMaxCodeProvider.ts";

const decodeMiniMaxCodeSettings = Schema.decodeSync(MiniMaxCodeSettings);

/** Captured from `mcode provider list` 0.5.5. */
const SIGNED_IN_OUTPUT = [
  "* minimax_oauth\tactive\tmanaged login",
  "  minimax_api\tenabled\tno key",
  "  custom_provider:openrouter\tenabled\tsk-o****3c00",
  "  custom_provider:openrouter-2\tenabled\tsk-o****3c00",
].join("\n");

/** The same command with the managed credential removed. */
const SIGNED_OUT_OUTPUT = [
  "  minimax_oauth\tenabled\tno key",
  "  minimax_api\tenabled\tno key",
].join("\n");

describe("parseMiniMaxCodeProviderList", () => {
  it("reads the active row as signed in when it holds a credential", () => {
    expect(parseMiniMaxCodeProviderList(SIGNED_IN_OUTPUT).authenticated).toBe(true);
  });

  it("reads an active row with no credential as signed out", () => {
    // With no `*` row there is nothing active, so the state is unknown rather
    // than a guess that the user is signed in.
    expect(parseMiniMaxCodeProviderList(SIGNED_OUT_OUTPUT).authenticated).toBeNull();
  });

  it("treats an active row whose only credential is 'no key' as signed out", () => {
    expect(parseMiniMaxCodeProviderList("* minimax_api\tactive\tno key").authenticated).toBe(false);
  });

  it("ignores non-active rows that do hold credentials", () => {
    // Only the active source is used, so a leftover key on a disabled provider
    // must not make the provider look signed in.
    expect(
      parseMiniMaxCodeProviderList("  custom_provider:openrouter\tenabled\tsk-o****3c00")
        .authenticated,
    ).toBeNull();
  });

  it("reports unknown for output it does not recognize", () => {
    expect(
      parseMiniMaxCodeProviderList("Usage: mcode provider [options]").authenticated,
    ).toBeNull();
    expect(parseMiniMaxCodeProviderList("").authenticated).toBeNull();
  });
});

describe("buildMiniMaxCodeModelsFromConfigOptions", () => {
  const configOptions = [
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
      ],
    },
  ] as const satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

  it("keeps the CLI's model ids verbatim and marks the current one default", () => {
    const models = buildMiniMaxCodeModelsFromConfigOptions(configOptions);
    expect(models.map((model) => model.slug)).toEqual([
      "m:minimax:MiniMax-M3.1-Flash-Preview:v:",
      "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking",
      "m:minimax:MiniMax-M3:v:",
    ]);
    expect(models.map((model) => model.name)).toEqual([
      "M3.1-Flash-Preview",
      "M3.1-Flash-Preview · thinking",
      "M3",
    ]);
    expect(models.filter((model) => model.isDefault)).toHaveLength(1);
    expect(models[1]?.isDefault).toBe(true);
  });

  it("returns nothing when the agent advertises no model option", () => {
    expect(buildMiniMaxCodeModelsFromConfigOptions([])).toEqual([]);
  });
});

describe("buildInitialMiniMaxCodeProviderSnapshot", () => {
  it.effect("reports the provider as disabled and explains why", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialMiniMaxCodeProviderSnapshot(
        decodeMiniMaxCodeSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("starts optimistic while the CLI is being checked", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialMiniMaxCodeProviderSnapshot(
        decodeMiniMaxCodeSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      // The product slug stands in until the adapter publishes the live list.
      expect(snapshot.models.map((model) => model.slug)).toEqual(["minimax-code-default"]);
    }),
  );
});

describe("MiniMax Code subscription limits", () => {
  // `mcode acp` reports no quota window, so the provider must not invent one.
  // It publishes the console link instead, which is what puts MiniMax Code on
  // the Limits tab rather than leaving it absent. Asserted on the published
  // shape directly: the status path shells out to `mcode` to get there.
  it("points the Limits view at the MiniMax console instead of guessing a window", () => {
    const limits = miniMaxCodeUsageLimits("2026-10-10T00:00:00.000Z");
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable?.reason).toBe("unsupported");
    expect(limits.externalUsage).toEqual({
      label: "MiniMax usage",
      url: "https://platform.minimax.io/console/usage",
    });
  });
});
