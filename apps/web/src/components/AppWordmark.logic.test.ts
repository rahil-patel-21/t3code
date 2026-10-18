import { describe, expect, it } from "vite-plus/test";

import { resolveAppWordmarkParts } from "./AppWordmark.logic";

describe("resolveAppWordmarkParts", () => {
  it("keeps the glyph and caption for the stock name", () => {
    expect(resolveAppWordmarkParts("T3 Code")).toEqual({
      usesT3Glyph: true,
      caption: "Code",
    });
  });

  it("renders the glyph alone when the name is only the mark", () => {
    expect(resolveAppWordmarkParts("T3")).toEqual({ usesT3Glyph: true, caption: "" });
  });

  it("drops the glyph once a fork renames the product", () => {
    expect(resolveAppWordmarkParts("Code")).toEqual({ usesT3Glyph: false, caption: "Code" });
    expect(resolveAppWordmarkParts("Acme IDE")).toEqual({
      usesT3Glyph: false,
      caption: "Acme IDE",
    });
  });

  it("only treats a standalone T3 token as the mark", () => {
    expect(resolveAppWordmarkParts("T3Tools")).toEqual({
      usesT3Glyph: false,
      caption: "T3Tools",
    });
    expect(resolveAppWordmarkParts("T30")).toEqual({ usesT3Glyph: false, caption: "T30" });
  });

  it("tolerates surrounding and repeated whitespace", () => {
    expect(resolveAppWordmarkParts("  T3   Code  ")).toEqual({
      usesT3Glyph: true,
      caption: "Code",
    });
  });

  it("keeps a multi-word caption intact", () => {
    expect(resolveAppWordmarkParts("T3 Code Studio")).toEqual({
      usesT3Glyph: true,
      caption: "Code Studio",
    });
  });
});
