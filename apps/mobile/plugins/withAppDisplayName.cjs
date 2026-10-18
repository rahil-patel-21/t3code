"use strict";

// app.config.ts keeps Expo's `name` fixed because prebuild also names the
// Xcode project, scheme, and .app after it. This applies the branded name users
// see. Expo's built-in name mods run before app.config.ts plugins, so these
// values win. Same-named app strings also override native module defaults, which
// is how `androidStrings` brands copy baked into module resources.

const { AndroidConfig, withInfoPlist, withStringsXml } = require("expo/config-plugins");

module.exports = function withAppDisplayName(config, { displayName, androidStrings = {} }) {
  const withDisplayName = withInfoPlist(config, (cfg) => {
    cfg.modResults.CFBundleDisplayName = displayName;
    return cfg;
  });
  return withStringsXml(withDisplayName, (cfg) => {
    const items = Object.entries({ app_name: displayName, ...androidStrings }).map(
      ([name, value]) => AndroidConfig.Resources.buildResourceItem({ name, value }),
    );
    cfg.modResults = AndroidConfig.Strings.setStringItem(items, cfg.modResults);
    return cfg;
  });
};
