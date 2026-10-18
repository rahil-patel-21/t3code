import { WS_METHODS, type ApiGatewayExecuteInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Never completes; interrupts the fiber waiting on it once `signal` aborts. */
const interruptOnAbort = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    if (signal.aborted) {
      resume(Effect.interrupt);
      return;
    }
    const onAbort = () => resume(Effect.interrupt);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

export function createApiGatewayEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const workspaceScheduler = createAtomCommandScheduler();
  return {
    /** The environment's collections and variable sets, kept current by the server. */
    workspace: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:api-gateway:workspace",
      tag: WS_METHODS.subscribeApiGateway,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:api-gateway:apply",
      tag: WS_METHODS.apiGatewayApply,
      scheduler: workspaceScheduler,
      // The server applies batches in arrival order, so keep each client's own in order too.
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    /**
     * Sends a request from the environment. Aborting `signal` cancels the
     * call, which makes the server drop the connection it opened.
     */
    execute: createEnvironmentCommand(runtime, {
      label: "environment-data:api-gateway:execute",
      execute: (input: {
        readonly request: ApiGatewayExecuteInput;
        readonly signal: AbortSignal;
      }) =>
        Effect.raceFirst(
          request(WS_METHODS.apiGatewayExecute, input.request),
          interruptOnAbort(input.signal),
        ),
    }),
  };
}
