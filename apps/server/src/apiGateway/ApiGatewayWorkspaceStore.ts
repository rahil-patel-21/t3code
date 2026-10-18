import {
  ApiGatewayWorkspace,
  ApiGatewayWorkspaceError,
  type ApiGatewayOperation,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import {
  subscribeBeforeSnapshot,
  type SnapshotSubscription,
} from "../utils/subscribeBeforeSnapshot.ts";
import { applyApiGatewayOperations } from "./workspaceOperations.ts";

const WORKSPACE_FILE_NAME = "api-gateway.json";
/**
 * Every change reads the whole file, rewrites it, and sends it to each client,
 * so its size is what a change costs. The limits on single fields would let it
 * grow far past this.
 */
const MAX_WORKSPACE_FILE_CHARS = 8 * 1024 * 1024;
const EMPTY_WORKSPACE: ApiGatewayWorkspace = { items: [], variableSets: [] };

const WorkspaceFileJson = fromJsonStringPretty(
  Schema.Struct({ version: Schema.Literal(1), ...ApiGatewayWorkspace.fields }),
);
const decodeWorkspaceFile = Schema.decodeEffect(WorkspaceFileJson);
const encodeWorkspaceFile = Schema.encodeEffect(WorkspaceFileJson);

/**
 * The collections and variable sets one environment keeps for API Gateway,
 * shared by every client connected to it.
 */
export class ApiGatewayWorkspaceStore extends Context.Service<
  ApiGatewayWorkspaceStore,
  {
    /** Applies every operation or none, then sends the result to subscribers. */
    readonly apply: (
      operations: ReadonlyArray<ApiGatewayOperation>,
    ) => Effect.Effect<void, ApiGatewayWorkspaceError>;
    /** The stored workspace now, and each one that replaces it. */
    readonly subscribe: Effect.Effect<
      SnapshotSubscription<ApiGatewayWorkspace>,
      ApiGatewayWorkspaceError,
      Scope.Scope
    >;
  }
>()("t3/apiGateway/ApiGatewayWorkspaceStore") {}

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePath = path.join(stateDir, WORKSPACE_FILE_NAME);
  // Every message is the whole workspace, so a subscriber that falls behind
  // needs only the newest one, not a backlog of full copies.
  const changes = yield* PubSub.sliding<ApiGatewayWorkspace>(1);
  // Serializes read-modify-write, and keeps a subscriber's first snapshot in
  // order with the changes published after it.
  const lock = yield* Semaphore.make(1);

  const storageError = (action: string) => (cause: unknown) =>
    Effect.logWarning(`API Gateway could not ${action} its workspace file`, {
      path: workspacePath,
      // A schema error quotes the value it rejected, which here can be a saved credential.
      cause: Schema.isSchemaError(cause) ? "The file is not a valid workspace." : cause,
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ApiGatewayWorkspaceError({
            message: `API Gateway could not ${action} ${workspacePath}.`,
          }),
        ),
      ),
    );

  // The file is read on every use rather than cached: it stays the single
  // truth if it is restored from a backup or edited while the server runs. A
  // file that does not decode fails here, so it is never overwritten.
  const read = Effect.gen(function* () {
    if (!(yield* fs.exists(workspacePath))) return EMPTY_WORKSPACE;
    const { items, variableSets } = yield* fs
      .readFileString(workspacePath)
      .pipe(Effect.flatMap(decodeWorkspaceFile));
    return { items, variableSets };
  }).pipe(Effect.catch(storageError("read")));

  const encode = (workspace: ApiGatewayWorkspace) =>
    encodeWorkspaceFile({ version: 1, ...workspace }).pipe(Effect.catch(storageError("write")));

  const write = Effect.fn("ApiGatewayWorkspaceStore.write")(function* (
    previous: ApiGatewayWorkspace,
    workspace: ApiGatewayWorkspace,
  ) {
    const contents = yield* encode(workspace);
    // A file already past the limit may still shrink, or it could never be emptied.
    if (
      contents.length > MAX_WORKSPACE_FILE_CHARS &&
      contents.length >= (yield* encode(previous)).length
    ) {
      return yield* new ApiGatewayWorkspaceError({
        message: `API Gateway keeps at most ${MAX_WORKSPACE_FILE_CHARS / (1024 * 1024)} MB of collections and variables. Delete some saved requests, or shorten the bodies they carry.`,
      });
    }
    // Saved requests and variables routinely hold API keys and tokens.
    yield* writeFileStringAtomically({
      filePath: workspacePath,
      contents: `${contents}\n`,
      mode: 0o600,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catch(storageError("write")),
    );
  });

  const apply: ApiGatewayWorkspaceStore["Service"]["apply"] = (operations) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* read;
        const next = applyApiGatewayOperations(current, operations);
        if (Result.isFailure(next)) {
          return yield* new ApiGatewayWorkspaceError({ message: next.failure });
        }
        // A caller that goes away mid-write must not leave subscribers
        // behind the file.
        yield* Effect.uninterruptible(
          Effect.andThen(write(current, next.success), PubSub.publish(changes, next.success)),
        );
      }),
    );

  return ApiGatewayWorkspaceStore.of({
    apply,
    subscribe: subscribeBeforeSnapshot(changes, read, lock),
  });
});

export const layer = Layer.effect(ApiGatewayWorkspaceStore, make);
