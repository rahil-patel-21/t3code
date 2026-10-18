import * as Schema from "effect/Schema";

class CatalogDependencyResolutionError extends Schema.TaggedError<CatalogDependencyResolutionError>()(
  "CatalogDependencyResolutionError",
  {
    workspacePackage: Schema.String,
    dependencyName: Schema.String,
    catalogSpec: Schema.String,
    catalogKey: Schema.String,
  },
) {
  override get message(): string {
    return `Unable to resolve '${this.catalogSpec}' for ${this.workspacePackage} dependency '${this.dependencyName}'. Expected key '${this.catalogKey}' in root workspace catalog.`;
  }
}

/**
 * Strip a trailing version range from a package selector.
 *
 * Catalog keys are bare package names, but a pnpm override key is a selector
 * that may carry a range (`undici@^8`, `@types/node@24`). Searching from index
 * 1 skips the scope marker of a bare scoped name like `@clerk/backend`.
 */
function selectorPackageName(selector: string): string {
  const rangeSeparator = selector.indexOf("@", 1);
  return rangeSeparator === -1 ? selector : selector.slice(0, rangeSeparator);
}

export function resolveCatalogDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  workspacePackage: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [name, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      // An override key is a selector: `parent[@range]>target[@range]`. Like
      // pnpm, a bare `catalog:` there means the catalog entry of the package the
      // selector targets, so both the parent part and any version range come
      // off before the lookup (`undici@^8` and `@opencode/protocol>effect`
      // both resolve against the bare `undici` and `effect` entries).
      const lookupKey =
        catalogKey.length > 0 ? catalogKey : selectorPackageName(name.split(">").at(-1) ?? name);
      const resolved = catalog[lookupKey];

      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new CatalogDependencyResolutionError({
          workspacePackage,
          dependencyName: name,
          catalogSpec: spec,
          catalogKey: lookupKey,
        });
      }

      return [name, resolved];
    }),
  );
}
