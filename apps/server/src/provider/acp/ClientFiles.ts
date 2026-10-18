import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

/**
 * Workspace file access requested through the ACP client `fs` capability, shared
 * by the flavors that opt into it. The agent gates each write behind
 * `session/request_permission`, so only path containment is checked here.
 */
export const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves an agent-supplied path and rejects anything outside the session
 * roots. Symlinks resolve before the check, including the final component, so
 * a link inside the workspace cannot read or write through to a file outside
 * it. An entry that exists but cannot be resolved, like a dangling link, is
 * rejected rather than written through.
 */
export const resolveClientFilePath = Effect.fn("ClientFiles.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly requestPath: string;
  }) {
    const { path } = input;
    const resolved = path.resolve(input.requestPath);
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.requestPath}' is outside the session workspace.`,
    );
    const real = yield* input.fileSystem.realPath(resolved).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          // Only a missing file (a new write) falls back to a parent; a dangling
          // or unreadable link must not be followed on write.
          const entryExists = yield* input.fileSystem.readLink(resolved).pipe(
            Effect.as(true),
            Effect.catch(() => input.fileSystem.exists(resolved)),
            Effect.orElseSucceed(() => true),
          );
          if (entryExists) return yield* outside;
          // A write routinely names a directory tree that does not exist yet, so
          // symlinks are resolved on the deepest ancestor that does exist. Stopping
          // at the immediate parent would leave the unresolved tail compared
          // against already-resolved roots, which fails for any workspace reached
          // through a symlink — macOS `/var` -> `/private/var`, or a linked
          // checkout — and would deny ordinary writes into a new subdirectory.
          // A directory that cannot be stat'd is treated as present: the walk
          // stops there rather than climbing past a path it cannot vouch for.
          const exists = (candidate: string) =>
            input.fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => true));
          let current = path.dirname(resolved);
          const missingSegments: Array<string> = [];
          while (!(yield* exists(current))) {
            const parent = path.dirname(current);
            if (parent === current) break;
            missingSegments.unshift(path.basename(current));
            current = parent;
          }
          const realAncestor = yield* input.fileSystem
            .realPath(current)
            .pipe(Effect.orElseSucceed(() => current));
          return path.join(realAncestor, ...missingSegments, path.basename(resolved));
        }),
      ),
    );
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      input.fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    if (!roots.some((root) => isInsideRoot(path, root, real))) {
      return yield* outside;
    }
    return real;
  },
);

export const readClientTextFile = Effect.fn("ClientFiles.readTextFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly request: EffectAcpSchema.ReadTextFileRequest;
}): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
  const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
  const info = yield* input.fileSystem
    .stat(filePath)
    .pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.resourceNotFound(`File '${input.request.path}' not found.`),
      ),
    );
  if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
    );
  }
  const text = yield* input.fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.internalError(`Could not read '${input.request.path}'.`),
      ),
    );
  const line = input.request.line ?? undefined;
  const limit = input.request.limit ?? undefined;
  if (line === undefined && limit === undefined) {
    return { content: text };
  }
  // ACP lines are 1-indexed. `limit` is a line count.
  const lines = text.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  return { content: lines.slice(start, end).join("\n") };
});

export const writeClientTextFile = Effect.fn("ClientFiles.writeTextFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly allowedRoots: ReadonlyArray<string>;
  readonly request: EffectAcpSchema.WriteTextFileRequest;
}): Effect.fn.Return<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError> {
  const filePath = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
  yield* input.fileSystem.makeDirectory(input.path.dirname(filePath), { recursive: true }).pipe(
    Effect.andThen(input.fileSystem.writeFileString(filePath, input.request.content)),
    Effect.mapError(() =>
      EffectAcpErrors.AcpRequestError.internalError(`Could not write '${input.request.path}'.`),
    ),
  );
  return {};
});
