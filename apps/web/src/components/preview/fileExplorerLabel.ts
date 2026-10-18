import type {
  ExecutionEnvironmentPlatformOs,
  FileManagerRevealKind,
  ServerConfig,
} from "@t3tools/contracts";

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Reveal in Finder";
  if (normalized.includes("win")) return "Reveal in File Explorer";
  return "Reveal in Files";
}

export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return "Reveal in Finder";
  if (os === "windows") return "Reveal in File Explorer";
  return "Reveal in Files";
}

export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return "Reveal in Finder";
  if (kind === "file-explorer") return "Reveal in File Explorer";
  return "Reveal in Files";
}

/** The reveal-relevant slice of a server config. Callers hold either a full
    `ServerConfig` or an `EnvironmentServerConfig`, which drops `providers`. */
type RevealLabelConfig = Pick<
  ServerConfig,
  "environment" | "availableEditors" | "shellRevealInFileManager" | "shellRevealInFileManagerKind"
>;

/** Reveal wording for an environment, or undefined when its server cannot
    reveal. The server picks the wording because on WSL the reveal can run
    through Windows File Explorer even though the host reports Linux. */
export function revealInFileExplorerLabelForConfig(
  config: RevealLabelConfig | null | undefined,
): string | undefined {
  if (
    config?.shellRevealInFileManager !== true ||
    !config.availableEditors.includes("file-manager")
  ) {
    return undefined;
  }
  return config.shellRevealInFileManagerKind === undefined
    ? revealInFileExplorerLabelForOs(config.environment.platform.os)
    : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind);
}
