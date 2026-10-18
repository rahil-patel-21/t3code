import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionImportSource,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
          getThreadProjection: () => Effect.succeed(importedProjection()),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
        SqlitePersistence.layerMemory,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

/** A V2 projection shaped like an imported thread that nobody has continued. */
const importedProjection = (options?: {
  readonly followup?: boolean;
  readonly sessionBound?: boolean;
}) => {
  const messages = [
    { id: `${threadId}:000000`, role: "user", text: "Fix it" },
    { id: `${threadId}:000001`, role: "assistant", text: "Fixed" },
    ...(options?.followup === true
      ? [{ id: "user-followup", role: "user", text: "Keep going" }]
      : []),
  ];
  return {
    thread: {
      id: threadId,
      projectId,
      historyOrigin: "v1_import",
      archivedAt: null,
      deletedAt: null,
    },
    runs: [],
    providerThreads: [
      { id: "provider-thread", providerSessionId: options?.sessionBound === true ? "bound" : null },
    ],
    messages,
  } as never;
};

const importSource: AgentSessionImportSource = {
  provider: "codex",
  providerInstanceId,
  providerSessionId,
  filePath: "/tmp/native-codex-thread.jsonl",
  size: 100,
  mtimeMs: 2,
  device: 3,
  inode: 4,
  birthtimeMs: 1,
};

const grownThread = {
  source: "codex",
  providerInstanceId,
  providerSessionId,
  title: "Imported thread",
  model: "gpt-5.4",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:05:00.000Z",
  messages: [
    { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
    { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
    { role: "user", text: "One more", createdAt: "2026-09-01T10:05:00.000Z" },
  ],
} as const;

const growableScanner = AgentSessionScanner.AgentSessionScanner.of({
  scan: Effect.die("unused"),
  recentThreads: () =>
    Stream.succeed({ _tag: "Importable", source: importSource, thread: grownThread }),
});

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Records the V2 provider thread a T3 thread's run leaves behind for each native session. */
const bindNativeSessions = (nativeIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const nativeId of nativeIds) {
      const payload = yield* encodePayload({
        nativeThreadRef: { driver: "codex", nativeId, strength: "strong" },
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_threads
          (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
        VALUES (${`provider-thread:${nativeId}`}, ${`thread:${nativeId}`}, 'codex', 'idle',
          '2026-09-01T10:00:00.000Z', ${payload})
      `;
    }
  });

describe("imported history sync", () => {
  it.effect("appends new CLI messages to an imported thread, never to a diverged one", () => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    let projection: unknown = importedProjection();
    const testLayer = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentSessionScanner.AgentSessionScanner, growableScanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              Effect.succeed({ thread: (projection as { thread: unknown }).thread } as never),
            getThreadProjection: () => Effect.succeed(projection as never),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                writes.push(input.events);
                return [];
              }),
          }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            list: () => Effect.succeed([]),
            upsert: () => Effect.die("an existing import must not rewrite the cursor"),
            recordImportedTranscript: () => Effect.void,
          }),
          IdAllocator.layer,
          SqlitePersistence.layerMemory,
        ),
      ),
    );

    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      yield* importer.importRecentAgentThreads({ projectId });

      expect(writes).toHaveLength(1);
      expect(
        writes[0]
          ?.filter((event) => event.type === "message.updated")
          .map((event) => (event.payload as { text: string }).text),
      ).toEqual(["One more"]);
      expect(
        writes[0]
          ?.filter((event) => event.type === "turn-item.updated")
          .map((event) => (event.payload as { ordinal: number }).ordinal),
      ).toEqual([3]);

      // Once the thread was continued in T3 the CLI transcript has diverged and
      // nothing may be appended.
      writes.length = 0;
      projection = importedProjection({ followup: true });
      yield* importer.importRecentAgentThreads({ projectId });
      expect(writes).toHaveLength(0);
    }).pipe(Effect.provide(testLayer));
  });
});

describe("listProjectAgentSessions", () => {
  const listingLayer = (input: {
    readonly options: {
      readonly maxCandidateAgeMs?: number;
      readonly skipSessionIds?: ReadonlySet<string>;
    };
    readonly sources: ReadonlyArray<AgentSessionImportSource>;
    readonly imported?: boolean;
    readonly projection?: unknown;
  }) => {
    let seen:
      | { readonly maxCandidateAgeMs?: number; readonly skipSessionIds?: ReadonlySet<string> }
      | undefined;
    const scanner = AgentSessionScanner.AgentSessionScanner.of({
      scan: Effect.die("unused"),
      recentThreads: (_root, completed, options) => {
        seen = options;
        return Stream.succeed(
          (completed ?? []).some(
            (entry) => entry.providerSessionId === importSource.providerSessionId,
          )
            ? { _tag: "AlreadyImported", source: importSource }
            : { _tag: "Importable", source: importSource, thread: grownThread },
        );
      },
    });
    return {
      seen: () => seen,
      layer: AgentSessionImporter.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
                ),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadProjection: () =>
                input.imported === true
                  ? Effect.succeed((input.projection ?? importedProjection()) as never)
                  : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
              getThreadShell: () =>
                Effect.succeed({ id: threadId, latestRunId: null, activeRunId: null } as never),
            }),
            Layer.mock(EventSink.EventSinkV2)({ write: () => Effect.succeed([]) }),
            Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
              list: () =>
                Effect.succeed(
                  input.sources.length === 0
                    ? []
                    : [
                        {
                          threadId,
                          providerName: "codex",
                          providerInstanceId,
                          adapterKey: "codex",
                          runtimeMode: "full-access",
                          status: "stopped",
                          lastSeenAt: "2026-09-01T10:00:00.000Z",
                          resumeCursor: { resume: "t3-driven-session" },
                          runtimePayload: {
                            cwd: "/workspace/project",
                            importedTranscripts: input.sources,
                          },
                        },
                      ],
                ),
              upsert: () => Effect.void,
              recordImportedTranscript: () => Effect.void,
            }),
            IdAllocator.layer,
          ),
        ),
        // Merged so a test can record the provider threads of T3's own runs.
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    };
  };

  it.effect("reports new and updated sessions and hides synced or continued ones", () => {
    const available = listingLayer({ options: {}, sources: [] });
    const updated = listingLayer({
      options: {},
      sources: [importSource],
      imported: true,
      projection: importedProjection(),
    });
    const continued = listingLayer({
      options: {},
      sources: [importSource],
      imported: true,
      projection: importedProjection({ followup: true }),
    });

    return Effect.gen(function* () {
      const fresh = yield* Effect.provide(
        Effect.flatMap(AgentSessionImporter.AgentSessionImporter, (importer) =>
          importer.listProjectAgentSessions({ projectId }),
        ),
        available.layer,
        // A nested provide otherwise reuses the outer layer's memoized importer.
        { local: true },
      );
      expect(fresh.sessions).toEqual([
        {
          source: "codex",
          providerSessionId,
          threadId,
          title: "Imported thread",
          updatedAt: grownThread.updatedAt,
          messageCount: 3,
          state: "available",
          newMessageCount: 0,
        },
      ]);

      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect((yield* importer.listProjectAgentSessions({ projectId })).sessions).toEqual([
        expect.objectContaining({ state: "updated", newMessageCount: 1 }),
      ]);

      const afterFollowup = yield* Effect.provide(
        Effect.flatMap(AgentSessionImporter.AgentSessionImporter, (importer) =>
          importer.listProjectAgentSessions({ projectId }),
        ),
        continued.layer,
        { local: true },
      );
      expect(afterFollowup.sessions).toEqual([]);
    }).pipe(
      // The two runs need different layers, so drive them separately.
      Effect.provide(updated.layer),
    );
  });

  it.effect("does not offer a session a T3 thread drives for import", () => {
    const harness = listingLayer({ options: {}, sources: [] });

    return Effect.gen(function* () {
      yield* bindNativeSessions([providerSessionId]);
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect((yield* importer.listProjectAgentSessions({ projectId })).sessions).toEqual([]);
      expect([...(harness.seen()?.skipSessionIds ?? [])]).toEqual([providerSessionId]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "leaves the transcripts of sessions T3 drives unread, except imports that can sync",
    () => {
      const harness = listingLayer({ options: {}, sources: [importSource] });

      return Effect.gen(function* () {
        // The import is bound to a provider thread too, but nobody continued it in T3.
        yield* bindNativeSessions([providerSessionId, "t3-native-session"]);
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        yield* importer.listProjectAgentSessions({ projectId });
        expect([...(harness.seen()?.skipSessionIds ?? [])].toSorted()).toEqual([
          "t3-driven-session",
          "t3-native-session",
        ]);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("importRecentAgentThreads", () => {
  it.effect("imports only the requested session and leaves T3's own transcripts unread", () => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    let skipped: ReadonlySet<string> | undefined;
    const outcome = (sessionId: string) => ({
      _tag: "Importable" as const,
      source: {
        ...importSource,
        providerSessionId: sessionId,
        filePath: `/tmp/${sessionId}.jsonl`,
      },
      thread: { ...grownThread, providerSessionId: sessionId },
    });
    const scanner = AgentSessionScanner.AgentSessionScanner.of({
      scan: Effect.die("unused"),
      recentThreads: (_root, _completed, options) => {
        skipped = options?.skipSessionIds;
        return Stream.make(outcome("requested-session"), outcome("other-session"));
      },
    });
    const testLayer = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                writes.push(input.events);
                return [];
              }),
          }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            list: () => Effect.succeed([]),
            upsert: () => Effect.void,
            recordImportedTranscript: () => Effect.void,
          }),
          IdAllocator.layer,
        ),
      ),
      Layer.provideMerge(SqlitePersistence.layerMemory),
    );

    return Effect.gen(function* () {
      yield* bindNativeSessions(["t3-native-session"]);
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect(
        yield* importer.importRecentAgentThreads({
          projectId,
          providerSessionIds: ["requested-session"],
        }),
      ).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContainEqual(
        expect.objectContaining({
          type: "thread.created",
          threadId: ThreadId.make(`import:${providerInstanceId}:requested-session`),
        }),
      );
      expect([...(skipped ?? [])]).toEqual(["t3-native-session"]);
    }).pipe(Effect.provide(testLayer));
  });
});
