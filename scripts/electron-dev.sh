#!/bin/bash
# Run KYUTXO in Electron development mode
# This starts both the Vite dev server and Electron

echo "Starting KYUTXO in Electron development mode..."

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
