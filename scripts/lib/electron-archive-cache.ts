// @effect-diagnostics nodeBuiltinImport:off - sha256 and path joining are pure and synchronous here; wrapping them in Effect services would make the cache-path derivation async for no benefit.

import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * electron-builder fetches the Electron archive through @electron/get, whose got client
 * caps a single request at 10 minutes (app-builder-lib hardcodes `timeout.request`). On a
 * slow link the ~130MB darwin-arm64 archive cannot finish inside that window, and the build
 * dies with "Timeout awaiting 'request' for 600000ms" after burning the full ten minutes.
 *
 * The download itself is fine; only the wall-clock cap is not. So fetch the archive here
 * with a resumable client and a timeout that scales with the file size, and drop it in the
 * exact cache slot @electron/get reads. electron-builder then short-circuits on the cache
 * hit and never opens the request that would have timed out.
 */

const ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS = 30 * 60;
const DOWNLOAD_RETRIES = 5;

export interface ElectronArchiveRequest {
  readonly version: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  /** Overrides the cache root. Tests and offline mirrors point this elsewhere. */
  readonly cacheRoot?: string;
  /** Overrides the artifact base URL. Mirrors serve the same layout under a different host. */
  readonly mirror?: string;
}

export interface ElectronArchiveLocation {
  readonly url: string;
  readonly fileName: string;
  readonly cachePath: string;
}

/** Matches @electron/get's `env-paths('electron', { suffix: '' }).cache` on macOS and Linux. */
export const defaultElectronCacheRoot = (platform: NodeJS.Platform = NodeOs.platform()): string =>
  platform === "win32"
    ? NodePath.join(NodeOs.homedir(), "AppData", "Local", "electron", "Cache")
    : NodePath.join(NodeOs.homedir(), "Library", "Caches", "electron");

/**
 * Reproduces @electron/get's cache layout: the directory is the sha256 of the artifact URL
 * with the file name stripped, and the archive keeps its original name inside it. Deriving it
 * here (rather than guessing) keeps us in step with whatever the installed version does.
 *
 * @electron/get runs the version through `normalizeVersion` before building the URL, which
 * is what adds the leading "v" to both the URL segment and the artifact name.
 */
export const resolveElectronArchiveLocation = (
  request: ElectronArchiveRequest,
): ElectronArchiveLocation => {
  const version = request.version.startsWith("v") ? request.version : `v${request.version}`;
  const fileName = `electron-${version}-${request.platform}-${request.arch}.zip`;
  const base = (
    request.mirror ?? "https://github.com/electron/electron/releases/download/"
  ).replace(/\/$/u, "");
  const url = `${base}/${version}/${fileName}`;
  const parsed = new URL(url);
  const stripped = `${parsed.origin}${parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/"))}`;
  const cacheDir = NodeCrypto.createHash("sha256").update(stripped).digest("hex");
  const cacheRoot = request.cacheRoot ?? defaultElectronCacheRoot();
  return { url, fileName, cachePath: NodePath.join(cacheRoot, cacheDir, fileName) };
};

/**
 * Downloads the archive with curl when it is missing. `--continue-at -` resumes a partial
 * file instead of restarting the transfer, which matters when one attempt cannot finish
 * inside a single timeout window on its own.
 */
export const prewarmElectronArchive = (request: ElectronArchiveRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const location = resolveElectronArchiveLocation(request);

    // Only a non-empty file counts as cached. A run killed mid-transfer leaves a partial
    // archive, and @electron/get validates checksums on read, so handing it back a truncated
    // file would just cost another failed download. Resuming is cheaper than starting over.
    const cached = yield* fs.stat(location.cachePath).pipe(
      Effect.map((info) => info.size > 0),
      Effect.orElseSucceed(() => false),
    );
    if (cached) {
      return yield* Effect.log(`Electron archive already cached: ${location.cachePath}`);
    }

    yield* Effect.log(`Pre-fetching Electron archive (slow-link workaround): ${location.url}`);

    const command = [
      "--fail",
      "--location",
      "--retry",
      String(DOWNLOAD_RETRIES),
      "--retry-all-errors",
      "--connect-timeout",
      "60",
      "--max-time",
      String(ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS),
      "--continue-at",
      "-",
      "--output",
      location.cachePath,
      location.url,
    ];

    yield* fs.makeDirectory(NodePath.dirname(location.cachePath), { recursive: true });

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("curl", command, { cwd: NodeOs.tmpdir() }),
    );
    const exitCode = yield* child.exitCode.pipe(Effect.map(Number));

    if (exitCode !== 0) {
      // A failed pre-warm is not fatal: electron-builder retries the download itself, and a
      // partially written file is resumed rather than re-fetched from byte zero.
      return yield* Effect.logWarning(
        `Electron pre-fetch did not complete (curl exit ${exitCode}); leaving the rest to electron-builder.`,
      );
    }

    return yield* Effect.log(`Electron archive cached: ${location.cachePath}`);
  });
