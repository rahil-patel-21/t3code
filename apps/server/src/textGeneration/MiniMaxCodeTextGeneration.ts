/**
 * MiniMax Code text generation — commit messages, PR content, branch names and
 * thread titles from a short-lived `mcode acp` session.
 *
 * The turn is a plain ACP session rather than a CLI subcommand because `mcode`
 * has no headless text mode. Two properties of this provider shape it:
 *
 * - `mcode` exposes no ACP `authenticate` method (`mcode login` owns sign-in), so
 *   the runtime is built with the round-trip disabled and no credential is ever
 *   put on the wire.
 * - There is no `models` block. The model is the `category: "model"` config
 *   option, so selection goes through `session/set_config_option`.
 *
 * @module textGeneration/MiniMaxCodeTextGeneration
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  type ChatAttachment,
  type MiniMaxCodeSettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type { AcpSessionRuntime } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  makeMiniMaxCodeAcpRuntime,
  MINIMAX_CODE_DEFAULT_MODEL_SLUG,
  MINIMAX_CODE_MODEL_CONFIG_ID,
  MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID,
  currentMiniMaxCodeModelIdFromConfigOptions,
  miniMaxCodeModelIdsFromConfigOptions,
  miniMaxCodeThinkingEffortFromModelSelection,
  normalizeMiniMaxCodeThinkingEffort,
  resolveMiniMaxCodeAcpBaseModelId,
} from "../provider/acp/MiniMaxCodeAcpSupport.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "@t3tools/provider-core/server/textGenerationPrompts";
import { investigationUnsupported } from "@t3tools/provider-core/server/textGenerationOperations";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "@t3tools/provider-core/server/textGenerationUtils";

/**
 * Half the 180s the Grok and Cursor helpers allow. A title, summary or branch
 * name is one short structured answer with no tool use, and the caller is a
 * spinner the user is already watching, so the budget only has to cover a cold
 * `mcode acp` process start plus a single fast turn — not a long agentic run.
 */
const MINIMAX_CODE_TIMEOUT_MS = 90_000;

const isTextGenerationError = Schema.is(TextGenerationError);

type TextGenerationOp = keyof TextGeneration.TextGeneration["Service"];

type MiniMaxCodeConfigOptions = ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

type MiniMaxCodeModelRuntime = Pick<
  AcpSessionRuntime["Service"],
  "getConfigOptions" | "setConfigOption"
>;

/**
 * The model id to put on the wire, or `undefined` to leave the session's own
 * model in place. The advertised option list is the authority, exactly as it is
 * for thinking effort: `minimax-code-default` is a T3 product slug the CLI has
 * never heard of, and a versioned slug the CLI no longer offers is rejected
 * outright. Dropping both is why the default model path sends no
 * `session/set_config_option` at all — the session the runtime just opened
 * already answers on a real model, which is all a title needs.
 */
function advertisedMiniMaxCodeModelId(
  model: string | null | undefined,
  configOptions: MiniMaxCodeConfigOptions,
): string | undefined {
  const requested = resolveMiniMaxCodeAcpBaseModelId(model);
  if (requested === MINIMAX_CODE_DEFAULT_MODEL_SLUG) {
    return undefined;
  }
  return miniMaxCodeModelIdsFromConfigOptions(configOptions).includes(requested)
    ? requested
    : undefined;
}

/**
 * `mcode` advertises `promptCapabilities.image: false`, and the shared prompt
 * builders only ever send a text block plus one metadata line per attachment.
 * Keeping an image line would tell the model an image exists that it can never
 * see, and the title prompts explicitly ask it to use attached images as
 * primary context, so images are dropped before the prompt is built. File
 * attachments survive: their metadata is true on its own.
 */
function withoutImages(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ReadonlyArray<ChatAttachment> | undefined {
  if (!attachments) {
    return undefined;
  }
  const kept = attachments.filter(
    (attachment) =>
      attachment.type !== "image" && !attachment.mimeType.toLowerCase().startsWith("image/"),
  );
  return kept.length === attachments.length ? attachments : kept;
}

/**
 * Build a MiniMax Code text-generation closure bound to a specific
 * `MiniMaxCodeSettings` payload. See `makeCodexAdapter` for the overall
 * per-instance rationale.
 */
export const makeMiniMaxCodeTextGeneration = Effect.fn("makeMiniMaxCodeTextGeneration")(function* (
  miniMaxCodeSettings: MiniMaxCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /**
   * Selects the model and thinking effort through the session's config options.
   * `mcode acp` takes no launch flags and `session/set_model` does not exist, so
   * this is the only model channel. A no-op selection is left unsent rather than
   * written, which keeps the turn to zero extra round-trips in the common case.
   */
  const applyModelSelection = (
    runtime: MiniMaxCodeModelRuntime,
    modelSelection: ModelSelection,
    operation: TextGenerationOp,
  ): Effect.Effect<void, TextGenerationError> =>
    Effect.gen(function* () {
      let configOptions = yield* runtime.getConfigOptions;
      const modelId = advertisedMiniMaxCodeModelId(modelSelection.model, configOptions);
      if (
        modelId !== undefined &&
        modelId !== currentMiniMaxCodeModelIdFromConfigOptions(configOptions)
      ) {
        const refreshed = yield* runtime
          .setConfigOption(MINIMAX_CODE_MODEL_CONFIG_ID, modelId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: `Failed to select the MiniMax Code model for text generation.`,
                  cause,
                }),
            ),
          );
        // The write replies with the agent's refreshed option list, and it has to be
        // the one used below: selecting a model that takes no thinking variant drops
        // `thinkingEffort` from what the agent advertises, and sending an effort the
        // selected model no longer accepts fails with -32602. Reusing the pre-write
        // list made every title and summary fail once a thinking effort was saved and
        // the user then picked a plain model.
        if (refreshed.configOptions) {
          configOptions = refreshed.configOptions;
        }
      }
      const thinkingEffort = normalizeMiniMaxCodeThinkingEffort(
        miniMaxCodeThinkingEffortFromModelSelection(modelSelection),
        configOptions,
      );
      if (thinkingEffort !== undefined) {
        yield* runtime.setConfigOption(MINIMAX_CODE_THINKING_EFFORT_CONFIG_ID, thinkingEffort).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Failed to select the MiniMax Code thinking effort for text generation.`,
                cause,
              }),
          ),
        );
      }
    });

  const runMiniMaxCodeJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: TextGenerationOp;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeMiniMaxCodeAcpRuntime({
        miniMaxCodeSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      // A title turn must never edit the workspace or block on a person, and
      // `mcode` opens its session in an interactive permission mode. Denying both
      // callbacks makes the helper non-interactive by construction instead of by
      // hoping the model answers a JSON question without reaching for a tool.
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
      );
      yield* runtime.handleElicitation(() => Effect.succeed({ action: "decline" as const }));

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* applyModelSelection(runtime, modelSelection, operation);
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(MINIMAX_CODE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "MiniMax Code request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "MiniMax Code ACP request failed.",
                cause,
              }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "MiniMax Code request was cancelled."
              : "MiniMax Code returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "MiniMax Code returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "MiniMax Code ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("MiniMaxCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runMiniMaxCodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("MiniMaxCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runMiniMaxCodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("MiniMaxCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: withoutImages(input.attachments),
      });

      const generated = yield* runMiniMaxCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("MiniMaxCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: withoutImages(input.attachments),
      });

      const generated = yield* runMiniMaxCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    // `mcode acp` starts at its own bypassPermissions default, so it has no read-only mode to
    // investigate a checkout with.
    generateReviewGuide: () =>
      Effect.fail(investigationUnsupported("generateReviewGuide", "MiniMax Code")),
  } satisfies TextGeneration.TextGeneration["Service"];
});
