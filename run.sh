#!/usr/bin/env bash
# Builds a nightly T3 Code mac app for this Mac's CPU (arm64 or x64) from this checkout and opens it.
cd "$(dirname "$0")" || exit 1

# Node 24 (engines.node). nvm.sh is not strict-mode safe, so load it first.
. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
nvm use 24 || nvm install 24 || exit 1
set -euo pipefail

# Detect the real CPU; hw.optional.arm64 stays 1 even when this shell runs under Rosetta.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  arch=arm64 rust_target=aarch64-apple-darwin
else
  arch=x64 rust_target=x86_64-apple-darwin
fi
echo "Building for $arch"

if ! command -v vp >/dev/null; then
  curl -fsSL https://vite.plus | VP_HOME="$HOME/.vite-plus" VP_NODE_MANAGER=no bash
  export PATH="$HOME/.vite-plus/bin:$PATH"
fi

# Apple build tools (clang, make, iconutil). The installer is a GUI dialog, so we can't wait on it.
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  echo "Finish the Command Line Tools install dialog, then rerun $0." >&2
  exit 1
fi
# A stale partial usr/include/c++/v1 left by an older CLT shadows the SDK's libc++ headers,
# breaking node-pty's native rebuild ('functional' file not found). Point clang at the SDK copy.
if ! echo '#include <functional>' | clang++ -x c++ -fsyntax-only - 2>/dev/null; then
  export CPLUS_INCLUDE_PATH="$(xcrun --show-sdk-path)/usr/include/c++/v1"
fi

# Rust + this Mac's target for the bundled resource monitor.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
  . "$HOME/.cargo/env"
fi
rustup target add "$rust_target"
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

vp run "dist:desktop:dmg:$arch" --build-version "$V"

# Keep only this build: drop older versions' dmg/zip/blockmaps once the new one exists.
find release -maxdepth 1 -name 'T3-Code-*' ! -name "T3-Code-$V-*" -delete

# Every T3 Code build shares ~/.t3 and one single-instance lock, so only one can run.
name=$(node -p 'require("./packages/contracts/src/branding.json").name')
running() { [ "$(osascript -e 'application id "com.t3tools.t3code" is running' 2>/dev/null)" = true ]; }
running && echo "$name is running. Quit it (Cmd-Q) to open the new build..."
while running; do sleep 2; done

app="release/$name (Nightly).app"
rm -rf "$app"
ditto -xk "release/T3-Code-$V-$arch.zip" release
open "$app"
