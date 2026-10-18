// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import {
  ChatAttachment,
  MINIMAX_CODE_DEFAULT_MODEL,
  MiniMaxCodeSettings,
  ProviderInstanceId,
  type ModelSelection,
  type TextGenerationError,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeMiniMaxCodeTextGeneration } from "./MiniMaxCodeTextGeneration.ts";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";

const decodeMiniMaxCodeSettings = Schema.decodeSync(MiniMaxCodeSettings);
const decodeChatAttachment = Schema.decodeSync(ChatAttachment);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const MiniMaxCodeTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-minimax-code-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const INSTANCE = ProviderInstanceId.make("minimax-code-test");

// ---------------------------------------------------------------------------
// A `mcode acp` 0.5.5 emulator
// ---------------------------------------------------------------------------
// The shared `scripts/acp-mock-agent.ts` has no MiniMax Code profile yet, and its
// default profile is Codex-shaped: it advertises `composer-2` style model ids and
// its `authenticate` handler *succeeds*. Asserting "no authenticate round-trip"
// against that profile proves nothing, because the round-trip would have worked.
//
// This emulator is a real subprocess speaking real ACP over stdio (JSON-RPC 2.0,
// ndjson — the framing `effect-acp` uses) with the surface `mcode acp` 0.5.5
// actually reports:
//
// - `initialize` advertises `promptCapabilities: {image:false, audio:false,
//   embeddedContext:false}`, `agentInfo: {name:"minimax-code", title:"MiniMax
//   Code", version:"0.5.5"}` and **no** `authMethods`.
// - `authenticate` is rejected with -32602 for *every* methodId, because sign-in
//   is `mcode login`.
// - Models are session config options, not a `models` block; `session/set_model`
//   does not exist (-32601).
// - `thinkingEffort` is advertised only for `:thinking` model variants, and
//   requesting it for a plain model fails with -32602 "Thinking effort is not
//   advertised for the selected model".
//
// It is plain ESM JavaScript on purpose: no `node_modules` resolution is needed,
// so it can live in an OS temp dir.
const MCODE_ACP_EMULATOR_SOURCE = `
import { appendFileSync, writeFileSync } from "node:fs";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const cwdLogPath = process.env.T3_ACP_CWD_LOG_PATH;
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const hangPrompt = process.env.T3_ACP_HANG_PROMPT_FOREVER === "1";
const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0");
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";
const emitPermissionRequest = process.env.T3_ACP_EMIT_PERMISSION_REQUEST === "1";

const SESSION_ID = "mcode-session-1";
const MODELS = [
  "m:minimax:MiniMax-M3.1-Flash-Preview:v:",
  "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking",
  "m:minimax:MiniMax-M3:v:",
  "m:minimax:MiniMax-M3:v:thinking",
];
const DEFAULT_MODEL = "m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking";
const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES = ["default", "auto", "bypassPermissions"];

let currentModel = DEFAULT_MODEL;
let currentEffort = "default";
let currentPermissionMode = "default";
let nextAgentRequestId = 1000;

if (cwdLogPath) {
  writeFileSync(cwdLogPath, process.cwd(), "utf8");
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}
function reply(id, result) {
  send({ id, result });
}
function reject(id, code, message) {
  send({ id, error: { code, message } });
}
function notify(method, params) {
  send({ method, params });
}
// Agent-to-client traffic is a *request*, so the client answers with a response
// carrying the same id. Sending it as a notification would leave the client with
// nothing to reply to.
function requestClient(id, method, params) {
  send({ id, method, params });
  return waitForClientAnswer(id);
}
function invalidParams(detail) {
  return { code: -32602, message: "Invalid params: " + detail };
}

function configOptions() {
  const options = [
    {
      id: "permissionMode",
      name: "Permission mode",
      category: "_permission",
      type: "select",
      currentValue: currentPermissionMode,
      options: PERMISSION_MODES.map((value) => ({ value, name: value })),
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: MODELS.map((value) => ({ value, name: value })),
    },
  ];
  // The real CLI only advertises thinkingEffort for the ":thinking" variants.
  if (currentModel.endsWith(":thinking")) {
    options.push({
      id: "thinkingEffort",
      name: "Thinking effort",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: EFFORTS.map((value) => ({ value, name: value })),
    });
  }
  return options;
}

function setConfigOption(params) {
  const configId = params && params.configId;
  const value = params && params.value;
  if (failSetConfigOption) {
    return reject(
      params.__id,
      -32602,
      "Invalid params: Mock refused session/set_config_option",
    );
  }
  if (configId === "model") {
    if (typeof value !== "string" || MODELS.indexOf(value) === -1) {
      return reject(params.__id, -32602, "Invalid params: Unknown model: " + String(value));
    }
    currentModel = value;
    return reply(params.__id, { configOptions: configOptions() });
  }
  if (configId === "thinkingEffort") {
    const advertised = configOptions().some((option) => option.id === "thinkingEffort");
    if (!advertised) {
      return reject(
        params.__id,
        -32602,
        "Invalid params: Thinking effort is not advertised for the selected model: " + String(value),
      );
    }
    if (typeof value !== "string" || EFFORTS.indexOf(value) === -1) {
      return reject(params.__id, -32602, "Invalid params: Unknown thinking effort: " + String(value));
    }
    currentEffort = value;
    return reply(params.__id, { configOptions: configOptions() });
  }
  if (configId === "permissionMode") {
    if (typeof value !== "string" || PERMISSION_MODES.indexOf(value) === -1) {
      return reject(params.__id, -32602, "Invalid params: Unknown permission mode: " + String(value));
    }
    currentPermissionMode = value;
    return reply(params.__id, { configOptions: configOptions() });
  }
  return reject(params.__id, -32602, "Invalid params: Unknown config option: " + String(configId));
}

// Answers are split into small chunks so the client has to accumulate them.
function chunkText(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += 7) {
    chunks.push(text.slice(index, index + 7));
  }
  return chunks.length > 0 ? chunks : [text];
}

async function prompt(id, params) {
  if (hangPrompt) {
    return;
  }
  if (Number.isFinite(promptDelayMs) && promptDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, promptDelayMs));
  }

  if (emitPermissionRequest) {
    // A title turn must never block on a person, so the client has to answer
    // these two without a human present.
    const permissionAnswer = await requestClient(nextAgentRequestId++, "session/request_permission", {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: "tool-1", title: "Write a file", kind: "edit", status: "pending" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    });
    appendFileSync(
      requestLogPath,
      JSON.stringify({ method: "@emulator/permission_answer", params: permissionAnswer }) + "\\n",
      "utf8",
    );

    const elicitationAnswer = await requestClient(nextAgentRequestId++, "session/elicitation", {
      sessionId: SESSION_ID,
      mode: "form",
      message: "Which branch should this target?",
      requestedSchema: {
        type: "object",
        properties: { branch: { type: "string", title: "Branch" } },
        required: ["branch"],
      },
    });
    appendFileSync(
      requestLogPath,
      JSON.stringify({ method: "@emulator/elicitation_answer", params: elicitationAnswer }) + "\\n",
      "utf8",
    );
  }

  // A thought chunk must never leak into the parsed answer.
  notify("session/update", {
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "THOUGHT-MUST-NOT-LEAK" },
    },
  });
  for (const chunk of chunkText(String(promptResponseText ?? ""))) {
    notify("session/update", {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      },
    });
  }
  reply(id, { stopReason: "end_turn" });
}

const pendingClientAnswers = new Map();
function waitForClientAnswer(id) {
  return new Promise((resolve) => {
    pendingClientAnswers.set(String(id), resolve);
  });
}

function handle(message) {
  if (Object.hasOwn(message, "id")) {
    appendFileSync(
      requestLogPath,
      JSON.stringify({ method: message.method, params: message.params ?? null }) + "\\n",
      "utf8",
    );
  }
  const id = message.id;
  const params = { ...(message.params ?? {}), __id: id };

  switch (message.method) {
    case "initialize":
      return reply(id, {
        protocolVersion: 1,
        agentInfo: { name: "minimax-code", title: "MiniMax Code", version: "0.5.5" },
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      });
    case "authenticate":
      // Ground truth: mcode advertises no ACP auth method and rejects every id.
      return reject(id, -32602, "Invalid params: Unknown authentication method.");
    case "session/new":
      return reply(id, { sessionId: SESSION_ID, configOptions: configOptions() });
    case "session/set_model":
      return reject(id, -32601, "Method not found: session/set_model");
    case "session/set_config_option":
      return setConfigOption(params);
    case "session/prompt":
      return prompt(id, params);
    case "session/cancel":
      return;
    default:
      if (Object.hasOwn(message, "id")) {
        return reject(id, -32601, "Method not found: " + String(message.method));
      }
      return;
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  let newlineIndex = buffer.indexOf("\\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.trim().length > 0) {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          dispatch(entry);
        }
      } else {
        dispatch(parsed);
      }
    }
    newlineIndex = buffer.indexOf("\\n");
  }
});
// On stdin end there is no more work, so the event loop drains and the process
// exits on its own. Calling process.exit here would race the stdout writes.
process.stdin.resume();

function dispatch(message) {
  // Answers to this agent's own requests to the client.
  if (!Object.hasOwn(message, "method")) {
    const resolve = pendingClientAnswers.get(String(message.id));
    if (resolve) {
      pendingClientAnswers.delete(String(message.id));
      resolve(message.result ?? null);
    }
    return;
  }
  Promise.resolve(handle(message)).catch(() => {
    process.exit(9);
  });
}
`;

interface WireRequest {
  readonly method?: string;
  readonly params?: Record<string, unknown> | null;
}

function readWireRequests(filePath: string): ReadonlyArray<WireRequest> {
  if (!NodeFS.existsSync(filePath)) {
    return [];
  }
  return NodeFS.readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WireRequest);
}

function wireMethods(filePath: string): ReadonlyArray<string | undefined> {
  return readWireRequests(filePath).map((request) => request.method);
}

function configOptionWrites(
  filePath: string,
): ReadonlyArray<{ readonly configId: unknown; readonly value: unknown }> {
  return readWireRequests(filePath)
    .filter((request) => request.method === "session/set_config_option")
    .map((request) => ({ configId: request.params?.configId, value: request.params?.value }));
}

function promptBlocks(filePath: string): ReadonlyArray<Record<string, unknown>> {
  const prompt = readWireRequests(filePath).find((request) => request.method === "session/prompt");
  const blocks = prompt?.params?.prompt;
  return Array.isArray(blocks) ? (blocks as ReadonlyArray<Record<string, unknown>>) : [];
}

function promptText(filePath: string): string {
  return promptBlocks(filePath)
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

interface Harness {
  /** NDJSON log of every request the client put on the wire. */
  readonly requestLogPath: string;
  /** Raw wire log, used to assert a value never appears anywhere at all. */
  rawLog(): string;
  /** Records the argv the provider spawned the CLI with. */
  readonly argvLogPath: string;
  /** Records the process cwd the CLI was started in. */
  readonly cwdLogPath: string;
}

function makeEmulator(dir: string): Harness {
  const emulatorPath = NodePath.join(dir, "mcode-acp-emulator.mjs");
  const requestLogPath = NodePath.join(dir, "requests.ndjson");
  const argvLogPath = NodePath.join(dir, "argv.log");
  const cwdLogPath = NodePath.join(dir, "cwd.txt");
  NodeFS.writeFileSync(emulatorPath, MCODE_ACP_EMULATOR_SOURCE, "utf8");
  return {
    requestLogPath,
    argvLogPath,
    cwdLogPath,
    rawLog: () =>
      [requestLogPath, argvLogPath]
        .map((path) => (NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : ""))
        .join("\n"),
  };
}

function writeEmulatorCli(dir: string, harness: Harness, env: Record<string, string>): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "mcode",
    env: {
      T3_ACP_REQUEST_LOG_PATH: harness.requestLogPath,
      T3_ACP_CWD_LOG_PATH: harness.cwdLogPath,
      ...env,
    },
    source: execScriptSource({
      scriptPath: NodePath.join(dir, "mcode-acp-emulator.mjs"),
      expectedArgs: ["acp"],
      argvLogPath: harness.argvLogPath,
    }),
  });
}

function selection(
  model: string,
  options?: Parameters<typeof createModelSelection>[2],
): ModelSelection {
  return createModelSelection(INSTANCE, model, options);
}

/**
 * Writes `input` to the emulator, waits for it to stop, and returns the
 * `result` or `error` payload of the single JSON-RPC response it produced. Used
 * to assert what the fixture itself does, so the behavioural tests below are not
 * resting on a permissive stub.
 */
function handshake(binaryPath: string, input: string): Record<string, unknown> {
  const result = execFileSync(binaryPath, ["acp"], {
    input,
    encoding: "utf8",
    timeout: 5_000,
  });
  const line = result.split("\n").find((candidate) => candidate.trim().length > 0);
  if (line === undefined) {
    throw new Error("The mcode emulator answered nothing.");
  }
  const envelope = JSON.parse(line) as Record<string, unknown>;
  const payload = envelope.result ?? envelope.error;
  if (payload === undefined) {
    throw new Error(`The mcode emulator answered with neither result nor error: ${line}`);
  }
  return payload as Record<string, unknown>;
}

const reasoningOption = (value: string) => [
  { id: "thinkingEffort", kind: "string" as const, value },
];

/**
 * Runs `body` against a fresh `mcode acp` emulator process and hands it the
 * provider's `TextGeneration` service plus the wire log.
 */
function withEmulatedMcode<A, E, R>(
  env: Record<string, string>,
  body: (
    textGeneration: TextGeneration.TextGeneration["Service"],
    harness: Harness,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-mcode-text-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    );
    const harness = makeEmulator(dir);
    const binaryPath = writeEmulatorCli(dir, harness, env);
    const config = decodeMiniMaxCodeSettings({ binaryPath });
    const textGeneration = yield* makeMiniMaxCodeTextGeneration(config);
    return yield* body(textGeneration, harness);
  }).pipe(Effect.scoped);
}

/**
 * Asserts a generation failed through the typed error channel, never as a
 * defect or a thrown error, and returns the error for further assertions.
 */
function typedFailure<A>(
  effect: Effect.Effect<A, TextGenerationError>,
): Effect.Effect<TextGenerationError, never, never> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (!Exit.isFailure(exit)) {
      return yield* Effect.die(new Error("Expected a failure, but the text generation succeeded."));
    }
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isNone(failure)) {
      return yield* Effect.die(
        new Error(
          `Expected a typed failure, but the effect died: ${Cause.pretty(exit.cause).slice(0, 2000)}`,
        ),
      );
    }
    return failure.value;
  });
}

describe("MiniMaxCodeTextGeneration", () => {
  // The shared mock agent's MiniMax profile is owned by another agent and may
  // not have landed yet. Skip cleanly rather than failing on its absence.
  const sharedMockHasMiniMaxProfile = NodeFS.readFileSync(mockAgentPath, "utf8").includes(
    "T3_ACP_MINIMAX",
  );

  describe("mcode acp 0.5.5 emulator fixture", () => {
    it("rejects every ACP authenticate method id, so 'no authenticate' is a real assertion", () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-mcode-fixture-"));
      try {
        const harness = makeEmulator(dir);
        const binaryPath = writeEmulatorCli(dir, harness, {});
        const request = (id: number, methodId: string) =>
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "authenticate",
            params: { methodId },
          })}\n`;

        // If this fixture ever accepted an authenticate, every "never
        // authenticates" assertion below would be vacuous.
        expect(handshake(binaryPath, request(1, "minimax-code-login"))).toEqual({
          code: -32602,
          message: "Invalid params: Unknown authentication method.",
        });
        expect(handshake(binaryPath, request(2, "oauth-personal"))).toEqual({
          code: -32602,
          message: "Invalid params: Unknown authentication method.",
        });
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("advertises the image/audio-false prompt capabilities and no auth methods", () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-mcode-fixture-"));
      try {
        const harness = makeEmulator(dir);
        const binaryPath = writeEmulatorCli(dir, harness, {});
        const result = handshake(
          binaryPath,
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: "p", version: "0" },
            },
          })}\n`,
        );
        expect(result).toMatchObject({
          protocolVersion: 1,
          agentInfo: { name: "minimax-code", title: "MiniMax Code", version: "0.5.5" },
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
        });
        expect(result).not.toHaveProperty("authMethods");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it.layer(MiniMaxCodeTextGenerationTestLayer)("against a real ACP process", (it) => {
    it.effect("returns a thread title assembled from many streamed assistant chunks", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Investigate the flaky suite" }) },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "the suite is flaky",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            expect(generated.title).toBe("Investigate the flaky suite");
            expect(generated.needsRefinement).toBeUndefined();
            // A thought chunk must not be concatenated into the answer.
            expect(promptText(harness.requestLogPath)).not.toContain("THOUGHT-MUST-NOT-LEAK");
            expect(wireMethods(harness.requestLogPath)).toContain("session/prompt");
          }),
      ),
    );

    it.effect(
      "completes without any ACP authenticate round-trip, because the agent rejects every method id",
      () =>
        withEmulatedMcode(
          { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "No auth needed" }) },
          (textGeneration, harness) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
              });

              // The regression test for the optional-authenticate runtime change.
              // The emulator answers -32602 to every authenticate, so if this
              // path sent one — or if `authMethodId` were still required — the
              // generation above would have failed instead of returning a title.
              expect(generated.title).toBe("No auth needed");
              expect(wireMethods(harness.requestLogPath)).not.toContain("authenticate");
            }),
        ),
    );

    it.effect("never puts an image or audio content block on the wire", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Dropped media" }) },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "look at this",
              attachments: [
                decodeChatAttachment({
                  type: "image",
                  id: "image-1",
                  name: "screenshot.png",
                  mimeType: "image/png",
                  sizeBytes: 4_096,
                }),
                decodeChatAttachment({
                  type: "audio",
                  id: "audio-1",
                  name: "voice-note.m4a",
                  mimeType: "audio/mp4",
                  sizeBytes: 2_048,
                }),
              ],
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            // The agent reports image:false and audio:false, so only text may go out.
            for (const block of promptBlocks(harness.requestLogPath)) {
              expect(block.type).toBe("text");
            }
          }),
      ),
    );

    it.effect("drops an image the agent cannot see but keeps file metadata", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "rename-the-helper" }) },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            yield* textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "name this",
              attachments: [
                decodeChatAttachment({
                  type: "image",
                  id: "image-1",
                  name: "screenshot.png",
                  mimeType: "image/png",
                  sizeBytes: 4_096,
                }),
                decodeChatAttachment({
                  type: "file",
                  id: "file-1",
                  name: "notes.md",
                  mimeType: "text/markdown",
                  sizeBytes: 128,
                }),
              ],
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            const sent = promptText(harness.requestLogPath);
            // The title prompts ask the model to use attached images as primary
            // context, so a surviving line would point at a picture it will
            // never receive.
            expect(sent).not.toContain("screenshot.png");
            expect(sent).not.toContain("image/png");
            // A file's metadata is true on its own, so it stays.
            expect(sent).toContain("notes.md");
          }),
      ),
    );

    it.effect("selects a different model through the model config option", () =>
      withEmulatedMcode(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            subject: "Add the MiniMax Code provider",
            body: "Wire the ACP text generation path.",
          }),
        },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/minimax-code",
              stagedSummary: "M apps/server/src/provider/Drivers/MiniMaxCodeDriver.ts",
              stagedPatch: "diff --git a/... b/...",
              modelSelection: selection("m:minimax:MiniMax-M3:v:thinking"),
            });

            expect(generated.subject).toBe("Add the MiniMax Code provider");
            expect(configOptionWrites(harness.requestLogPath)).toEqual([
              { configId: "model", value: "m:minimax:MiniMax-M3:v:thinking" },
            ]);
            // `session/set_model` does not exist on this agent.
            expect(wireMethods(harness.requestLogPath)).not.toContain("session/set_model");
          }),
      ),
    );

    it.effect("leaves the session's own model alone for the T3 default product slug", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Keep the current model" }) },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "the suite is flaky",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            expect(generated.title).toBe("Keep the current model");
            expect(configOptionWrites(harness.requestLogPath)).toEqual([]);
            // The product slug is a T3 concept the CLI has never heard of: it
            // must not appear anywhere on the wire, not just as a config value.
            expect(harness.rawLog()).not.toContain(MINIMAX_CODE_DEFAULT_MODEL);
          }),
      ),
    );

    it.effect("sends no model write when the requested model is already current", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Already on it" }) },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              // The emulator's currentValue is the Flash-Preview thinking model.
              modelSelection: selection("m:minimax:MiniMax-M3.1-Flash-Preview:v:thinking"),
            });

            expect(configOptionWrites(harness.requestLogPath)).toEqual([]);
          }),
      ),
    );

    it.effect("drops a model id this session no longer advertises", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Retry after a stale slug" }) },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: selection("m:minimax:MiniMax-M2-Retired:v:thinking"),
            });

            // A versioned slug from an older build is not worth failing a title over.
            expect(generated.title).toBe("Retry after a stale slug");
            expect(configOptionWrites(harness.requestLogPath)).toEqual([]);
          }),
      ),
    );

    it.effect("sends a thinking effort the session advertises", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Think harder" }) },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL, reasoningOption("xhigh")),
            });

            expect(configOptionWrites(harness.requestLogPath)).toEqual([
              { configId: "thinkingEffort", value: "xhigh" },
            ]);
          }),
      ),
    );

    it.effect(
      "does not send a thinking effort the newly selected plain model no longer advertises",
      () =>
        withEmulatedMcode(
          { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Plain model still works" }) },
          (textGeneration, harness) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                // `...:v:` is a plain variant: the real CLI answers any
                // thinkingEffort write for it with -32602 "Thinking effort is
                // not advertised for the selected model". The effort is read
                // from the pre-write option list, so it has to be re-checked
                // against the model this turn actually selects.
                modelSelection: selection("m:minimax:MiniMax-M3:v:", reasoningOption("high")),
              });

              expect(generated.title).toBe("Plain model still works");
              expect(configOptionWrites(harness.requestLogPath)).toEqual([
                { configId: "model", value: "m:minimax:MiniMax-M3:v:" },
              ]);
            }),
        ),
    );

    it.effect("bounds a silent agent with a typed timeout error instead of hanging", () =>
      withEmulatedMcode({ T3_ACP_HANG_PROMPT_FOREVER: "1" }, (textGeneration) =>
        Effect.gen(function* () {
          const settled =
            yield* Deferred.make<
              Exit.Exit<TextGeneration.ThreadTitleGenerationResult, TextGenerationError>
            >();
          yield* Effect.forkChild(
            textGeneration
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
              })
              .pipe(
                Effect.exit,
                Effect.tap((exit) => Deferred.succeed(settled, exit)),
              ),
          );

          // The 90s deadline lives on the test clock; the ACP handshake is real
          // IO and needs no clock. Advancing well past the bound trips the
          // timeout whether the agent has answered or not, and the remaining
          // steps let any scope-close timer on the clock run too.
          for (let step = 0; step < 10; step += 1) {
            yield* TestClock.adjust(30_000);
          }
          const exit = yield* Deferred.await(settled);

          const error = yield* typedFailure(Effect.suspend(() => exit));
          expect(error._tag).toBe("TextGenerationError");
          expect(error.operation).toBe("generateThreadTitle");
          expect(error.detail).toMatch(/timed out/i);
        }),
      ),
    );

    it.effect("survives a slow but answering agent inside the bound", () =>
      withEmulatedMcode(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Slow but fine" }),
          T3_ACP_PROMPT_DELAY_MS: "40",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });
            expect(generated.title).toBe("Slow but fine");
          }),
      ),
    );

    it.effect("denies permission and elicitation so a title turn can never block on a person", () =>
      withEmulatedMcode(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Non-interactive" }),
          T3_ACP_EMIT_PERMISSION_REQUEST: "1",
        },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            expect(generated.title).toBe("Non-interactive");
            const permission = readWireRequests(harness.requestLogPath).find(
              (request) => request.method === "@emulator/permission_answer",
            );
            const elicitation = readWireRequests(harness.requestLogPath).find(
              (request) => request.method === "@emulator/elicitation_answer",
            );
            expect(permission?.params).toMatchObject({ outcome: { outcome: "cancelled" } });
            expect(elicitation?.params).toMatchObject({ action: { action: "decline" } });
          }),
      ),
    );

    it.effect("decodes a commit message with the optional branch fragment", () =>
      withEmulatedMcode(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            subject: "feat(minimax): wire the ACP text path",
            body: "  Trimmed body.  ",
            // The prompt asks for a branch *fragment*; the provider is what
            // turns it into a `feature/…` refName.
            branch: "ACP Text Path",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/minimax-code",
              stagedSummary: "M apps/server/src/textGeneration/MiniMaxCodeTextGeneration.ts",
              stagedPatch: "diff --git a/... b/...",
              includeBranch: true,
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            expect(generated.subject).toBe("feat(minimax): wire the ACP text path");
            expect(generated.body).toBe("Trimmed body.");
            expect(generated.branch).toBe("feature/acp-text-path");
          }),
      ),
    );

    it.effect("decodes a PR title and body", () =>
      withEmulatedMcode(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            title: "feat(minimax): add the MiniMax Code text generation path",
            body: "## Summary\n- Add `makeMiniMaxCodeTextGeneration`.\n- Select the model through `session/set_config_option`.",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feat/minimax-code",
              commitSummary: "feat: add minimax code",
              diffSummary: "M apps/server/src/textGeneration/MiniMaxCodeTextGeneration.ts",
              diffPatch: "diff --git a/... b/...",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            expect(generated.title).toBe(
              "feat(minimax): add the MiniMax Code text generation path",
            );
            expect(generated.body).toContain("session/set_config_option");
          }),
      ),
    );

    it.effect("extracts the JSON object when the agent wraps it in conversational text", () =>
      withEmulatedMcode(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT:
            "Sure! Here is the title:\n\n" +
            JSON.stringify({ title: "Investigate failing CI" }) +
            "\n\nLet me know if you need anything else.",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "the lint job is red",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });
            expect(generated.title).toBe("Investigate failing CI");
          }),
      ),
    );

    it.effect("carries needsRefinement through when the subject is still unknown", () =>
      withEmulatedMcode(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            title: "Untitled request",
            needsRefinement: true,
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "fix this",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });
            expect(generated.needsRefinement).toBe(true);
          }),
      ),
    );

    it.effect("fails with a typed error when the agent returns empty output", () =>
      withEmulatedMcode({ T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  " }, (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* typedFailure(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.operation).toBe("generateThreadTitle");
          expect(error.detail).toMatch(/empty/i);
        }),
      ),
    );

    it.effect("fails with a typed error when the output is unparseable", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json from a confused model" },
        (textGeneration) =>
          Effect.gen(function* () {
            const error = yield* typedFailure(
              textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
              }),
            );
            expect(error._tag).toBe("TextGenerationError");
            expect(error.detail).toMatch(/invalid structured output/i);
          }),
      ),
    );

    it.effect("fails with a typed error when the output is missing a required key", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ body: "no title" }) },
        (textGeneration) =>
          Effect.gen(function* () {
            const error = yield* typedFailure(
              textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
              }),
            );
            expect(error._tag).toBe("TextGenerationError");
            expect(error.detail).toMatch(/invalid structured output/i);
          }),
      ),
    );

    it.effect("maps a refused config option write to a typed error", () =>
      withEmulatedMcode(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "never reached" }),
          T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const error = yield* typedFailure(
              textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                modelSelection: selection("m:minimax:MiniMax-M3:v:thinking"),
              }),
            );
            expect(error._tag).toBe("TextGenerationError");
            expect(error.detail).toContain("Failed to select the MiniMax Code model");
          }),
      ),
    );

    it.effect("spawns `mcode acp` with no launch flags, in the caller's cwd", () =>
      withEmulatedMcode(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Spawn shape" }) },
        (textGeneration, harness) =>
          Effect.gen(function* () {
            const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-mcode-cwd-"));
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                NodeFS.rmSync(cwd, { recursive: true, force: true });
              }),
            );

            yield* textGeneration.generateThreadTitle({
              cwd,
              message: "anything",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            // `mcode acp` takes no options; the model is a session config option.
            expect(NodeFS.readFileSync(harness.argvLogPath, "utf8").trim()).toBe("acp");
            expect(NodeFS.readFileSync(harness.cwdLogPath, "utf8")).toBe(NodeFS.realpathSync(cwd));
          }),
      ),
    );
  });

  it.layer(MiniMaxCodeTextGenerationTestLayer)("against the shared ACP mock agent", (it) => {
    function withSharedMock<A, E, R>(
      env: Record<string, string>,
      body: (
        textGeneration: TextGeneration.TextGeneration["Service"],
        requestLogPath: string,
      ) => Effect.Effect<A, E, R>,
    ) {
      return Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-mcode-shared-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(dir, { recursive: true, force: true });
          }),
        );
        const requestLogPath = NodePath.join(dir, "requests.ndjson");
        const binaryPath = writeFakeCli({
          directory: NodePath.join(dir, "bin"),
          name: "mcode",
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...env },
          source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
        });
        const textGeneration = yield* makeMiniMaxCodeTextGeneration(
          decodeMiniMaxCodeSettings({ binaryPath }),
        );
        return yield* body(textGeneration, requestLogPath);
      }).pipe(Effect.scoped);
    }

    it.effect("generates through the shared agent and never authenticates", () =>
      withSharedMock(
        { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Shared mock title" }) },
        (textGeneration, requestLogPath) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "the suite is flaky",
              modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
            });

            expect(generated.title).toBe("Shared mock title");
            const methods = wireMethods(requestLogPath);
            expect(methods).toContain("session/new");
            expect(methods).not.toContain("authenticate");
          }),
      ),
    );

    it.effect("maps a refused set_config_option to a typed error", () =>
      withSharedMock(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "never reached" }),
          T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const error = yield* typedFailure(
              textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                // The shared mock's default profile advertises a Codex-shaped
                // model list, so this only exercises the error mapping.
                modelSelection: selection("composer-2"),
              }),
            );
            expect(error._tag).toBe("TextGenerationError");
            expect(error.detail).toContain("Failed to select the MiniMax Code model");
          }),
      ),
    );

    // The `T3_ACP_MINIMAX=1` profile of the shared agent reproduces the real
    // `mcode acp` 0.5.5 session surface (no `models` block, no `authMethods`,
    // `authenticate` rejected for every id, `thinkingEffort` only advertised
    // for `:thinking` variants). Running the ground-truth assertions here too
    // separates a defect in the provider from an artifact of the emulator above.
    const minimaxProfileEnv = { T3_ACP_MINIMAX: "1" } as const;

    it.effect.skipIf(!sharedMockHasMiniMaxProfile)(
      "runs end to end against the shared agent's T3_ACP_MINIMAX=1 profile",
      () =>
        withSharedMock(
          {
            ...minimaxProfileEnv,
            T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Profile title" }),
          },
          (textGeneration, requestLogPath) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "the suite is flaky",
                modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL),
              });

              expect(generated.title).toBe("Profile title");
              const methods = wireMethods(requestLogPath);
              expect(methods).not.toContain("authenticate");
              // `mcode acp` does not know `session/set_model` at all.
              expect(methods).not.toContain("session/set_model");
              // The product slug means "keep the session's current model".
              expect(configOptionWrites(requestLogPath)).toEqual([]);
              expect(NodeFS.readFileSync(requestLogPath, "utf8")).not.toContain(
                MINIMAX_CODE_DEFAULT_MODEL,
              );
            }),
        ),
    );

    it.effect.skipIf(!sharedMockHasMiniMaxProfile)(
      "selects a model through the model config option on the shared agent",
      () =>
        withSharedMock(
          {
            ...minimaxProfileEnv,
            T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Model switched" }),
          },
          (textGeneration, requestLogPath) =>
            Effect.gen(function* () {
              yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                modelSelection: selection("m:minimax:MiniMax-M3:v:thinking"),
              });

              expect(configOptionWrites(requestLogPath)).toEqual([
                { configId: "model", value: "m:minimax:MiniMax-M3:v:thinking" },
              ]);
            }),
        ),
    );

    it.effect.skipIf(!sharedMockHasMiniMaxProfile)(
      "sends a thinking effort the session advertises on the shared agent",
      () =>
        withSharedMock(
          {
            ...minimaxProfileEnv,
            T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Effort applied" }),
          },
          (textGeneration, requestLogPath) =>
            Effect.gen(function* () {
              yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                modelSelection: selection(MINIMAX_CODE_DEFAULT_MODEL, reasoningOption("high")),
              });

              expect(configOptionWrites(requestLogPath)).toEqual([
                { configId: "thinkingEffort", value: "high" },
              ]);
            }),
        ),
    );

    it.effect.skipIf(!sharedMockHasMiniMaxProfile)(
      "does not send a thinking effort the newly selected plain model no longer advertises (shared agent)",
      () =>
        withSharedMock(
          {
            ...minimaxProfileEnv,
            T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Plain model still works" }),
          },
          (textGeneration, requestLogPath) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "anything",
                modelSelection: selection("m:minimax:MiniMax-M3:v:", reasoningOption("high")),
              });

              expect(generated.title).toBe("Plain model still works");
              expect(configOptionWrites(requestLogPath)).toEqual([
                { configId: "model", value: "m:minimax:MiniMax-M3:v:" },
              ]);
            }),
        ),
    );

    it.effect.skipIf(!sharedMockHasMiniMaxProfile)(
      "maps a refused set_config_option to a typed error on the shared agent",
      () =>
        withSharedMock(
          {
            ...minimaxProfileEnv,
            T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "never reached" }),
            T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
          },
          (textGeneration) =>
            Effect.gen(function* () {
              const error = yield* typedFailure(
                textGeneration.generateThreadTitle({
                  cwd: process.cwd(),
                  message: "anything",
                  modelSelection: selection("m:minimax:MiniMax-M3:v:thinking"),
                }),
              );
              expect(error._tag).toBe("TextGenerationError");
              expect(error.detail).toContain("Failed to select the MiniMax Code model");
            }),
        ),
    );
  });
});
