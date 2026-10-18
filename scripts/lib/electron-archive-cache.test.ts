// @effect-diagnostics nodeBuiltinImport:off - mirrors the helper under test, which hashes with node:crypto and joins paths with node:path.

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  prewarmElectronArchive,
  resolveElectronArchiveLocation,
} from "./electron-archive-cache.ts";

describe("electron-archive-cache", () => {
  it("derives the cache path @electron/get will read", () => {
    // @electron/get normalizes the version to a leading "v", then hashes the artifact URL
    // with the file name stripped (Cache.getCacheDirectory) and keeps the archive under that
    // directory. These expected values come from the installed @electron/get itself.
    const location = resolveElectronArchiveLocation({
      version: "44.4.5",
      platform: "darwin",
      arch: "arm64",
      cacheRoot: "/cache",
    });

    assert.equal(location.fileName, "electron-v44.4.5-darwin-arm64.zip");
    assert.equal(
      location.url,
      "https://github.com/electron/electron/releases/download/v44.4.5/electron-v44.4.5-darwin-arm64.zip",
    );
    assert.equal(
      location.cachePath,
      "/cache/bfa62fe1b54e5e709b522b5f731c7644136b8ab3a8123f8d2facc4ecf2b925fe/electron-v44.4.5-darwin-arm64.zip",
    );
  });

  it("hashes the directory and keeps the archive name as a plain segment", () => {
    const location = resolveElectronArchiveLocation({
      version: "44.4.5",
      platform: "darwin",
      arch: "arm64",
      cacheRoot: "/cache",
    });

    assert.isTrue(location.cachePath.endsWith(`/${location.fileName}`));

    // The directory @electron/get hashes is the sha256 of the URL minus the file name,
    // so it must be a bare hex digest rather than anything derived from the version.
    const directory = location.cachePath.slice("/cache/".length).split("/")[0]!;
    assert.match(directory, /^[0-9a-f]{64}$/u);
  });

  it("tolerates a mirror with a trailing slash", () => {
    const withSlash = resolveElectronArchiveLocation({
      version: "44.4.5",
      platform: "linux",
      arch: "x64",
      cacheRoot: "/cache",
      mirror: "https://mirror.example.com/electron/",
    });

    assert.equal(
      withSlash.url,
      "https://mirror.example.com/electron/v44.4.5/electron-v44.4.5-linux-x64.zip",
    );
  });

  it("hashes a mirror URL separately from the default host", () => {
    const official = resolveElectronArchiveLocation({
      version: "44.4.5",
      platform: "darwin",
      arch: "arm64",
      cacheRoot: "/cache",
    });
    const mirrored = resolveElectronArchiveLocation({
      version: "44.4.5",
      platform: "darwin",
      arch: "arm64",
      cacheRoot: "/cache",
      mirror: "https://mirror.example.com/electron",
    });

    assert.notEqual(official.cachePath, mirrored.cachePath);
  });

  it("derives the same path for every target platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const location = resolveElectronArchiveLocation({
        version: "44.4.5",
        platform,
        arch: "arm64",
        cacheRoot: "/cache",
      });

      // @electron/get derives the file name as electron-v<version>-<platform>-<arch>.zip and
      // hashes the URL's directory. Recompute that here independently of the implementation.
      const expectedName = `electron-v44.4.5-${platform}-arm64.zip`;
      const stripped = `https://github.com/electron/electron/releases/download/v44.4.5`;
      const expectedDir = NodeCrypto.createHash("sha256").update(stripped).digest("hex");

      assert.equal(location.fileName, expectedName);
      assert.equal(location.cachePath, `/cache/${expectedDir}/${expectedName}`);
    }
  });

  it.effect("skips the download when the archive is already cached", () =>
    Effect.gen(function* () {
      const cacheRoot = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "electron-archive-cache-")),
      );
      // The mirror is part of the hashed key, so seed the exact slot this call reads. If the
      // cache guard regressed, the unreachable mirror would make the download fail loudly.
      const request = {
        version: "44.4.5",
        platform: "darwin",
        arch: "arm64",
        cacheRoot,
        mirror: "http://127.0.0.1:1/electron",
      } as const;

      const location = resolveElectronArchiveLocation(request);
      yield* Effect.promise(() =>
        NodeFs.mkdir(NodePath.dirname(location.cachePath), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFs.writeFile(location.cachePath, "already here"));

      // A cache hit must not touch the network: an unreachable mirror would fail loudly if
      // the guard regressed into downloading.
      const logs: Array<string> = [];
      yield* prewarmElectronArchive(request).pipe(
        Effect.provide([
          NodeServices.layer,
          Logger.layer([
            Logger.make((options) => {
              logs.push(Logger.formatJson.log(options));
            }),
          ]),
        ]),
      );

      assert.ok(
        logs.some((line) => line.includes("already cached")),
        `expected a cache-hit log, got: ${logs.join(" | ")}`,
      );
      assert.ok(!logs.some((line) => line.includes("Pre-fetching")));
      const contents = yield* Effect.promise(() => NodeFs.readFile(location.cachePath, "utf8"));
      assert.equal(contents, "already here");
    }),
  );

  it.effect("treats a zero-byte leftover as a miss and re-fetches", () =>
    Effect.gen(function* () {
      // A run killed mid-transfer can leave an empty file. Counting that as a cache hit
      // would hand @electron/get a truncated archive it then has to re-download anyway.
      const cacheRoot = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "electron-archive-cache-")),
      );
      const request = {
        version: "44.4.5",
        platform: "darwin",
        arch: "arm64",
        cacheRoot,
        mirror: "http://127.0.0.1:1/electron",
      } as const;

      const location = resolveElectronArchiveLocation(request);
      yield* Effect.promise(() =>
        NodeFs.mkdir(NodePath.dirname(location.cachePath), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFs.writeFile(location.cachePath, ""));

      const logs: Array<string> = [];
      yield* prewarmElectronArchive(request).pipe(
        Effect.provide([
          NodeServices.layer,
          Logger.layer([
            Logger.make((options) => {
              logs.push(Logger.formatJson.log(options));
            }),
          ]),
        ]),
      );

      assert.ok(
        logs.some((line) => line.includes("Pre-fetching")),
        `expected a re-fetch for an empty file, got: ${logs.join(" | ")}`,
      );
    }),
  );
});
