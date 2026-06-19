#!/bin/bash
# Run KYUTXO in Electron development mode
# This starts both the Vite dev server and Electron

echo "Starting KYUTXO in Electron development mode..."

# Build the native read-engine worker bundle first so main.cjs can spawn it.
echo "Building native read-engine worker bundle..."
node scripts/build-native-engine.mjs

# Start the dev server in background
npm run dev &
DEV_PID=$!

# Wait for dev server to be ready
echo "Waiting for dev server to start..."
sleep 5

# Start Electron
NODE_ENV=development npx electron electron/main.cjs

# Cleanup
kill $DEV_PID 2>/dev/null
