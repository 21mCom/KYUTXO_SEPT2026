#!/usr/bin/env node
// Real-browser regression guard for the CROSS-origin half of the launch-token
// security model — PRODUCTION server variant (server/index-prod.ts).
//
// The sibling dev check (check-launch-token-cross-origin-browser.mjs) proves
// an attacker page on a second local origin cannot reach the local API — but
// it runs against the Vite DEV server (server/index-dev.ts). The packaged app
// serves via server/index-prod.ts with a different middleware stack (static
// files, no Vite), so a permissive-CORS regression introduced only on the
// production path would slip through. This check runs the exact same
// attacker-page scenario (shared harness: launch-token-cross-origin-harness.mjs)
// against a production build of the server (NODE_ENV=production).
//
// How the prod server is stood up:
//   1. Bundle server/index-prod.ts with the same esbuild invocation as
//      `npm run build`, into dist/launch-token-prod-check/index.mjs (a
//      dedicated directory so a real `dist/index.js` build is never clobbered).
//   2. server/index-prod.ts resolves its static dir as <bundle dir>/public and
//      refuses to start without an index.html — provide a minimal stub
//      index.html there (its content is irrelevant to the CORS/token model;
//      injectLaunchToken works on any HTML).
//   3. Start it with NODE_ENV=production on a dedicated port (5310), then run
//      the shared cross-origin suite against it.
//
// Usage: node scripts/check-launch-token-cross-origin-prod-browser.mjs
// Requires: chromium on PATH (Nix), playwright-core, esbuild (dev dep).

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  isServerUp,
  waitForServer,
  runCrossOriginSuite,
  reportAndExit,
} from './launch-token-cross-origin-harness.mjs';

// Serialize real-Chromium checks: parallel runs share CPU/RAM.
await acquireBrowserCheckLock();

const LABEL = 'launch-token-xorigin-prod';
const PORT = Number(process.env.KYUTXO_PROD_CHECK_PORT || 5310);
const BASE_URL = `http://localhost:${PORT}/`;
const API_URL = `http://localhost:${PORT}/api/tor/status`;
// Distinct from the dev check's 5299 so a stale attacker server from a
// crashed sibling run can never collide.
const ATTACKER_PORT = Number(process.env.KYUTXO_ATTACKER_PORT_PROD || 5301);

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'launch-token-prod-check');
const BUNDLE = path.join(OUT_DIR, 'index.mjs');

function buildProdServerBundle() {
  console.log(`[${LABEL}] bundling server/index-prod.ts with esbuild ...`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Same flags as the `npm run build` server step, different outfile.
  execSync(
    `npx esbuild server/index-prod.ts --platform=node --packages=external --bundle --format=esm --outfile=${JSON.stringify(BUNDLE)}`,
    { cwd: ROOT, stdio: 'inherit' },
  );
  // index-prod resolves its static dir relative to the bundle; give it a
  // minimal index.html (content irrelevant — token injection and CORS
  // behavior are middleware-level, not asset-level).
  const publicDir = path.join(OUT_DIR, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, 'index.html'),
    '<!doctype html>\n<html><head><meta charset="utf-8"><title>prod check</title></head><body>prod check stub</body></html>\n',
  );
}

async function main() {
  if (await isServerUp(BASE_URL)) {
    throw new Error(
      `Port ${PORT} is already in use — refusing to test an unknown server. Free the port and re-run.`,
    );
  }

  buildProdServerBundle();

  console.log(`[${LABEL}] starting production server (NODE_ENV=production) on port ${PORT} ...`);
  const prodProc = spawn(process.execPath, [BUNDLE], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
    },
    detached: true,
  });

  const killProd = () => {
    try {
      process.kill(-prodProc.pid, 'SIGTERM');
    } catch {
      try {
        prodProc.kill('SIGTERM');
      } catch {}
    }
  };

  try {
    if (!(await waitForServer(BASE_URL, 60_000))) {
      throw new Error(`Production server did not become ready at ${BASE_URL} within 60s.`);
    }
    console.log(`[${LABEL}] production server ready at ${BASE_URL}`);

    const steps = await runCrossOriginSuite({
      label: LABEL,
      baseUrl: BASE_URL,
      apiUrl: API_URL,
      attackerPort: ATTACKER_PORT,
    });

    killProd();
    reportAndExit(LABEL, steps);
  } catch (err) {
    killProd();
    throw err;
  }
}

main().catch((err) => {
  console.error(`[${LABEL}] fatal:`, err);
  process.exit(1);
});
