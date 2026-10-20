import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionImportSource,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: "codex" | "claudeAgent" = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({
      driver,
      nativeThreadId: providerSessionId,
    }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: providerSessionId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<ReturnType<typeof candidate>>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () => Stream.fromIterable(candidates),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "Project",
                  workspaceRoot: "/workspace/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                  deletedAt: null,
                }),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return { run: importer.importRecentAgentThreads({ projectId }), published };
});

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      const importer = yield* makeImporter([active, archived, deleted, otherInstance, unowned]);

      expect(yield* importer.run).toEqual({ importedCount: 2, skippedCount: 0 });
      for (const source of [active, archived, deleted]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned)]));
      for (const source of [otherInstance, unowned]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(
          source.source.providerSessionId,
        );
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "codex"
              ? { threadId: source.source.providerSessionId }
              : { threadId, resume: source.source.providerSessionId },
          runtimePayload: { importedTranscripts: [source.source] },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

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
            upsert: () => Effect.void,
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
                // A new import only counts once its events committed.
                return [{} as never];
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

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);
