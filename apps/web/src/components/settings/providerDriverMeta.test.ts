import { MiniMaxCodeSettings, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { MiniMaxCodeIcon } from "../Icons";
import { searchSettings } from "./settingsSearch";
import { providerClients } from "./providerDriverMeta";

const MINIMAX_CODE = ProviderDriverKind.make("minimaxCode");

describe("MiniMax Code driver registration", () => {
  it("resolves the driver definition with its label and settings schema", () => {
    const definition = providerClients.get(MINIMAX_CODE);

    expect(definition?.label).toBe("MiniMax Code");
    expect(definition?.settingsSchema).toBe(MiniMaxCodeSettings);
  });

  it("is listed in the registry exactly once", () => {
    expect(
      providerClients.definitions.filter(({ driverKind }) => driverKind === MINIMAX_CODE),
    ).toHaveLength(1);
  });

  it("maps the driver to its icon in the chat and composer icon map", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[MINIMAX_CODE]).toBe(MiniMaxCodeIcon);
  });

  it.each(["minimax", "mcode", "minimax code"])(
    "finds the Providers settings for the %s query",
    (query) => {
      expect(searchSettings(query).map((item) => item.id)).toContain("providers");
    },
  );
});
