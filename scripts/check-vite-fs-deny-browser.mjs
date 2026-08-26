#!/usr/bin/env node
// Real-browser regression guard for the dev-server file-serving allow list
// (server/index-dev.ts + vite.config.ts).
//
// server/index-dev.ts builds its Vite `server` config via
// `mergeConfig({ ...viteConfig, ... }, { server: devServerOverrides })` so
// that `server.fs` (strict/allow/deny) from vite.config.ts is inherited
// automatically instead of being hand-copied. If that merge ever regresses
// (e.g. someone stops spreading `viteConfig`, or passes a fresh `{ server }`
// object that clobbers `fs` instead of deep-merging it), the dev server would
// silently start serving dotfiles — `.env`, `.git/config`, etc. — with no
// visible error. Node unit tests never boot a real Vite dev server, so this
// can only be caught end-to-end in a real browser hitting the real server.
//
// What this pins down:
//   1. A canary dotfile placed INSIDE an allow-listed directory (client/,
//      which is Vite's `root`) is denied (403) and its secret content never
//      appears in the response body, whether fetched directly or via the
//      `/@fs/` raw-fs prefix.
//   2. A real dotfile that already exists in the repo (`.gitignore`, outside
//      every allow-listed directory) is denied (403) via `/@fs/`.
//   3. A canary file placed at the repo root (outside `client/`, so it is not
//      even reachable through Vite's root-relative static serving) never
//      leaks its content through a plain relative fetch like `/.env` — Vite
//      falls through to the app's SPA index.html instead, which is safe as
//      long as the canary string is absent.
//   4. A legitimate client source file (`/src/main.tsx`) is still served
//      correctly (200, JS content, no access-denied banner), proving the
//      deny list isn't over-broad.
//
// Usage: node scripts/check-vite-fs-deny-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const CANARY = `FS_DENY_CANARY_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const CLIENT_DOTFILE_NAME = `.fs-deny-check-${Date.now()}.env`;
const CLIENT_DOTFILE_ABS = path.join(REPO_ROOT, 'client', CLIENT_DOTFILE_NAME);
const ROOT_DOTFILE_NAME = `.fs-deny-check-root-${Date.now()}.env`;
const ROOT_DOTFILE_ABS = path.join(REPO_ROOT, ROOT_DOTFILE_NAME);
const GITIGNORE_ABS = path.join(REPO_ROOT, '.gitignore');

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.');
  }
}

async function isServerUp(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function launchWithRetry(exe, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(`[vite-fs-deny-browser] launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

function cleanupCanaries() {
  for (const p of [CLIENT_DOTFILE_ABS, ROOT_DOTFILE_ABS]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[vite-fs-deny-browser] chromium: ${exe}`);

  // Plant the canary dotfiles BEFORE the dev server is guaranteed up (Vite's
  // fs checks stat the filesystem per-request, not at startup, so this is
  // safe to do either before or after boot).
  cleanupCanaries();
  fs.writeFileSync(CLIENT_DOTFILE_ABS, `SECRET=${CANARY}\n`);
  fs.writeFileSync(ROOT_DOTFILE_ABS, `SECRET=${CANARY}\n`);
  if (!fs.existsSync(GITIGNORE_ABS)) {
    throw new Error(`Expected ${GITIGNORE_ABS} to exist for this check (repo .gitignore is missing).`);
  }

  let devProc = null;
  let startedServer = false;
  try {
    if (await isServerUp(BASE_URL)) {
      console.log(`[vite-fs-deny-browser] reusing dev server at ${BASE_URL}`);
    } else {
      console.log('[vite-fs-deny-browser] starting dev server (npm run dev) ...');
      devProc = spawn('npm', ['run', 'dev'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
        detached: true,
      });
      startedServer = true;
      if (!(await waitForServer(BASE_URL, 90_000))) {
        throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
      }
      console.log(`[vite-fs-deny-browser] dev server ready at ${BASE_URL}`);
    }

    const steps = [];
    const step = (name, passed, detail = '') => {
      steps.push({ name, passed, detail });
      console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
    };

    const browser = await launchWithRetry(exe);
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

      // Retry the initial load: a cold dev server can be slow to transform.
      let loaded = false;
      for (let i = 0; i < 3 && !loaded; i++) {
        try {
          await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
          loaded = true;
        } catch (err) {
          console.log(`[vite-fs-deny-browser] initial load attempt ${i + 1} failed: ${err.message}`);
          await page.waitForTimeout(3_000);
        }
      }
      if (!loaded) throw new Error('Could not load the app page.');

      const fetchFromPage = async (url) =>
        page.evaluate(async (u) => {
          const res = await fetch(u);
          const text = await res.text();
          return { status: res.status, contentType: res.headers.get('content-type'), text };
        }, url);

      // ── Step 1: canary dotfile inside the allow-listed client/ dir ────────
      const clientDirect = await fetchFromPage(`/${CLIENT_DOTFILE_NAME}`);
      step(
        `dotfile inside client/ (${CLIENT_DOTFILE_NAME}) is denied with 403`,
        clientDirect.status === 403,
        `status=${clientDirect.status}`,
      );
      step(
        `dotfile inside client/ response never leaks the canary secret`,
        !clientDirect.text.includes(CANARY),
        clientDirect.text.includes(CANARY) ? 'CANARY FOUND IN RESPONSE BODY' : 'canary absent',
      );

      const clientViaFs = await fetchFromPage(`/@fs${CLIENT_DOTFILE_ABS}`);
      step(
        `dotfile inside client/ via /@fs/ raw-fs prefix is also denied with 403`,
        clientViaFs.status === 403,
        `status=${clientViaFs.status}`,
      );
      step(
        `/@fs/ raw-fs response never leaks the canary secret`,
        !clientViaFs.text.includes(CANARY),
        clientViaFs.text.includes(CANARY) ? 'CANARY FOUND IN RESPONSE BODY' : 'canary absent',
      );

      // ── Step 2: a real repo dotfile outside every allow-listed dir ────────
      const gitignoreViaFs = await fetchFromPage(`/@fs${GITIGNORE_ABS}`);
      step(
        'repo-root .gitignore via /@fs/ (outside all allow-listed dirs) is denied with 403',
        gitignoreViaFs.status === 403,
        `status=${gitignoreViaFs.status}`,
      );

      // ── Step 3: repo-root canary is unreachable via plain relative fetch ──
      // client/ is Vite's root, so a repo-root file isn't even resolvable via
      // a plain relative URL; Vite falls through to the SPA index.html. That
      // fallback is safe as long as it never contains the canary secret.
      const rootDirect = await fetchFromPage(`/${ROOT_DOTFILE_NAME}`);
      step(
        'repo-root canary dotfile never leaks its secret via a plain relative fetch',
        !rootDirect.text.includes(CANARY),
        rootDirect.text.includes(CANARY)
          ? 'CANARY FOUND IN RESPONSE BODY'
          : `canary absent (status=${rootDirect.status})`,
      );

      // ── Step 4: a legitimate client source file is still served fine ─────
      const mainTsx = await fetchFromPage('/src/main.tsx');
      const looksLikeSource =
        mainTsx.status === 200 &&
        !mainTsx.text.includes('403 Restricted') &&
        (mainTsx.text.includes('createRoot') || mainTsx.text.includes('main.tsx'));
      step(
        '/src/main.tsx is still served correctly (200, real source, not access-denied)',
        looksLikeSource,
        `status=${mainTsx.status}, contentType=${mainTsx.contentType}, len=${mainTsx.text.length}`,
      );
    } finally {
      await browser.close().catch(() => {});
    }

    // ── Report ─────────────────────────────────────────────────────────────
    console.log('\n[vite-fs-deny-browser] Results:');
    for (const s of steps) {
      console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
    }
    const failed = steps.filter((s) => !s.passed);
    if (failed.length > 0) {
      console.error(`\n[vite-fs-deny-browser] ${failed.length}/${steps.length} checks FAILED`);
      process.exit(1);
    }
    console.log(`\n[vite-fs-deny-browser] all ${steps.length} checks passed`);
  } finally {
    cleanupCanaries();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        devProc.kill('SIGTERM');
      }
    }
  }
}

main().catch((err) => {
  console.error('[vite-fs-deny-browser] fatal:', err);
  cleanupCanaries();
  process.exit(1);
});
