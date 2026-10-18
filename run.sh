#!/usr/bin/env bash
# Builds a nightly T3 Code mac app (arm64) from this checkout and opens it.
cd "$(dirname "$0")" || exit 1

# Node 24 (engines.node). nvm.sh is not strict-mode safe, so load it first.
. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
nvm use 24 || nvm install 24 || exit 1
set -euo pipefail

if ! command -v vp >/dev/null; then
  curl -fsSL https://vite.plus | VP_HOME="$HOME/.vite-plus" VP_NODE_MANAGER=no bash
  export PATH="$HOME/.vite-plus/bin:$PATH"
fi
# ponytail: generous timeout + fewer parallel fetches so big tarballs (expo-image ~50MB) survive slow links.
vp i --prefer-offline -- --fetch-timeout=600000 --network-concurrency=4

# Public T3 Connect config that official builds bake in, for this run only.
set -a; . ./.env.example; set +a

# Official nightly scheme: next patch version + -nightly.<date>.<run>.
V=$(node scripts/resolve-nightly-release.ts --date "$(date -u +%Y%m%d)" --run-number 1 \
  --sha "$(git rev-parse HEAD)" | sed -n 's/^version=//p')

# Stamp the version into the bundled server and web client like CI; restore on exit.
backup=$(mktemp)
tar -cf "$backup" apps/{server,desktop,web}/package.json packages/contracts/package.json
trap 'tar -xf "$backup"; rm -f "$backup"' EXIT
node scripts/update-release-package-versions.ts "$V"

vp run dist:desktop:dmg:arm64 --build-version "$V"

# Keep only this build: drop older versions' dmg/zip/blockmaps once the new one exists.
find release -maxdepth 1 -name 'T3-Code-*' ! -name "T3-Code-$V-*" -delete

# Every T3 Code build shares ~/.t3 and one single-instance lock, so only one can run.
name=$(node -p 'require("./packages/contracts/src/branding.json").name')
running() { [ "$(osascript -e 'application id "com.t3tools.t3code" is running' 2>/dev/null)" = true ]; }
running && echo "$name is running. Quit it (Cmd-Q) to open the new build..."
while running; do sleep 2; done

app="release/$name (Nightly).app"
rm -rf "$app"
ditto -xk "release/T3-Code-$V-arm64.zip" release
open "$app"
