import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  MiniMaxCodeSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { defineProviderClient, makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

// MiniMax Code has no public raster mark we can ship, so it gets a neutral
// double-arch monogram matching the web `MiniMaxCodeIcon`.
const miniMaxCodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("minimaxCode"),
  label: "MiniMax Code",
  settingsSchema: MiniMaxCodeSettings,
});
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  miniMaxCodeClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
