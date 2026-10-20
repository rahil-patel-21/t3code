import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionListProjectSessionsInput,
  type AgentSessionProjectSession,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

// Imported messages reuse the importer's `${threadId}:<6-digit index>` id scheme
// (see `messageEvents`), so the prefix separates them from anything the thread
// itself produced after the import.
const isImportedMessageId = (threadId: ThreadId, messageId: string): boolean =>
  messageId.startsWith(`${threadId}:`);

/** True once the thread was used in T3, after which CLI history can no longer be appended. */
function isContinuedInT3(projection: OrchestrationV2ThreadProjection): boolean {
  return (
    projection.runs.length > 0 ||
    projection.providerThreads.some(
      (providerThread) => providerThread.providerSessionId !== null,
    ) ||
    projection.messages.some((message) => !isImportedMessageId(projection.thread.id, message.id))
  );
}

// How many trailing imported messages must line up with the transcript before
// anything after them counts as new.
const SYNC_ALIGNMENT_WINDOW = 3;

/**
 * Transcript messages that follow the thread's imported history. Aligns on the
 * last few imported messages (role and text) instead of timestamps, because
 * records without timestamps fall back to the file mtime, which moves on every
 * write. ponytail: takes the latest alignment, so a repeated exchange can hide
 * new messages (never duplicate them); and more than ~200 new CLI messages
 * push the anchor out of the parsed window, which reads as "nothing new".
 */
function newTranscriptMessages(
  projection: OrchestrationV2ThreadProjection,
  messages: ReadonlyArray<AgentSessionScanner.AgentSessionThreadMessage>,
): ReadonlyArray<AgentSessionScanner.AgentSessionThreadMessage> {
  const anchor = projection.messages
    .filter((message) => isImportedMessageId(projection.thread.id, message.id))
    .slice(-SYNC_ALIGNMENT_WINDOW);
  if (anchor.length === 0) return [];
  for (let end = messages.length; end >= anchor.length; end -= 1) {
    const aligned = anchor.every((message, index) => {
      const candidate = messages[end - anchor.length + index];
      return candidate?.role === message.role && candidate.text === message.text;
    });
    if (aligned) return messages.slice(end);
  }
  return [];
}

const importedThreadId = (providerInstanceId: string, providerSessionId: string) =>
  ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

// The sidebar re-lists on focus. Changes to known transcripts are seen on every
// listing (a cheap stat); discovering brand-new session files walks every CLI
// transcript, so that happens at most this often.
const LIST_CANDIDATE_MAX_AGE_MS = 120_000;

/**
 * Parsed transcripts the listing already read, keyed by file. Passed back to
 * the scanner as completed sources so an unchanged file is matched by its
 * identity (size, mtime, inode) instead of being read and parsed again on
 * every sidebar refresh. A changed file fails the identity match and is reread.
 * ponytail: process-wide and capped by entry count, not bytes; each entry holds
 * at most the scanner's 200 retained messages.
 */
interface ListedTranscript {
  readonly source: AgentSessionImportSource;
  readonly thread: AgentSessionScanner.AgentSessionThread;
}
const listedTranscripts = new Map<string, ListedTranscript>();
const LISTED_TRANSCRIPTS_MAX = 200;

function rememberListedTranscript(entry: ListedTranscript): void {
  const key = `${entry.source.providerInstanceId}\0${entry.source.filePath}`;
  listedTranscripts.delete(key);
  listedTranscripts.set(key, entry);
  if (listedTranscripts.size > LISTED_TRANSCRIPTS_MAX) {
    const oldest = listedTranscripts.keys().next().value;
    if (oldest !== undefined) listedTranscripts.delete(oldest);
  }
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const sql = yield* SqlClient.SqlClient;

  /**
   * T3's own threads write transcripts to the same CLI homes, so the sessions a
   * T3 thread is bound to did not come from a terminal. `bound` holds them all:
   * resume cursors for imports and pre-V2 threads, provider-thread native ids
   * for V2 threads. `skip` is what the scanner can leave unread; an import that
   * nobody continued in T3 stays readable so its CLI updates can sync.
   * ponytail: a thread's earlier session ids (before a fork) are not tracked.
   */
  const t3BoundSessions = Effect.fn("t3BoundSessions")(function* (
    runtimeRows: ReadonlyArray<ProviderSessionRuntime.ProviderSessionRuntime>,
    completedSources: ReadonlyArray<AgentSessionImportSource>,
  ) {
    const bound = new Set<string>();
    for (const runtime of runtimeRows) {
      const cursor = runtime.resumeCursor;
      if (cursor === null || typeof cursor !== "object") continue;
      for (const key of ["resume", "sessionId", "threadId"] as const) {
        const value = (cursor as Record<string, unknown>)[key];
        if (typeof value === "string") bound.add(value);
      }
    }
    const nativeRows = yield* sql<{ readonly nativeId: string }>`
      SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS "nativeId"
      FROM orchestration_v2_projection_provider_threads
      WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
    `.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
    for (const row of nativeRows) bound.add(row.nativeId);
    // Sessions T3 drives write their transcripts as they work, often many MB and
    // changed every few seconds, and a continued import appends T3's own turns to
    // the CLI transcript. Only imports nobody has continued can still sync, so
    // every other bound session is skipped before its transcript is read.
    const syncable = new Set<string>();
    for (const entry of completedSources) {
      const shell = yield* orchestrator
        .getThreadShell(importedThreadId(entry.providerInstanceId, entry.providerSessionId))
        .pipe(Effect.orElseSucceed(() => null));
      if (shell !== null && shell.latestRunId === null && shell.activeRunId === null) {
        syncable.add(entry.providerSessionId);
      }
    }
    return { bound, skip: new Set([...bound].filter((id) => !syncable.has(id))) };
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const sessionFilter =
      input.providerSessionIds === undefined ? null : new Set(input.providerSessionIds);
    const { skip: skipSessionIds } = yield* t3BoundSessions(runtimeRows, completedSources);
    // A single-session import skips every other transcript the listing already
    // parsed, so importing one session does not reread the whole project.
    const skippedListedSources =
      sessionFilter === null
        ? []
        : [...listedTranscripts.values()]
            .filter((entry) => !sessionFilter.has(entry.thread.providerSessionId))
            .map((entry) => entry.source);
    const outcomes = scanner.recentThreads(
      project.workspaceRoot,
      [...completedSources, ...skippedListedSources],
      { skipSessionIds },
    );
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          if (sessionFilter === null) skippedCount += 1;
          return;
        }
        const outcomeSessionId =
          outcome._tag === "Importable"
            ? outcome.thread.providerSessionId
            : outcome.source.providerSessionId;
        if (sessionFilter !== null && !sessionFilter.has(outcomeSessionId)) return;
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            // The CLI kept going after the import: append what it added, unless
            // the thread was continued in T3 and the histories have diverged.
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const fresh =
              projection.thread.deletedAt === null && projection.thread.archivedAt === null
                ? newTranscriptMessages(projection, thread.messages)
                : [];
            if (fresh.length > 0 && !isContinuedInT3(projection)) {
              const offset = projection.messages.filter((message) =>
                isImportedMessageId(threadId, message.id),
              ).length;
              const occurredAt = dateTime(thread.updatedAt);
              yield* eventSink.write({
                events: fresh.flatMap((message, index) =>
                  messageEvents({ threadId, index: offset + index, message }).map((event) => ({
                    ...event,
                    occurredAt,
                  })),
                ),
              });
            }
            yield* persistRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId: thread.providerSessionId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: thread.providerSessionId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const committed = yield* eventSink.write({
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          if (committed.length === 0) return null;
          yield* persistRuntime;
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  const listProjectAgentSessions = Effect.fn("listProjectAgentSessions")(function* (
    input: AgentSessionListProjectSessionsInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const runtimeRows = yield* runtimes.list().pipe(Effect.orElseSucceed(() => []));
    // Imported transcripts are stored per project on the runtime row, so the
    // rows for this project's workspace are the ones the import path recorded.
    const projectRuntimes = runtimeRows.filter((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      return (
        Option.isSome(payload) &&
        payload.value.cwd !== undefined &&
        normalizeProjectPathForComparison(payload.value.cwd) ===
          normalizeProjectPathForComparison(project.workspaceRoot)
      );
    });
    const completedSources = projectRuntimes.flatMap((runtime) =>
      decodeImportedTranscriptPayload(runtime.runtimePayload).pipe(
        Option.map((payload) => payload.importedTranscripts ?? []),
        Option.getOrElse(() => []),
      ),
    );
    const { bound: t3SessionIds, skip: skipSessionIds } = yield* t3BoundSessions(
      runtimeRows,
      completedSources,
    );
    const sessions: AgentSessionProjectSession[] = [];
    // Real completed sources come first so an imported, unchanged file still
    // resolves to its import record rather than to the listing cache.
    const listed = new Map(
      [...listedTranscripts.values()].map((entry) => [entry.source, entry.thread] as const),
    );
    yield* Stream.runForEach(
      scanner.recentThreads(project.workspaceRoot, [...completedSources, ...listed.keys()], {
        maxCandidateAgeMs: LIST_CANDIDATE_MAX_AGE_MS,
        skipSessionIds,
      }),
      (outcome) =>
        Effect.gen(function* () {
          const cachedThread =
            outcome._tag === "AlreadyImported" ? listed.get(outcome.source) : undefined;
          let thread: AgentSessionScanner.AgentSessionThread;
          if (outcome._tag === "Importable") {
            thread = outcome.thread;
            rememberListedTranscript({ source: outcome.source, thread });
          } else if (cachedThread !== undefined) {
            thread = cachedThread;
          } else {
            return;
          }
          const threadId = importedThreadId(thread.providerInstanceId, thread.providerSessionId);
          const existing = yield* Effect.option(orchestrator.getThreadProjection(threadId));
          const base = {
            source: thread.source,
            providerSessionId: thread.providerSessionId,
            threadId,
            title: thread.title,
            updatedAt: thread.updatedAt,
            messageCount: thread.messages.length,
          };
          if (Option.isNone(existing)) {
            if (t3SessionIds.has(thread.providerSessionId)) return;
            sessions.push({ ...base, state: "available", newMessageCount: 0 });
            return;
          }
          const projection = existing.value;
          if (
            projection.thread.projectId !== input.projectId ||
            projection.thread.deletedAt !== null ||
            projection.thread.archivedAt !== null ||
            projection.thread.historyOrigin !== "v1_import" ||
            isContinuedInT3(projection)
          ) {
            return;
          }
          const fresh = newTranscriptMessages(projection, thread.messages);
          if (fresh.length === 0) return;
          sessions.push({
            ...base,
            title: projection.thread.title,
            state: "updated",
            newMessageCount: fresh.length,
          });
        }),
    );
    return { sessions };
  });

  return { importRecentAgentThreads, listProjectAgentSessions };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
