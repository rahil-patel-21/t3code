import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import { discoverMiniMaxCodeSkills } from "./MiniMaxCodeSkills.ts";

const SKILL_MD = "SKILL.md";

/** Each fixture is a skill directory: `directory/name/SKILL.md`. */
const skill = (directory: string, name: string, contents: string) => ({
  directory,
  name,
  contents,
});

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

/** Write the fixtures under a fresh temp data directory and return its path. */
const withSkills = (
  fixtures: ReadonlyArray<{ directory: string; name: string; contents: string }>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      directory: NodeOS.tmpdir(),
      prefix: "minimax-skills-",
    });
    for (const entry of fixtures) {
      const directory = path.join(root, entry.directory, entry.name);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(path.join(directory, SKILL_MD), entry.contents);
    }
    return root;
  });

describe("discoverMiniMaxCodeSkills", () => {
  it("reads skills from the user and builtin roots", async () =>
    await runNode(
      Effect.gen(function* () {
        const root = yield* withSkills([
          skill("skills", "review", `---\nname: review\ndescription: Review a change\n---\n`),
          skill(".builtin-skills", "docx", `---\nname: docx\ndescription: Work with docx\n---\n`),
        ]);

        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: root },
        });

        expect(skills.map((entry) => entry.name)).toEqual(["docx", "review"]);
        expect(skills.find((entry) => entry.name === "review")).toMatchObject({
          description: "Review a change",
          enabled: true,
          scope: "user",
        });
      }),
    ));

  it("returns an empty list when the data directory does not exist", async () =>
    await runNode(
      Effect.gen(function* () {
        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: "/nonexistent/minimax/data" },
        });
        expect(skills).toEqual([]);
      }),
    ));

  it("lets the user root win over the builtin copy of the same name", async () =>
    await runNode(
      Effect.gen(function* () {
        const root = yield* withSkills([
          skill("skills", "shared", `---\ndescription: User copy\n---\n`),
          skill(".builtin-skills", "shared", `---\ndescription: Builtin copy\n---\n`),
        ]);

        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: root },
        });

        expect(skills).toHaveLength(1);
        expect(skills[0]?.description).toBe("User copy");
      }),
    ));

  it("keeps a multi-line plain description as one line", async () =>
    await runNode(
      Effect.gen(function* () {
        const root = yield* withSkills([
          skill(
            "skills",
            "code-review",
            [
              "---",
              "name: code-review",
              "description:",
              "  Review local uncommitted changes, commits, branches, or files for",
              "  concrete defects.",
              "---",
              "",
              "# Code Review",
            ].join("\n"),
          ),
        ]);

        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: root },
        });

        expect(skills[0]?.description).toBe(
          "Review local uncommitted changes, commits, branches, or files for concrete defects.",
        );
      }),
    ));

  it("reads a folded block scalar", async () =>
    await runNode(
      Effect.gen(function* () {
        const root = yield* withSkills([
          skill(
            "skills",
            "deep-research",
            [
              "---",
              "name: deep-research",
              "description: >-",
              "  Use this skill for complex, open-ended Deep Research tasks that",
              "  require external information verification.",
              "---",
            ].join("\n"),
          ),
        ]);

        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: root },
        });

        expect(skills[0]?.description).toBe(
          "Use this skill for complex, open-ended Deep Research tasks that require external information verification.",
        );
      }),
    ));

  it("skips nested metadata without mistaking it for a description", async () =>
    await runNode(
      Effect.gen(function* () {
        const root = yield* withSkills([
          skill(
            ".builtin-skills",
            "docx",
            [
              "---",
              "name: docx",
              "metadata:",
              '  version: "4.0.0"',
              "  category: document-processing",
              "  sources:",
              '    - "ECMA-376"',
              "---",
              "",
              "# DOCX",
            ].join("\n"),
          ),
        ]);

        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: root },
        });

        expect(skills.map((entry) => entry.name)).toEqual(["docx"]);
        expect(skills[0]?.description).toBeUndefined();
      }),
    ));

  it("ignores a directory with no SKILL.md and a stray non-directory entry", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          directory: NodeOS.tmpdir(),
          prefix: "minimax-skills-stray-",
        });
        yield* fileSystem.makeDirectory(path.join(root, "skills", "empty-dir"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(root, "skills", "README.md"), "not a skill");
        yield* fileSystem.makeDirectory(path.join(root, "skills", "real"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(root, "skills", "real", SKILL_MD),
          `---\ndescription: Real one\n---\n`,
        );

        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: root },
        });

        expect(skills.map((entry) => entry.name)).toEqual(["real"]);
      }),
    ));

  it("keys the command off the directory name, not the frontmatter name", async () =>
    await runNode(
      Effect.gen(function* () {
        const root = yield* withSkills([
          skill(
            "skills",
            "probe-alias",
            `---\nname: probe-alias-frontmatter\ndescription: Alias\n---\n`,
          ),
        ]);

        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: root },
        });

        expect(skills.map((entry) => entry.name)).toEqual(["probe-alias"]);
      }),
    ));

  it("skips a skill whose frontmatter has no closing delimiter", async () =>
    await runNode(
      Effect.gen(function* () {
        const root = yield* withSkills([
          skill("skills", "broken", "---\nname: broken\ndescription: never closed\n"),
          skill("skills", "fine", `---\ndescription: Fine\n---\n`),
        ]);

        const skills = yield* discoverMiniMaxCodeSkills({
          environment: { MINIMAX_DATA_DIR: root },
        });

        expect(skills.map((entry) => entry.name)).toEqual(["fine"]);
      }),
    ));
});
