import type { ProjectEntry } from "@t3tools/contracts";
import { isWindowsAbsolutePath, isAbsolutePath } from "@t3tools/shared/path";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
}

export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const hostPath = isAbsolutePath(relativePath);
  const separator = isWindowsAbsolutePath(relativePath) ? "\\" : "/";
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : hostPath && separator === "/" ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => {
      const path = root + parts.slice(0, index + 1).join(separator);
      return {
        label: part,
        // A bare drive (`C:`) means the drive's current directory; its root is `C:\`.
        path: /^[A-Za-z]:$/.test(path) ? `${path}\\` : path,
        kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

/**
 * `relativePath` written the way its own crumb names it, so a link with a
 * trailing or repeated separator still finds its crumb.
 */
export function breadcrumbPathOf(relativePath: string): string {
  return fileBreadcrumbs("", relativePath).at(-1)?.path ?? relativePath;
}

/**
 * Whether a host folder crumb names a directory the server can list. A UNC
 * server (`\\server`) is not one; its shares (`\\server\share`) are.
 */
export function isListableHostFolder(path: string): boolean {
  return isAbsolutePath(path) && !/^\\\\[^\\/]+$/.test(path);
}

/** Index of `path`'s crumb among `trail`'s crumbs; -1 when the trail does not pass through it. */
function trailCrumbIndex(trail: string, path: string): number {
  const crumbPath = breadcrumbPathOf(path);
  return fileBreadcrumbs("", trail).findIndex((crumb) => crumb.path === crumbPath);
}

/**
 * The deepest path the breadcrumbs keep showing after the browser moves to `path`.
 * Going up keeps the folders below visible so the way back down is one click;
 * moving anywhere else starts over at `path`.
 */
export function retainedBreadcrumbTrail(trail: string | undefined, path: string): string {
  return trail !== undefined && trailCrumbIndex(trail, path) >= 0 ? trail : path;
}

/** The entry of `folder` that leads toward `trail`; null when the trail ends at the folder. */
export function trailChildOf(folder: string, trail: string): string | null {
  const index = trailCrumbIndex(trail, folder);
  return index < 0 ? null : (fileBreadcrumbs("", trail)[index + 1]?.label ?? null);
}

/**
 * A host path for `relativePath` (as a host folder's listing names it, with `/`)
 * inside host folder `folder`, using the folder's own separator.
 */
export function joinHostPath(folder: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(folder) ? "\\" : "/";
  const base = folder.endsWith(separator) ? folder : `${folder}${separator}`;
  return base + relativePath.split("/").join(separator);
}

export function fileBreadcrumbChildren(
  entries: readonly ProjectEntry[],
  directoryPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const label = entry.path.slice(prefix.length);
      if (!label || label.includes("/")) return [];
      return [{ ...entry, label }];
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      collator ??= new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return collator.compare(left.label, right.label);
    });
}

export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath) return null;
  const separatorIndex = directoryPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}

/** Dependency, build, and cache folders no one browses, hidden even without a .gitignore. */
const GENERATED_FOLDERS = new Set([
  // Version control metadata (.git never reaches the client)
  ".svn",
  ".hg",
  "CVS",
  // JavaScript / TypeScript
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".angular",
  ".expo",
  ".docusaurus",
  ".turbo",
  ".parcel-cache",
  ".nyc_output",
  ".vercel",
  ".netlify",
  ".wrangler",
  ".serverless",
  // Python
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  ".eggs",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".pytype",
  ".hypothesis",
  ".ipynb_checkpoints",
  "htmlcov",
  // JVM, .NET, Apple, Dart
  ".gradle",
  ".vs",
  "DerivedData",
  ".build",
  ".dart_tool",
  ".pub-cache",
  // Elixir, Haskell, Elm, OCaml, Zig, C/C++, Terraform, Sass
  "_build",
  ".elixir_ls",
  ".stack-work",
  "dist-newstyle",
  "elm-stuff",
  "_opam",
  ".zig-cache",
  "zig-cache",
  "zig-out",
  "CMakeFiles",
  ".terraform",
  ".sass-cache",
]);

/**
 * Names that are build output or vendored dependencies in one ecosystem but
 * real source in another (Ruby's `bin/` scripts, a committed Go `vendor/`), so
 * they hide only when the project's .gitignore says they are generated.
 */
const IGNORED_OUTPUT_FOLDERS = new Set([
  "build",
  "dist",
  "out",
  "target",
  "bin",
  "obj",
  "vendor",
  "deps",
  "Pods",
  "coverage",
  ".bundle",
  ".idea",
  ".output",
  ".cache",
]);

/** OS clutter, hidden like VS Code's default `files.exclude`. */
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db"]);

function isHiddenEntry(entry: ProjectEntry): boolean {
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  if (entry.kind !== "directory") return JUNK_FILES.has(name);
  return (
    GENERATED_FOLDERS.has(name) ||
    name.endsWith(".egg-info") ||
    name.startsWith("cmake-build-") ||
    (entry.ignored === true && IGNORED_OUTPUT_FOLDERS.has(name))
  );
}

/**
 * Drops dependency, build, and cache folders for every common language, with
 * everything under them, plus OS clutter. Everything else stays, including
 * gitignored files such as `.env` and ignored folders such as `logs/`, which
 * the tree shows dimmed.
 */
export function hideGeneratedEntries<T extends ProjectEntry>(entries: readonly T[]): T[] {
  const hiddenFolders = entries
    .filter((entry) => entry.kind === "directory" && isHiddenEntry(entry))
    .map((entry) => `${entry.path}/`);
  return entries.filter(
    (entry) =>
      !isHiddenEntry(entry) && !hiddenFolders.some((folder) => entry.path.startsWith(folder)),
  );
}
