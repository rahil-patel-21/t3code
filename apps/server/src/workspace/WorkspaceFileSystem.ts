// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import type {
  FilesystemEntryMetadata,
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  ProjectDeleteEntryInput,
  ProjectRenameEntryInput,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
// A trash helper that hangs (a stuck Finder or D-Bus session) must not hang the request.
const TRASH_TIMEOUT_MS = 30_000;

/**
 * Moves a path to the host's Trash / Recycle Bin so deletes stay recoverable.
 * ponytail: Linux relies on `gio trash`; hosts without it (headless servers)
 * fail the delete rather than falling back to a permanent remove.
 */
async function moveToTrash(absolutePath: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "darwin") {
    await execFile(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        'function run(argv) { ObjC.import("Foundation"); if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, null)) throw new Error("Could not move to Trash"); }',
        absolutePath,
      ],
      { timeout: TRASH_TIMEOUT_MS },
    );
    return;
  }
  if (platform === "win32") {
    const literal = `'${absolutePath.replaceAll("'", "''")}'`;
    await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -AssemblyName Microsoft.VisualBasic; $p = ${literal}; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`,
      ],
      { timeout: TRASH_TIMEOUT_MS },
    );
    return;
  }
  await execFile("gio", ["trash", absolutePath], { timeout: TRASH_TIMEOUT_MS });
}

// Windows also reaches `.git` through trailing dots or spaces, a `:` stream
// suffix, or the 8.3 short name `GIT~1`. Names compare upcased, as NTFS does.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "rename",
      "trash",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Writes inside a known workspace only. */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    /** Rename or move an entry within the workspace root. Refuses to overwrite. */
    readonly renameEntry: (
      input: ProjectRenameEntryInput,
    ) => Effect.Effect<
      void,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Move an entry within the workspace root to the host's Trash. */
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<
      void,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(requestedPath, yield* HostProcess.HomeDirectory);
    if (!path.isAbsolute(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    if (stat._tag === "None") return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(
            expandedPath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            if (!(await handle.stat()).isFile()) return undefined;
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return fileHeaderMimeType(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  /**
   * Git runs config and hooks from its own folders, so a write never lands in one:
   * a `.git` entry, or a repository folder under another name such as `.bare`.
   * Folders are checked upward to a linked worktree's top, which holds a `.git`
   * file, since worktrees can sit inside a bare repository. `absolutePath` must
   * be normalized.
   */
  const isInGitFolder = async (absolutePath: string) => {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = await Promise.all(
        ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
          NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
            // Any other failure leaves the folder unknown, so the write is refused.
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }),
        ),
      );
      // What git reads as a repository: HEAD, plus objects and refs here or in
      // the folder a `commondir` file names, as in a linked worktree's git folder.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  /**
   * Workspace-relative paths must stay inside the root, symlinks included. An
   * absolute path reads a host file in place, such as a report an agent wrote to a
   * temp directory; it gets no root check.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    if (path.isAbsolute(requestedPath)) {
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(requestedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: requestedPath,
            operationPath: requestedPath,
            operation: "realpath-target",
            cause,
          }),
      });
      return { relativePath: requestedPath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (!isInsideRealRoot(realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const realTargetPath = target.realTargetPath;

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking so a FIFO cannot hang the open; the stat below rejects
        // it. Regular files ignore the flag. Windows lacks it.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  /**
   * Resolves the file a write targets. The deepest existing ancestor resolves to
   * its real path before the root check, so neither the file nor the directories
   * created for it can follow a symlink out of the root. A dangling symlink is
   * rejected rather than written through.
   */
  const resolveWriteTarget = Effect.fn("WorkspaceFileSystem.resolveWriteTarget")(function* (
    input: ProjectWriteFileInput,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      // Resolve `..` in cwd the way the relative path was resolved, before following links.
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });

    // Split the host path, not the display relativePath: on POSIX `\` is a file name character.
    const segments = path.relative(input.cwd, target.absolutePath).split(path.sep);
    const realTargetPath = yield* Effect.tryPromise({
      try: async () => {
        for (let depth = segments.length; depth > 0; depth--) {
          const candidate = path.join(realWorkspaceRoot, ...segments.slice(0, depth));
          try {
            return path.join(await NodeFSP.realpath(candidate), ...segments.slice(depth));
          } catch (error) {
            // Only a missing entry is skipped; one that exists but cannot resolve is a dangling link.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              () => false,
            );
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || exists) throw error;
          }
        }
        return path.join(realWorkspaceRoot, ...segments);
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    // The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
    const namedTargetPath = path.join(realWorkspaceRoot, ...segments);
    const inGitFolder = Effect.fn("WorkspaceFileSystem.inGitFolder")((checkedPath: string) =>
      Effect.tryPromise({
        try: () => isInGitFolder(checkedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: checkedPath,
            operation: "stat",
            cause,
          }),
      }),
    );
    if (
      !isInsideRealRoot(realWorkspaceRoot, realTargetPath) ||
      (yield* inGitFolder(realTargetPath)) ||
      (yield* inGitFolder(namedTargetPath))
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const target = yield* resolveWriteTarget(input);
    const realTargetPath = target.realTargetPath;

    yield* fileSystem.makeDirectory(path.dirname(realTargetPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: path.dirname(realTargetPath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      // A symlink swapped in after the check is not followed. Windows lacks O_NOFOLLOW.
      try: () =>
        NodeFSP.writeFile(realTargetPath, input.contents, {
          flag:
            NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_TRUNC |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        }),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: realTargetPath,
          operation: "write-file",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  /**
   * Rename and trash act on the entry itself, so only its parent chain has to
   * stay inside the root. The lexical check alone would let `link/file`, where
   * `link` is a symlink out of the workspace, move or trash files elsewhere.
   * Checks the nearest existing ancestor, since a rename may create parents.
   */
  const assertParentWithinRoot = Effect.fn("WorkspaceFileSystem.assertParentWithinRoot")(function* (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
  ) {
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    let ancestor = path.dirname(absolutePath);
    let realAncestor: string | null = null;
    while (realAncestor === null) {
      const candidate = ancestor;
      realAncestor = yield* Effect.tryPromise(() => NodeFSP.realpath(candidate)).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (realAncestor !== null) break;
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    const relativeRealPath =
      realAncestor === null ? ".." : path.relative(realWorkspaceRoot, realAncestor);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realAncestor ?? absolutePath,
      });
    }
  });

  const renameEntry: WorkspaceFileSystem["Service"]["renameEntry"] = Effect.fn(
    "WorkspaceFileSystem.renameEntry",
  )(function* (input) {
    const source = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const destination = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.nextRelativePath,
    });
    const fail = (cause: unknown) =>
      new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: source.absolutePath,
        operationPath: destination.absolutePath,
        operation: "rename",
        cause,
      });
    yield* assertParentWithinRoot(input, source.absolutePath);
    yield* assertParentWithinRoot(
      { cwd: input.cwd, relativePath: input.nextRelativePath },
      destination.absolutePath,
    );
    // Never overwrite. A case-only rename on a case-insensitive filesystem sees
    // its own source as the destination, so an existing destination is only
    // allowed when it is the very same file (same device and inode).
    if (yield* fileSystem.exists(destination.absolutePath).pipe(Effect.mapError(fail))) {
      const sourceInfo = yield* fileSystem.stat(source.absolutePath).pipe(Effect.mapError(fail));
      const destinationInfo = yield* fileSystem
        .stat(destination.absolutePath)
        .pipe(Effect.mapError(fail));
      const sameFile =
        sourceInfo.dev === destinationInfo.dev &&
        Option.isSome(sourceInfo.ino) &&
        Option.getOrUndefined(sourceInfo.ino) === Option.getOrUndefined(destinationInfo.ino);
      if (!sameFile) {
        return yield* fail(new Error(`'${destination.relativePath}' already exists.`));
      }
    }
    yield* fileSystem
      .makeDirectory(path.dirname(destination.absolutePath), { recursive: true })
      .pipe(Effect.mapError(fail));
    yield* fileSystem
      .rename(source.absolutePath, destination.absolutePath)
      .pipe(Effect.mapError(fail));
    yield* workspaceEntries.refresh(input.cwd);
  });

  const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    yield* assertParentWithinRoot(input, target.absolutePath);
    const platform = yield* HostProcess.Platform;
    yield* Effect.tryPromise(() => moveToTrash(target.absolutePath, platform)).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "trash",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
  });

  return WorkspaceFileSystem.of({ getMetadata, readFile, writeFile, renameEntry, deleteEntry });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
