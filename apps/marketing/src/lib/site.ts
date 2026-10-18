import branding from "../../../../packages/contracts/src/branding.json" with { type: "json" };

// The marketing site does not depend on @t3tools/contracts, so it reads the
// product name straight from the shared branding file.
export const APP_BASE_NAME = branding.name;

export const GITHUB_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";

export const IOS_APP_STORE_URL =
  "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824";

export const ANDROID_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.t3tools.t3code";

export const MARKETING_STATS = {
  githubStars: "24k+",
  users: "500,000",
} as const;
