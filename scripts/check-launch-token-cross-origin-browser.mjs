#!/usr/bin/env node
// Real-browser regression guard for the CROSS-origin half of the launch-token
// security model (server/launch-token.ts) — DEV server variant.
//
// The loopback protection rests on two browser guarantees:
//   1. A cross-origin page cannot read the token <meta> tag (same-origin policy).
//   2. A cross-origin page cannot set the custom x-kyutxo-launch-token header
//      without a CORS preflight the server never grants.
// The sibling check (check-launch-token-browser.mjs) pins the same-origin
// happy/401 paths; this one proves in headless Chromium that an attacker page
// served from a SECOND local origin is actually refused. If someone later adds
// a permissive CORS middleware (app.use(cors()) or reflected
// Access-Control-Allow-* headers), the whole loopback protection silently
// collapses — this check turns that into a hard validation failure.
//
// The attacker-page scenario itself lives in the shared harness
// (launch-token-cross-origin-harness.mjs) so this dev-server check and the
// production-build check (check-launch-token-cross-origin-prod-browser.mjs)
// can never drift apart.
//
// Usage: node scripts/check-launch-token-cross-origin-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  isServerUp,
  waitForServer,
  runCrossOriginSuite,
  reportAndExit,
} from './launch-token-cross-origin-harness.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM.
await acquireBrowserCheckLock();

const LABEL = 'launch-token-xorigin';
const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const API_URL = `http://localhost:${PORT}/api/tor/status`;
const ATTACKER_PORT = Number(process.env.KYUTXO_ATTACKER_PORT || 5299);

async function main() {
  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[${LABEL}] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[${LABEL}] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[${LABEL}] dev server ready at ${BASE_URL}`);
  }

  const steps = await runCrossOriginSuite({
    label: LABEL,
    baseUrl: BASE_URL,
    apiUrl: API_URL,
    attackerPort: ATTACKER_PORT,
  });

  if (startedServer && devProc) {
    try {
      process.kill(-devProc.pid, 'SIGTERM');
    } catch {
      devProc.kill('SIGTERM');
    }
  }

  reportAndExit(LABEL, steps);
}

main().catch((err) => {
  console.error(`[${LABEL}] fatal:`, err);
  process.exit(1);
});
