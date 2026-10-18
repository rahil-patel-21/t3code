import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ View: "div" }));
vi.mock("react-native-svg", () => ({ Svg: "svg", Path: "path" }));
vi.mock("expo-image", () => ({ Image: "img" }));
vi.mock("./AppText", () => ({ AppText: "span" }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));

import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("draws MiniMax Code with its own mark rather than the codex fallback", () => {
    const minimaxCode = ProviderIcon({ provider: "minimaxCode", size: 16 });
    const codexFallback = ProviderIcon({ provider: "codex", size: 16 });

    expect(minimaxCode).toBeTruthy();
    expect(minimaxCode.props).not.toEqual(codexFallback.props);
  });
});
