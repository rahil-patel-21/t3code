import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { MiniMaxCodeSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import { MiniMaxCodeDriver } from "./MiniMaxCodeDriver.ts";

const testDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-minimax-driver-update-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("A disabled MiniMax Code must not make an HTTP request")),
    ),
  ),
);

// The driver reads server settings through ProviderHost rather than
// ServerSettingsService directly, so the live host is the base of this layer.
const testLayer = ProviderHostLive.layer.pipe(Layer.provideMerge(testDeps));

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("A disabled MiniMax Code must not spawn a process"),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

describe("MiniMaxCodeDriver", () => {
  it("uses the driver kind and display name the rest of the app routes on", () => {
    expect(MiniMaxCodeDriver.driverKind).toBe(ProviderDriverKind.make("minimaxCode"));
    expect(MiniMaxCodeDriver.metadata.displayName).toBe("MiniMax Code");
    // Two MiniMax accounts in one environment must not share session state.
    expect(MiniMaxCodeDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("defaults to a disabled, path-resolved `mcode` install", () => {
    const config = MiniMaxCodeDriver.defaultConfig();
    expect(config.enabled).toBe(false);
    expect(config.binaryPath).toBe("mcode");
    expect(config.customModels).toEqual([]);
  });

  it.effect("decodes an instance config and carries its identity onto the snapshot", () =>
    Effect.gen(function* () {
      const instance = yield* MiniMaxCodeDriver.create({
        instanceId: ProviderInstanceId.make("minimax-identity"),
        displayName: "Work MiniMax",
        enabled: false,
        environment: [],
        config: MiniMaxCodeDriver.defaultConfig(),
      });

      expect(instance.instanceId).toBe("minimax-identity");
      expect(instance.driverKind).toBe("minimaxCode");
      expect(instance.displayName).toBe("Work MiniMax");
      // Two instances of the driver must not share continuation state.
      expect(instance.continuationIdentity.continuationKey).toContain("minimax-identity");
      // The registry calls the adapter directly, so it must be built, not an unrun Effect.
      const capabilities = yield* instance.orchestrationAdapter.getCapabilities();
      expect(capabilities.sessions.supportsModelSwitchInSession).toBe(true);

      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.displayName).toBe("Work MiniMax");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.provide(testLayer),
      Effect.scoped,
    ),
  );

  it.layer(testLayer)("maintenance capabilities", (it) => {
    it.effect.skipIf(windowsHost)(
      "updates through the resolved executable's own `mcode update`",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-minimax-driver-" });
          // A space in the install path forces the resolver to quote the command,
          // which is the case that silently breaks an unquoted `mcode update`.
          const miniMaxCodeHome = path.join(tempDir, "MiniMax Code Home");
          const binaryPath = path.join(miniMaxCodeHome, "bin", "mcode");
          yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
          yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
          yield* fs.chmod(binaryPath, 0o755);

          const instance = yield* MiniMaxCodeDriver.create({
            instanceId: ProviderInstanceId.make("minimax-update"),
            displayName: "MiniMax test",
            enabled: false,
            environment: [],
            config: { ...MiniMaxCodeDriver.defaultConfig(), binaryPath },
          });

          const capabilities = yield* instance.snapshot.resolveMaintenance();
          expect(capabilities.packageName).toBe("@minimax-ai/code");
          expect(capabilities.update).toMatchObject({
            command: `'${binaryPath}' update`,
            executable: binaryPath,
            args: ["update"],
          });
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
          Effect.scoped,
        ),
    );

    it.effect("stays manual-only when the configured executable does not exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-minimax-missing-" });
        const instance = yield* MiniMaxCodeDriver.create({
          instanceId: ProviderInstanceId.make("minimax-missing"),
          displayName: "MiniMax test",
          enabled: false,
          environment: [],
          config: {
            ...MiniMaxCodeDriver.defaultConfig(),
            binaryPath: path.join(tempDir, "mcode"),
          },
        });
        expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
        Effect.scoped,
      ),
    );
  });

  it("rejects a config that does not decode, rather than half-initializing", () => {
    // The registry decodes this envelope; an invalid one must not reach `create`.
    expect(() => MiniMaxCodeDriver.configSchema).not.toThrow();
    expect(MiniMaxCodeDriver.configSchema).toBeDefined();
    expect(MiniMaxCodeDriver.defaultConfig()).toEqual<MiniMaxCodeSettings>({
      enabled: false,
      binaryPath: "mcode",
      customModels: [],
    });
  });
});
