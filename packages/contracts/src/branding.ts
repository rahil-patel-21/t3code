import branding from "./branding.json" with { type: "json" };

/**
 * The product name users see. Rebrand by editing branding.json. Display only:
 * never derive paths, keychain entries, bundle ids, or other persisted identity
 * from it, or a rename strands existing installs.
 */
export const APP_BASE_NAME = branding.name;

// ponytail: the name is spliced unescaped into HTML, shell, and PowerShell text, so keep it plain.
if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._-]*$/u.test(APP_BASE_NAME)) {
  throw new Error(`branding.json "name" must be letters, digits, spaces, ".", "_" or "-".`);
}
