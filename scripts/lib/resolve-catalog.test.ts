import { assert, describe, it } from "@effect/vitest";

import { resolveCatalogDependencies } from "./resolve-catalog.ts";

const catalog = {
  effect: "4.0.0-rc.115",
  "@clerk/backend": "3.18.1",
  "@types/node": "24.12.4",
  react: "19.2.0",
  undici: "8.11.2",
  ws: "8.22.0",
};

describe("resolveCatalogDependencies", () => {
  it("resolves bare, named and override-selector catalog specs like pnpm", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          "@clerk/backend": "catalog:",
          "react-dom": "catalog:react",
          "@opencode/protocol>effect": "catalog:",
          "dbus-next>usocket": "-",
          lodash: "4.17.21",
        },
        catalog,
        "apps/desktop",
      ),
      {
        "@clerk/backend": "3.18.1",
        "react-dom": "19.2.0",
        "@opencode/protocol>effect": "4.0.0-rc.115",
        "dbus-next>usocket": "-",
        lodash: "4.17.21",
      },
    );
  });

  // The workspace overrides pin whole ranges ("undici@^8": "catalog:"), where
  // pnpm looks the bare package name up in the catalog.
  it("resolves override selectors that carry a version range", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          "undici@^8": "catalog:",
          "@types/node@^24": "catalog:",
          "@opencode/protocol@^2>effect@^4": "catalog:",
          "ws@^8": "catalog:ws",
        },
        catalog,
        "apps/desktop",
      ),
      {
        "undici@^8": "8.11.2",
        "@types/node@^24": "24.12.4",
        "@opencode/protocol@^2>effect@^4": "4.0.0-rc.115",
        "ws@^8": "8.22.0",
      },
    );
  });

  it("fails on a catalog entry that does not exist", () => {
    assert.throws(
      () => resolveCatalogDependencies({ "a>missing": "catalog:" }, catalog, "apps/desktop"),
      /Expected key 'missing' in root workspace catalog/,
    );
  });

  it("fails on a version-selector override key with no catalog entry", () => {
    assert.throws(
      () => resolveCatalogDependencies({ "missing@^8": "catalog:" }, catalog, "apps/desktop"),
      /Expected key 'missing' in root workspace catalog/,
    );
  });

  it("resolves version-qualified overrides without changing their selectors", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          "undici@^8": "catalog:",
          "ws@^8": "catalog:",
          "@clerk/backend@^3": "catalog:",
          "@scope/parent@^1>undici@^8": "catalog:",
          "parent@^1>@clerk/backend@^3": "catalog:",
        },
        { ...catalog, undici: "8.11.2", ws: "8.21.0" },
        "apps/desktop",
      ),
      {
        "undici@^8": "8.11.2",
        "ws@^8": "8.21.0",
        "@clerk/backend@^3": "3.18.1",
        "@scope/parent@^1>undici@^8": "8.11.2",
        "parent@^1>@clerk/backend@^3": "3.18.1",
      },
    );
  });
});
