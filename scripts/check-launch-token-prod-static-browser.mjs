#!/usr/bin/env node
// Real-browser regression guard for the SAME-origin happy path of the
// launch-token contract on the PRODUCTION static-serving stack.
//
// The sibling prod check (check-launch-token-cross-origin-prod-browser.mjs)
// pins the cross-origin refusals against server/index-prod.ts, but serves a
// minimal stub index.html — fine for middleware-level CORS/token behavior,
// but it never proves that a REAL `vite build` output still gets the
// kyutxo-launch-token <meta> tag injected and that the built client can
// authenticate same-origin. That is exactly what a regression in
// serveStatic's index.html read/inject path (or a built index.html whose
// shape breaks injectLaunchToken) would look like: dev check green, packaged
// app dead with 401s everywhere.
//
// What this check pins, against server/index-prod.ts serving real
// dist/public output:
//   1. (Node) served / HTML carries a non-empty kyutxo-launch-token <meta>.
//   2. (Node) /api/tor/status without the token header → 401.
//   3. (Node) /api/tor/status WITH the token scraped from the HTML → 200.
//   4. (Browser) the built client boots (unlock/setup form renders), its
//      fetch wrapper is installed, and its wrapped fetch to /api → 200,
//      while a pristine iframe fetch (bypasses the wrapper) → 401.
//
// Build cost gating: `vite build` (~1 min) only runs when dist/public is
// missing or older than the newest client source / config file; a fresh
// dist/public from a prior build or sibling check run is reused as-is.
// The server bundle goes to a dedicated dist subdirectory so a real
// `dist/index.js` build is never clobbered; dist/public is shared via
// symlink (fallback: copy).
//
// Usage: node scripts/check-launch-token-prod-static-browser.mjs
// Requires: chromium on PATH (Nix), playwright-core, esbuild + vite (dev deps).

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  resolveChromium,
  isServerUp,
  waitForServer,
  launchWithRetry,
  reportAndExit,
} from './launch-token-cross-origin-harness.mjs';

// Serialize real-Chromium checks: parallel runs share CPU/RAM.
await acquireBrowserCheckLock();

const LABEL = 'launch-token-prod-static';
// Distinct from dev (5000), xorigin-dev (5299) and xorigin-prod (5310).
const PORT = Number(process.env.KYUTXO_PROD_STATIC_CHECK_PORT || 5312);
const BASE_URL = `http://localhost:${PORT}/`;
const API_URL = `http://localhost:${PORT}/api/tor/status`;

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_PUBLIC = path.join(ROOT, 'dist', 'public');
const OUT_DIR = path.join(ROOT, 'dist', 'launch-token-prod-static-check');
const BUNDLE = path.join(OUT_DIR, 'index.mjs');

// ── Freshness gate for the client build ────────────────────────────────────
// Newest mtime among the inputs that shape dist/public. Cheap recursive walk
// (client/ is a few thousand files at most).
function newestMtime(p) {
  let newest = 0;
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(p)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      newest = Math.max(newest, newestMtime(path.join(p, entry)));
    }
    return Math.max(newest, 0);
  }
  return st.mtimeMs;
}

function distPublicIsFresh() {
  const indexHtml = path.join(DIST_PUBLIC, 'index.html');
  const st = fs.statSync(indexHtml, { throwIfNoEntry: false });
  if (!st) return false;
  const sourcesNewest = Math.max(
    newestMtime(path.join(ROOT, 'client')),
    newestMtime(path.join(ROOT, 'vite.config.ts')),
    newestMtime(path.join(ROOT, 'package.json')),
  );
  return st.mtimeMs >= sourcesNewest;
}

function ensureClientBuild() {
  if (distPublicIsFresh()) {
    console.log(`[${LABEL}] reusing fresh dist/public (newer than client sources)`);
    return;
  }
  console.log(`[${LABEL}] dist/public missing or stale — running vite build ...`);
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
  if (!fs.existsSync(path.join(DIST_PUBLIC, 'index.html'))) {
    throw new Error('vite build completed but dist/public/index.html is missing.');
  }
}

function buildProdServerBundle() {
  console.log(`[${LABEL}] bundling server/index-prod.ts with esbuild ...`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Same flags as the `npm run build` server step, different outfile.
  execSync(
    `npx esbuild server/index-prod.ts --platform=node --packages=external --bundle --format=esm --outfile=${JSON.stringify(BUNDLE)}`,
    { cwd: ROOT, stdio: 'inherit' },
  );
  // index-prod resolves its static dir as <bundle dir>/public — point it at
  // the REAL vite build output (symlink; copy if symlinks unavailable).
  const publicLink = path.join(OUT_DIR, 'public');
  try {
    fs.symlinkSync(DIST_PUBLIC, publicLink, 'dir');
  } catch {
    fs.cpSync(DIST_PUBLIC, publicLink, { recursive: true });
  }
}

async function main() {
  if (await isServerUp(BASE_URL)) {
    throw new Error(
      `Port ${PORT} is already in use — refusing to test an unknown server. Free the port and re-run.`,
    );
  }

  ensureClientBuild();
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

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    if (!(await waitForServer(BASE_URL, 60_000))) {
      throw new Error(`Production server did not become ready at ${BASE_URL} within 60s.`);
    }
    console.log(`[${LABEL}] production server ready at ${BASE_URL}`);

    // ── Node-side: real built index.html carries the injected token ────────
    const html = await (await fetch(BASE_URL)).text();
    const token = html.match(/name="kyutxo-launch-token" content="([^"]*)"/)?.[1] ?? null;
    step(
      'served REAL vite-build index.html carries a non-empty kyutxo-launch-token <meta>',
      !!token && token.length > 0,
      `tokenLength=${token ? token.length : 0}`,
    );
    // Sanity: this is the real build, not a stub (vite output references
    // hashed assets), so a regression can't pass against accidental stub HTML.
    step(
      'served index.html is real vite build output (references /assets/ bundle)',
      html.includes('/assets/'),
      html.includes('/assets/') ? 'found /assets/ reference' : `html head: ${html.slice(0, 200)}`,
    );

    const noToken = await fetch(API_URL);
    step(
      'same-origin /api fetch WITHOUT token → 401',
      noToken.status === 401,
      `status=${noToken.status}`,
    );
    const withToken = await fetch(API_URL, {
      headers: { 'x-kyutxo-launch-token': token ?? '' },
    });
    step(
      'same-origin /api fetch WITH the served token → 200',
      withToken.status === 200,
      `status=${withToken.status}`,
    );

    // ── Browser-side: built client authenticates through its own wrapper ───
    const exe = resolveChromium();
    console.log(`[${LABEL}] chromium: ${exe}`);
    const browser = await launchWithRetry(exe, LABEL);
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

      let loaded = false;
      for (let i = 0; i < 3 && !loaded; i++) {
        try {
          await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
          // The setup/unlock form proves the built main bundle ran (fetch
          // wrapper installs before React renders anything).
          await page.getByTestId('input-password').waitFor({ state: 'visible', timeout: 45_000 });
          loaded = true;
        } catch (err) {
          console.log(`[${LABEL}] page load attempt ${i + 1} failed: ${err.message}`);
          await page.waitForTimeout(3_000);
        }
      }
      step('built client boots from the prod server (unlock/setup form renders)', loaded);
      if (loaded) {
        const inPage = await page.evaluate(async () => {
          const meta = document.querySelector('meta[name="kyutxo-launch-token"]');
          const installed = !!window.__kyutxoLaunchTokenFetchInstalled;
          const res = await fetch('/api/tor/status');
          // Pristine iframe fetch bypasses the app's wrapper → models any
          // request that skips it.
          const iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          document.body.appendChild(iframe);
          let rawStatus = null;
          try {
            const rawFetch = iframe.contentWindow.fetch.bind(iframe.contentWindow);
            rawStatus = (await rawFetch('/api/tor/status')).status;
          } finally {
            iframe.remove();
          }
          return {
            metaPresent: !!meta && (meta.getAttribute('content') || '').length > 0,
            installed,
            wrappedStatus: res.status,
            rawStatus,
          };
        });
        step(
          'page DOM carries the launch-token <meta> tag',
          inPage.metaPresent,
          `present=${inPage.metaPresent}`,
        );
        step(
          'built client installed the fetch wrapper (installLaunchTokenFetch ran)',
          inPage.installed,
          `__kyutxoLaunchTokenFetchInstalled=${inPage.installed}`,
        );
        step(
          "built client's wrapped fetch to /api/tor/status → 200",
          inPage.wrappedStatus === 200,
          `status=${inPage.wrappedStatus}`,
        );
        step(
          'pristine (unwrapped) iframe fetch from the page → 401',
          inPage.rawStatus === 401,
          `status=${inPage.rawStatus}`,
        );
      }
    } finally {
      await browser.close().catch(() => {});
    }

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
