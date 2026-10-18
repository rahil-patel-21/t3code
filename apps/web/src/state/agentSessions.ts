import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

/** On-demand scan. Imports read the server's latest scan, so rescan to find newer sessions. */
export const agentSessionRescan = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:rescan",
  tag: WS_METHODS.agentSessionsScan,
});

export const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

/**
 * Recent CLI sessions for one project that are new or have messages T3 has not synced.
 * Rechecked every couple of minutes; the server reads only what transcripts appended.
 */
export const agentSessionProjectSessions = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:agent-sessions:project-sessions",
    tag: WS_METHODS.agentSessionsListProjectSessions,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 120_000,
  },
);
