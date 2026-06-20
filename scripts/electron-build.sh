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

echo "Build complete! Check the 'release' folder for distributable packages."
