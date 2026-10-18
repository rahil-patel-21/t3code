import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApiGatewayItemId,
  ApiGatewayWorkspace,
  type ApiGatewayItem,
  type ApiGatewayRequest,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ApiGatewayWorkspaceStore from "./ApiGatewayWorkspaceStore.ts";

const encodeWorkspaceFile = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), ...ApiGatewayWorkspace.fields }),
  ),
);

const REQUEST: ApiGatewayRequest = {
  method: "GET",
  url: "https://example.com",
  query: [],
  headers: [],
  auth: {
    type: "bearer",
    bearerToken: "secret-token",
    basicUsername: "",
    basicPassword: "",
    apiKeyName: "",
    apiKeyValue: "",
    apiKeyIn: "header",
  },
  body: { mode: "none", rawLanguage: "json", raw: "", form: [] },
  followRedirects: true,
  timeoutMs: 30_000,
};

const collection: ApiGatewayItem = {
  kind: "folder",
  id: ApiGatewayItemId.make("api"),
  parentId: null,
  name: "API",
};

const savedRequest: ApiGatewayItem = {
  kind: "request",
  id: ApiGatewayItemId.make("list"),
  parentId: collection.id,
  name: "List",
  request: REQUEST,
};

/** Each body as long as one request allows. Together they pass the file's limit. */
const heavyRequests = Array.from({ length: 5 }, (_, index): ApiGatewayItem => ({
  ...savedRequest,
  id: ApiGatewayItemId.make(`heavy-${index}`),
  request: { ...REQUEST, body: { ...REQUEST.body, raw: "x".repeat(2_000_000) } },
}));

const stateLayer = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-api-gateway-test-" }));

/** A store as one server process sees it; providing it again stands in for a restart. */
const withStore = <A, E, R>(
  use: (
    store: ApiGatewayWorkspaceStore.ApiGatewayWorkspaceStore["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  ApiGatewayWorkspaceStore.ApiGatewayWorkspaceStore.pipe(
    Effect.flatMap(use),
    Effect.provide(Layer.fresh(ApiGatewayWorkspaceStore.layer)),
  );

const workspaceFilePath = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(stateDir, "api-gateway.json");
});

it.layer(NodeServices.layer)("ApiGatewayWorkspaceStore", (it) => {
  it.effect("sends a subscriber the stored workspace, then every change after it", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.apply([{ type: "item.put", item: collection }]);

        const { latest, changes } = yield* store.subscribe;
        assert.deepEqual(latest, { items: [collection], variableSets: [] });

        yield* store.apply([{ type: "item.put", item: savedRequest }]);
        const next = yield* changes.pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(next, [{ items: [collection, savedRequest], variableSets: [] }]);
      }),
    ).pipe(Effect.provide(stateLayer())),
  );

  it.effect("keeps the workspace across a restart", () =>
    Effect.gen(function* () {
      yield* withStore((store) =>
        store.apply([
          { type: "item.put", item: collection },
          { type: "item.put", item: savedRequest },
        ]),
      );

      const { latest } = yield* withStore((store) => store.subscribe);
      assert.deepEqual(latest, { items: [collection, savedRequest], variableSets: [] });
    }).pipe(Effect.provide(stateLayer())),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "stores saved credentials in a file only its owner can read",
    () =>
      Effect.gen(function* () {
        yield* withStore((store) =>
          store.apply([
            { type: "item.put", item: collection },
            { type: "item.put", item: savedRequest },
          ]),
        );

        const fs = yield* FileSystem.FileSystem;
        const filePath = yield* workspaceFilePath;
        assert.include(yield* fs.readFileString(filePath), "secret-token");
        assert.strictEqual((yield* fs.stat(filePath)).mode & 0o777, 0o600);
      }).pipe(Effect.provide(stateLayer())),
  );

  it.effect("leaves a file it cannot read untouched instead of replacing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* workspaceFilePath;
      yield* fs.writeFileString(filePath, "{ not a workspace");

      const error = yield* withStore((store) =>
        store.apply([{ type: "item.put", item: collection }]),
      ).pipe(Effect.flip);

      assert.strictEqual(error._tag, "ApiGatewayWorkspaceError");
      assert.strictEqual(yield* fs.readFileString(filePath), "{ not a workspace");
    }).pipe(Effect.provide(stateLayer())),
  );

  it.effect("writes nothing when a batch is rejected", () =>
    Effect.gen(function* () {
      const error = yield* withStore((store) =>
        store.apply([
          { type: "item.put", item: collection },
          { type: "item.put", item: { ...savedRequest, parentId: ApiGatewayItemId.make("gone") } },
        ]),
      ).pipe(Effect.flip);

      assert.include(error.message, "no longer exists");
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(yield* workspaceFilePath));
    }).pipe(Effect.provide(stateLayer())),
  );

  it.effect("refuses a change that would make the workspace too large to keep sending", () =>
    Effect.gen(function* () {
      const error = yield* withStore((store) =>
        Effect.gen(function* () {
          yield* store.apply([{ type: "item.put", item: collection }]);
          return yield* store
            .apply(heavyRequests.map((item) => ({ type: "item.put" as const, item })))
            .pipe(Effect.flip);
        }),
      );

      assert.include(error.message, "at most 8 MB");
      const { latest } = yield* withStore((store) => store.subscribe);
      assert.deepEqual(latest, { items: [collection], variableSets: [] });
    }).pipe(Effect.provide(stateLayer())),
  );

  it.effect("lets a workspace that is already too large shrink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Written by hand: the store would not write a file this large itself.
      yield* fs.writeFileString(
        yield* workspaceFilePath,
        yield* encodeWorkspaceFile({
          version: 1,
          items: [collection, ...heavyRequests],
          variableSets: [],
        }),
      );

      yield* withStore((store) => store.apply([{ type: "item.delete", id: heavyRequests[0]!.id }]));

      const { latest } = yield* withStore((store) => store.subscribe);
      assert.deepEqual(latest, {
        items: [collection, ...heavyRequests.slice(1)],
        variableSets: [],
      });
    }).pipe(Effect.provide(stateLayer())),
  );
});
