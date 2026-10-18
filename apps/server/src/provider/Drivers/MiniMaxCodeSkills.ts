import type { ServerProviderSkill } from "@t3tools/contracts";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Skill discovery for MiniMax Code.
 *
 * MiniMax Code has no SDK that reports its skills the way the Claude and Codex
 * providers do, so the only honest source is the filesystem the CLI itself
 * reads. The roots below are taken from `mcode`'s own data-directory lookup
 * (0.6.2), which treats `[<dataDir>, ~/.minimax]` as the data directory and
 * recognises `skills/`, `.builtin-skills/`, and `agents/<agent>/skills/` under
 * it. `<agent>` is null here because T3 does not select a named sub-agent, so
 * the per-agent root does not apply.
 *
 * Each skill is a directory holding a `SKILL.md` with YAML frontmatter.
 *
 * Discovery is best-effort and never fails the snapshot: an unreadable root or
 * a malformed entry is skipped so one broken skill cannot hide every other one.
 * The first root to claim a name wins, matching how the CLI resolves them, so
 * reporting a lower-precedence copy would publish a command that does not run.
 */
export const discoverMiniMaxCodeSkills = Effect.fn("discoverMiniMaxCodeSkills")(
  function* (options?: {
    readonly dataDir?: string;
    readonly environment?: NodeJS.ProcessEnv;
  }): Effect.fn.Return<
    ReadonlyArray<ServerProviderSkill>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = options?.environment ?? process.env;
    const dataDir = resolveMiniMaxCodeDataDir(path, environment);

    const roots: ReadonlyArray<{ directory: string; scope: string }> = [
      { directory: path.join(dataDir, "skills"), scope: "user" },
      // Shipped with the CLI, but user-visible and user-invocable like the rest.
      { directory: path.join(dataDir, ".builtin-skills"), scope: "user" },
    ];

    const skillsByName = new Map<string, ServerProviderSkill>();
    for (const root of roots) {
      const entries = yield* fileSystem
        .readDirectory(root.directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

      for (const entry of [...entries].sort()) {
        const name = entry.trim();
        // A stray file beside the skills is not a skill; the CLI only descends
        // into directories that hold a SKILL.md.
        if (!name || name.startsWith(".")) {
          continue;
        }
        const skillPath = path.join(root.directory, name, "SKILL.md");
        const contents = yield* fileSystem
          .readFileString(skillPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (contents === undefined) {
          continue;
        }

        const frontmatter = parseSkillFrontmatter(contents);
        if (frontmatter.kind === "malformed") {
          continue;
        }

        // The directory name is the command the CLI answers to, which is what
        // `mcode` sends back on `/name`. Keying off the frontmatter `name` would
        // publish a command that does not exist.
        if (skillsByName.has(name)) {
          continue;
        }

        skillsByName.set(name, {
          name,
          path: skillPath,
          enabled: true,
          scope: root.scope,
          ...(frontmatter.kind === "parsed" && frontmatter.description
            ? { description: frontmatter.description, shortDescription: frontmatter.description }
            : {}),
          ...(frontmatter.kind === "parsed" && frontmatter.displayName
            ? { displayName: frontmatter.displayName }
            : {}),
          ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
            ? { userInvocable: false }
            : {}),
        });
      }
    }

    return [...skillsByName.values()].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  },
);

/**
 * Resolve the data directory the CLI would use. The CLI honours an explicit
 * data directory and otherwise falls back to `~/.minimax`; a server-owned
 * override wins over both so a hosted instance can point somewhere else.
 */
const resolveMiniMaxCodeDataDir = (path: Path.Path, environment: NodeJS.ProcessEnv): string => {
  const override = environment.MINIMAX_DATA_DIR?.trim();
  if (override) {
    return override;
  }
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || "";
  return home ? path.join(home, ".minimax") : path.join(".minimax");
};

type SkillFrontmatter =
  | { kind: "missing" }
  | { kind: "malformed" }
  | {
      kind: "parsed";
      description?: string;
      displayName?: string;
      userInvocable?: boolean;
    };

const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

/**
 * A second, unterminated frontmatter marker means the block never closed, so
 * there is no frontmatter to read. `[\s\S]*?` would otherwise happily span a
 * later `---` inside the body and produce a bogus description.
 */
const UNCLOSED_FRONTMATTER_PATTERN = /^---[ \t]*\r?\n[\s\S]*\r?\n---/u;

/** Top-level `key:` lines only; nested metadata keys are indented past this. */
const TOP_LEVEL_KEY_PATTERN = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t](.*))?$/u;

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const firstLineEnd = contents.indexOf("\n");
  if (firstLineEnd !== -1 && /^---[ \t]*\r?$/u.test(contents.slice(0, firstLineEnd))) {
    if (!UNCLOSED_FRONTMATTER_PATTERN.test(contents)) {
      return { kind: "malformed" };
    }
  }
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const parsed: { description?: string; displayName?: string; userInvocable?: boolean } = {};
  const lines = (match[1] ?? "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // Indented lines belong to the previous key: either a nested mapping or a
    // block scalar, both handled below. They are never keys in their own right.
    if (/^[ \t]/u.test(line)) {
      continue;
    }
    const entry = TOP_LEVEL_KEY_PATTERN.exec(line);
    if (!entry) {
      if (line.trim().length > 0) {
        return { kind: "malformed" };
      }
      continue;
    }

    const key = (entry[1] ?? "").toLowerCase();
    const inlineValue = entry[2]?.trim() ?? "";

    if (key === "user-invocable" || key === "userinvocable") {
      parsed.userInvocable = stripQuotes(inlineValue).toLowerCase() === "true";
      continue;
    }
    if (key !== "description" && key !== "name" && key !== "displayname") {
      // Any other top-level key may carry an indented block we must skip over
      // so its contents are not mistaken for this key's value.
      index = skipBlock(lines, index + 1);
      continue;
    }

    const block = readScalar(lines, index, inlineValue);
    index = block.nextIndex;
    const value = block.value;
    if (value.length === 0) {
      continue;
    }
    if (key === "description") {
      parsed.description = value;
    } else {
      parsed.displayName = value;
    }
  }
  return { kind: "parsed", ...parsed };
}

/**
 * Read a YAML scalar that may be inline, folded (`>-`), literal (`|`), or a
 * plain indented block. Shipped skills use all of these, and the composer shows
 * the description beside the command, so dropping it would leave a blank row.
 */
function readScalar(
  lines: ReadonlyArray<string>,
  keyIndex: number,
  inlineValue: string,
): { value: string; nextIndex: number } {
  const marker = inlineValue[0];
  if (marker === ">" || marker === "|") {
    const folded = marker === ">";
    const body: Array<string> = [];
    let cursor = keyIndex + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      // A blank line inside a block is a paragraph break, not a terminator.
      if (line.trim().length === 0) {
        body.push("");
        continue;
      }
      if (!/^[ \t]/u.test(line)) {
        break;
      }
      body.push(stripQuotes(line.trim()));
    }
    const value = (folded ? foldLines(body) : body.join("\n")).trim();
    return { value, nextIndex: cursor - 1 };
  }

  if (inlineValue.length > 0) {
    return { value: stripQuotes(inlineValue), nextIndex: keyIndex };
  }

  // `key:` with the value on following indented lines, e.g.
  //   description:
  //     Review local uncommitted changes ...
  const body: Array<string> = [];
  let cursor = keyIndex + 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (line.trim().length === 0) {
      body.push("");
      continue;
    }
    if (!/^[ \t]/u.test(line)) {
      break;
    }
    body.push(stripQuotes(line.trim()));
  }
  while (body.length > 0 && body[body.length - 1] === "") {
    body.pop();
  }
  return { value: body.join(" ").trim(), nextIndex: cursor - 1 };
}

/** Advance past an indented block belonging to a key we do not consume. */
function skipBlock(lines: ReadonlyArray<string>, start: number): number {
  let cursor = start;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    if (!/^[ \t]/u.test(line)) {
      break;
    }
  }
  return cursor - 1;
}

/** Join folded-scalar lines: a blank line becomes a paragraph break. */
function foldLines(lines: ReadonlyArray<string>): string {
  const paragraphs: Array<string> = [];
  let current: Array<string> = [];
  for (const line of lines) {
    if (line.length === 0) {
      paragraphs.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(line);
  }
  paragraphs.push(current.join(" "));
  return paragraphs.filter((paragraph) => paragraph.length > 0).join("\n\n");
}

function stripQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
