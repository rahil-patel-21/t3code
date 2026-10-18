import { MiniMaxCodeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { makeMiniMaxCodeTextGeneration } from "../../textGeneration/MiniMaxCodeTextGeneration.ts";
import {
  MiniMaxCodeAdapterV2Driver,
  type MiniMaxCodeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/MiniMaxCodeAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialMiniMaxCodeProviderSnapshot,
  checkMiniMaxCodeProviderStatus,
  enrichMiniMaxCodeSnapshot,
} from "../MiniMaxCodeProvider.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

const decodeMiniMaxCodeSettings = Schema.decodeSync(MiniMaxCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("minimaxCode");
// `mcode update` detects and upgrades its own install, so the registry only
// supplies the package name it publishes versions under.
const MINIMAX_CODE_NPM_PACKAGE = "@minimax-ai/code";
// Like Grok, the resolved executable is its own updater. MiniMax Code installs
// under its own data directory and runs with the instance's environment, so an
// unresolved binary means nothing to update rather than "whatever is on PATH".
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: MINIMAX_CODE_NPM_PACKAGE,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "mcode",
            platform: context.platform,
            env: context.env,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: MINIMAX_CODE_NPM_PACKAGE,
          }),
    ),
};

export type MiniMaxCodeDriverEnv =
  | MiniMaxCodeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderLatestVersions.ProviderLatestVersions
  | ServerConfig;

export const MiniMaxCodeDriver: ProviderDriver<MiniMaxCodeSettings, MiniMaxCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "MiniMax Code",
    supportsMultipleInstances: true,
  },
  configSchema: MiniMaxCodeSettings,
  defaultConfig: (): MiniMaxCodeSettings => decodeMiniMaxCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies MiniMaxCodeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const orchestrationAdapter = yield* MiniMaxCodeAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build MiniMax Code orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeMiniMaxCodeTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkMiniMaxCodeProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<MiniMaxCodeSettings>
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialMiniMaxCodeProviderSnapshot(settings.provider).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichMiniMaxCodeSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                httpClient,
                latestVersions,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build MiniMax Code snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
