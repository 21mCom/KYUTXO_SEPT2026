#!/bin/bash
# Build KYUTXO as an Electron desktop application
# Creates distributable packages for Windows, macOS, and Linux

# Fail fast: if any step (notably the native worker-bundle rebuild below) fails,
# abort instead of continuing on to electron-builder and shipping a stale bundle.
set -euo pipefail

echo "Building KYUTXO desktop application..."

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
KYUTXO_PACKAGED_SKIP_BUILD=1 KYUTXO_NATIVE_ENGINE_REQUIRE_ELECTRON=1 node scripts/check-packaged-native-engine.mjs

echo "Build complete! Check the 'release' folder for distributable packages."
