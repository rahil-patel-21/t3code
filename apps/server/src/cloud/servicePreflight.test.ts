import { expect, it } from "@effect/vitest";
import { APP_BASE_NAME } from "@t3tools/contracts";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it.each([1, 2])("blocks legacy launcher protocol %i", (launcherProtocol) => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.3",
    reason: `This release requires a newer ${APP_BASE_NAME} service launcher. Update it on the server machine.`,
  });
});

it("accepts the current launcher protocol", () => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "ready",
    version: "1.2.3",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
  });
});
