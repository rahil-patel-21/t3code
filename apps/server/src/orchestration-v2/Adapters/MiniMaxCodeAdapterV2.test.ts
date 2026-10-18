import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MiniMaxCodeSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeMiniMaxCodeAcpRuntime } from "../../provider/acp/MiniMaxCodeAcpSupport.ts";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { acpSupportsImagePrompts } from "@t3tools/provider-acp/server/adapter";
import {
  makeMiniMaxCodeAcpAdapterFlavor,
  makeMiniMaxCodeAdapterV2,
} from "./MiniMaxCodeAdapterV2.ts";

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeMiniMaxCodeSettings = Schema.decodeSync(MiniMaxCodeSettings);

/** Model the MiniMax Code mock agent advertises in its `model` config option. */
const MINIMAX_THINKING_MODEL = "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking";

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-minimax-v2-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

interface ClientFsCapability {
  readonly readTextFile: boolean;
  readonly writeTextFile: boolean;
}

/**
 * Reads back the `clientCapabilities` T3 sent on `initialize`, out of the
 * request log the mock agent records. The CLI only delegates file access to a
 * client that advertised `fs`, so this is the promise the adapter has to keep.
 */
function advertisedClientFs(requestLog: string): ClientFsCapability | undefined {
  for (const line of requestLog.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded !== "object" || decoded === null || !("method" in decoded)) continue;
    const request = decoded as { readonly method?: unknown; readonly params?: unknown };
    if (request.method !== "initialize") continue;
    const params = request.params;
    if (typeof params !== "object" || params === null) return undefined;
    const capabilities = Reflect.get(params, "clientCapabilities");
    if (typeof capabilities !== "object" || capabilities === null) return undefined;
    const fs = Reflect.get(capabilities, "fs");
    if (typeof fs !== "object" || fs === null) return { readTextFile: false, writeTextFile: false };
    return {
      readTextFile: Reflect.get(fs, "readTextFile") === true,
      writeTextFile: Reflect.get(fs, "writeTextFile") === true,
    };
  }
  return undefined;
}

describe("MiniMaxCodeAdapterV2 image attachments", () => {
  it("references images by path rather than sending content blocks", () => {
    const flavor = makeMiniMaxCodeAcpAdapterFlavor({
      instanceId: ProviderInstanceId.make("minimax-instance"),
      settings: decodeMiniMaxCodeSettings({}),
      environment: {},
      serverConfig: {
        attachmentsDir: "/tmp/attachments",
        binaryPath: "mcode",
      } as unknown as ServerConfig.ServerConfig["Service"],
      childProcessSpawner: null as unknown as ChildProcessSpawner.ChildProcessSpawner,
      fileSystem: null as unknown as FileSystem.FileSystem,
      startSession: undefined as never,
    } as unknown as Parameters<typeof makeMiniMaxCodeAcpAdapterFlavor>[0]);

    // mcode acp rejects image content blocks, so the override stays off...
    assert.isNotTrue(flavor.supportsImagePrompts);
    assert.isFalse(
      acpSupportsImagePrompts({
        flavorSupportsImagePrompts: flavor.supportsImagePrompts,
        negotiatedImage: false,
      }),
    );
    // ...and the turn is sent as a path reference instead of failing.
    assert.equal(flavor.unsupportedImageAttachmentPolicy, "reference");
  });
});

describe("MiniMaxCodeAdapterV2 compaction", () => {
  it("exposes /compact through the v2 compaction path", () => {
    const flavor = makeMiniMaxCodeAcpAdapterFlavor({
      instanceId: ProviderInstanceId.make("minimax-instance"),
      settings: decodeMiniMaxCodeSettings({}),
      environment: {},
      serverConfig: {
        attachmentsDir: "/tmp/attachments",
        binaryPath: "mcode",
      } as unknown as ServerConfig.ServerConfig["Service"],
      childProcessSpawner: null as unknown as ChildProcessSpawner.ChildProcessSpawner,
      fileSystem: null as unknown as FileSystem.FileSystem,
      startSession: undefined as never,
    } as unknown as Parameters<typeof makeMiniMaxCodeAcpAdapterFlavor>[0]);

    // The provider snapshot already advertises `compact`, so the composer
    // offers the button. Without this the turn is refused with
    // "minimaxCode does not support conversation compaction (/compact)".
    assert.isTrue(flavor.supportsCompaction);
  });
});

describe("MiniMaxCodeAdapterV2 client file system", () => {
  it.effect("serves the client file system it advertises to the CLI", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;

      const launcherDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-minimax-v2-launcher-",
      });
      const requestLogPath = path.join(launcherDir, "requests.jsonl");
      const settings = decodeMiniMaxCodeSettings({
        enabled: true,
        binaryPath: writeFakeCli({
          directory: launcherDir,
          name: "mcode",
          env: { T3_ACP_MINIMAX: "1", T3_ACP_REQUEST_LOG_PATH: requestLogPath },
          source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
        }),
      });

      const instanceId = ProviderInstanceId.make("minimax-client-fs-test");
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-minimax-v2-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-minimax-v2-outside-",
      });
      const outsideFile = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsideFile, "secret");
      const attachment = path.join(serverConfig.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const adapter = yield* makeMiniMaxCodeAdapterV2({
        instanceId,
        settings,
        environment: {},
        hostPlatform: yield* HostProcess.Platform,
        childProcessSpawner,
        selfInvocation: yield* resolveSelfInvocation(),
        fileSystem,
        path,
        serverConfig,
        // Mirrors the adapter's own default `makeRuntime` wiring, and only adds
        // a tap on the two client file handlers so registration is observable.
        // The mock CLI rejects `additionalDirectories` exactly as `mcode acp`
        // does, so re-adding the grant fails the session open right here.
        makeRuntime: (input) =>
          makeMiniMaxCodeAcpRuntime({
            ...input,
            miniMaxCodeSettings: settings,
            environment: {},
            childProcessSpawner,
          }).pipe(
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              handleWriteTextFile: (handler) =>
                Effect.sync(() => {
                  writeTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
            })),
          ),
      });

      const threadId = ThreadId.make("thread-minimax-client-fs");
      const modelSelection = { instanceId, model: MINIMAX_THINKING_MODEL } as const;
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-minimax-client-fs"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });

      assert.isTrue(
        yield* fileSystem.exists(requestLogPath),
        "the CLI must record the initialize request",
      );
      const advertised = advertisedClientFs(yield* fileSystem.readFileString(requestLogPath));
      assert.deepStrictEqual(advertised, { readTextFile: true, writeTextFile: true });

      // An advertised `fs` capability is a promise that the requests are served:
      // the CLI answers every `fs/*` request with -32601 when it is not.
      assert.isDefined(
        readTextFile,
        "an advertised fs.readTextFile capability must have a handler",
      );
      assert.isDefined(
        writeTextFile,
        "an advertised fs.writeTextFile capability must have a handler",
      );
      if (readTextFile === undefined || writeTextFile === undefined) return;

      const context = (method: string) => ({ requestId: `test-${method}`, method });

      const insidePath = path.join(workspace, "src", "inside.ts");
      yield* writeTextFile(
        { sessionId: "mock-session-1", path: insidePath, content: "inside" },
        context("fs/write_text_file"),
      );
      assert.equal(yield* fileSystem.readFileString(insidePath), "inside");

      // Path-only uploads land in the attachments dir, which the agent is
      // granted alongside the workspace.
      const pasted = yield* readTextFile(
        { sessionId: "mock-session-1", path: attachment },
        context("fs/read_text_file"),
      );
      assert.equal(pasted.content, "pasted");

      // Everything else stays off limits.
      const outsideRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: outsideFile },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideRead), "a read outside the allowed roots is denied");
      const outsideWrite = yield* writeTextFile(
        {
          sessionId: "mock-session-1",
          path: path.join(outside, "planted.txt"),
          content: "planted",
        },
        context("fs/write_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideWrite), "a write outside the allowed roots is denied");
      assert.isFalse(yield* fileSystem.exists(path.join(outside, "planted.txt")));
      assert.equal(yield* fileSystem.readFileString(outsideFile), "secret");

      // A link inside the workspace must not read through to a file outside
      // it: the final component is resolved before containment is checked.
      const escapeLink = path.join(workspace, "escape.txt");
      yield* fileSystem.symlink(outsideFile, escapeLink);
      const escapedRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: escapeLink },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(escapedRead), "a read through an escaping symlink is denied");
      const escapedWrite = yield* writeTextFile(
        { sessionId: "mock-session-1", path: escapeLink, content: "overwritten" },
        context("fs/write_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(escapedWrite), "a write through an escaping symlink is denied");
      assert.equal(yield* fileSystem.readFileString(outsideFile), "secret");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});
