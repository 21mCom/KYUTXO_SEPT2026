#!/bin/bash
# Build KYUTXO as an Electron desktop application
# Creates distributable packages for Windows, macOS, and Linux

echo "Building KYUTXO desktop application..."

# First build the web app
echo "Step 1: Building web application..."
npm run build

# Then package with electron-builder
echo "Step 2: Packaging with Electron..."
npx electron-builder --config electron-builder.json

echo "Build complete! Check the 'release' folder for distributable packages."
