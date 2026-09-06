#!/bin/bash
# Build KYUTXO as an Electron desktop application
# Creates distributable packages for Windows, macOS, and Linux

# Fail fast: if any step (notably the native worker-bundle rebuild below) fails,
# abort instead of continuing on to electron-builder and shipping a stale bundle.
set -euo pipefail

echo "Building KYUTXO desktop application..."

# Keep the current plaintext-at-rest product status honest. This negative gate
# must stay green until a real protected primary store and its packaged
# verification suite replace it; a native read replica alone is not protection.
echo "Step 0: Verifying protected-vault claims remain gated..."
node scripts/check-protected-vault-claims.mjs

# First build the web app
echo "Step 1: Building web application..."
npm run build

# Rebuild the native read-engine worker bundle so the packaged app never ships a
# stale worker that is out of sync with the renderer (e.g. a schema-version bump).
# electron-builder does NOT do this, so it must happen here before packaging.
echo "Step 2: Building native read-engine worker bundle..."
node scripts/build-native-engine.mjs

# Then package with electron-builder
echo "Step 3: Packaging with Electron..."
npx electron-builder --config electron-builder.json

# RELEASE GATE: launch the freshly packaged asar under Xvfb + CDP and prove
# the renderer actually renders from the bundle-confined custom scheme, local
# filesystem reads are refused, provider IPC and lock lifecycle work, the CSP
# is intact, inline scripts are blocked, Trusted Types are enforced, and wasm
# compiles.
# (Reuses the dist/ output already built above; packages a --dir asar.)
echo "Step 4: Verifying the packaged renderer (blank-window release gate)..."
node scripts/check-packaged-electron-browser.mjs

# RELEASE GATE: prove the native better-sqlite3 read-engine survives packaging —
# the worker bundle is inside the asar at the path engine-handlers.cjs spawns,
# the .node addon is asarUnpack'd onto real disk, and the extracted shipped
# bytes actually load and open a scratch database. The renderer gate above
# deliberately skips the native module (nix Electron 29 / npmRebuild off), so
# this is the only place an asarUnpack or worker-bundle-path regression fails.
# Reuses the release/ output already produced above. Because this script
# packages with npmRebuild ON, the addon is on the Electron ABI — require the
# packaged binary runtime (ELECTRON_RUN_AS_NODE) so a system-Node fallback can
# never mask an ABI/load regression. (The GitHub Actions build runs the same
# check post-package on the Windows runner — see .github/workflows/build.yml.)
echo "Step 5: Verifying the packaged native read-engine (asarUnpack release gate)..."
TARGET_PLATFORM="$(node -p "process.platform === 'win32' ? 'win' : process.platform")"
TARGET_ARCH="$(node -p "process.arch")"
KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-native-engine.mjs \
  --platform "$TARGET_PLATFORM" \
  --arch "$TARGET_ARCH" \
  --require-electron

# RELEASE GATE: exercise oversized Coin Passport windows through the shipping
# preload -> main -> native-worker bridge. Holdings, outpoints, allocations,
# and hops must page independently; every response remains bounded; rebuilding
# the mirror must invalidate an older detail checkpoint.
echo "Step 6: Verifying oversized packaged Coin Passport paging..."
KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-coin-passport-browser.mjs

# RELEASE GATE: prove the packaged Coin Origins page preserves the distinction
# between acquisition-lot cards and the synthetic unresolved holding row for
# the entire vault and for each wallet scope.
echo "Step 7: Verifying packaged Coin Origins wallet-scoped counts..."
KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-coin-origins-browser.mjs

# RELEASE GATE: prove protected-vault migration and restore failure recovery in
# the same packaged application. This is intentionally fail-closed until the
# protected main-process test bridge is present; a plaintext app must not pass
# by returning a superficial success flag.
echo "Step 8: Verifying protected-vault migration recovery..."
KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-vault-migration-browser.mjs

# RELEASE GATE: prove the device-local network activity log survives a real
# packaged Electron process restart, keeps address/provider details out of its
# rows, and clears independently of provider settings.
echo "Step 8: Verifying packaged network activity restart persistence..."
KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-network-privacy-activity-browser.mjs

# RELEASE GATE: launch a copied Windows portable artifact from an isolated
# profile and prove a forgotten source remains offline after a full restart.
# This check uses the unpacked app on non-Windows developer machines.
echo "Step 9: Verifying forgotten source stays offline after packaged restart..."
KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-packaged-forgotten-network-source-browser.mjs

echo "Build complete! Check the 'release' folder for distributable packages."
