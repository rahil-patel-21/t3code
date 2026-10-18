/**
 * The product lockup pairs drawn brand artwork with the product name, so a fork
 * that renames the product in branding.json would otherwise keep showing the
 * original mark next to its own name. The T3 glyph only belongs in the lockup
 * while the configured name still starts with a standalone "T3" token; every other
 * name gets a plain-text wordmark so a rename never contradicts the artwork.
 */

/** A standalone "T3" token, so "T3Tools" or "T30" keep their own text. */
const T3_PREFIX_PATTERN = /^T3(?=$|[\s._-])/;

export interface AppWordmarkParts {
  /** Whether the name still identifies the T3 mark, so the glyph belongs in the lockup. */
  readonly usesT3Glyph: boolean;
  /** The caption rendered next to the glyph, or alone when there is no glyph. */
  readonly caption: string;
}

export function resolveAppWordmarkParts(baseName: string): AppWordmarkParts {
  const trimmed = baseName.trim();
  if (!T3_PREFIX_PATTERN.test(trimmed)) {
    return { usesT3Glyph: false, caption: trimmed };
  }

  return { usesT3Glyph: true, caption: trimmed.replace(T3_PREFIX_PATTERN, "").trim() };
}
