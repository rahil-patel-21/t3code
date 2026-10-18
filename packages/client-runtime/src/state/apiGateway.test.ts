import {
  EnvironmentId,
  WS_METHODS,
  type ApiGatewayExecuteInput,
  type ApiGatewayExecuteResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createApiGatewayEnvironmentAtoms } from "./apiGateway.ts";
import { isAtomCommandInterrupted } from "./runtime.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const REQUEST: ApiGatewayExecuteInput = {
  method: "GET",
  url: "https://api.test/slow",
  headers: [],
  followRedirects: true,
  timeoutMs: 30_000,
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

/** Atoms wired to a connected environment whose only RPC is `apiGateway.execute`. */
const makeAtoms = Effect.fn("makeAtoms")(function* (
  execute: () => Effect.Effect<ApiGatewayExecuteResult>,
) {
  const client = { [WS_METHODS.apiGatewayExecute]: execute } as unknown as WsRpcProtocolClient;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const atoms = createApiGatewayEnvironmentAtoms(
    Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { atoms, registry };
});

describe("API Gateway environment atoms", () => {
  it.effect("interrupts the call when its signal aborts, so the server stops the request", () => {
    // The signal comes from a Cancel button, outside any Effect.
    const controller = new AbortController();
    return Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let interrupted = false;
        const { atoms, registry } = yield* makeAtoms(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        );

        const pending = atoms.execute.run(registry, {
          environmentId: TARGET.environmentId,
          input: { request: REQUEST, signal: controller.signal },
        });
        yield* Deferred.await(started);
        controller.abort();
        const result = yield* Effect.promise(() => pending);

        expect(isAtomCommandInterrupted(result)).toBe(true);
        expect(interrupted).toBe(true);
      }),
    );
  });
});
