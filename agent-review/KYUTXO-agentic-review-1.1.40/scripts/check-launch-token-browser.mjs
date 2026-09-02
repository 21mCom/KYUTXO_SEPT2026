#!/usr/bin/env node
// Real-browser regression guard for the per-launch API token contract
// (server/launch-token.ts + client/src/lib/launch-token.ts).
//
// The server binds loopback and gates every /api route behind a random
// per-launch token injected into the served HTML as a <meta> tag; the client
// bootstrap (main.tsx → installLaunchTokenFetch) wraps window.fetch so every
// same-origin /api request carries the token header. If any link in that
// chain breaks (meta injection dropped, main.tsx stops installing the
// wrapper, wrapper stops attaching the header), every attachment
// upload/download and Tor status call silently dies with 401 in the browser.
// Node unit tests can't see that — this check pins it in headless Chromium:
//   1. The served HTML carries the launch-token <meta> tag.
//   2. A token-LESS fetch from the page context (pristine iframe fetch that
//      bypasses the app's wrapper) to /api/tor/status returns 401.
//   3. The app's own wrapped window.fetch to /api/tor/status returns 200.
//   4. A real attachment write + read round trip through the page's wrapped
//      fetch succeeds with byte-exact content (then cleans up).
//
// Usage: node scripts/check-launch-token-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { waitForLoginScreenVisible } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const CHECK_FILE_PATH = 'lt/launch-token-check.bin';
const CHECK_FILE_BYTES = [11, 22, 33, 44, 55, 66, 77];

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
      console.log(`[launch-token-browser] launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

// Node-side helpers: scrape the same <meta> token the page uses so cleanup
// can talk to the attachments API directly.
let launchTokenHeaders = null;
async function apiAuthHeaders() {
  if (!launchTokenHeaders) {
    const html = await (await fetch(BASE_URL)).text();
    const token = html.match(/name="kyutxo-launch-token" content="([^"]*)"/)?.[1];
    launchTokenHeaders = token ? { 'x-kyutxo-launch-token': token } : {};
  }
  return launchTokenHeaders;
}
async function apiDeleteFile(relPath) {
  await fetch(`${BASE_URL}api/attachments/${relPath}`, {
    method: 'DELETE',
    headers: await apiAuthHeaders(),
  }).catch(() => {});
}

async function main() {
  const exe = resolveChromium();
  console.log(`[launch-token-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[launch-token-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[launch-token-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[launch-token-browser] dev server ready at ${BASE_URL}`);
  }

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // Clean slate for this check's on-disk file (idempotent).
  await apiDeleteFile(CHECK_FILE_PATH);

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
        // The setup/unlock form proves main.tsx ran (wrapper installed before
        // React renders anything).
        await waitForLoginScreenVisible(page, { timeoutMs: 45_000 });
        loaded = true;
      } catch (err) {
        console.log(`[launch-token-browser] initial load attempt ${i + 1} failed: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('Could not load the app page.');

    // ── Step 1: the served HTML carries the launch-token meta tag ──────────
    const meta = await page.evaluate(() => {
      const el = document.querySelector('meta[name="kyutxo-launch-token"]');
      const content = el?.getAttribute('content') ?? null;
      return { present: !!el, tokenLength: content ? content.length : 0 };
    });
    step(
      'served HTML carries the kyutxo-launch-token <meta> tag with a non-empty token',
      meta.present && meta.tokenLength > 0,
      `present=${meta.present}, tokenLength=${meta.tokenLength}`,
    );

    // ── Step 2: token-less fetch from the page context → 401 ───────────────
    // A same-origin iframe gets a PRISTINE fetch (the app only wraps the top
    // window's fetch), so this models any request that skips the wrapper —
    // exactly what every /api call becomes if installLaunchTokenFetch breaks.
    const tokenless = await page.evaluate(async () => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      try {
        const rawFetch = iframe.contentWindow.fetch.bind(iframe.contentWindow);
        const res = await rawFetch('/api/tor/status');
        return { status: res.status, body: (await res.text()).slice(0, 100) };
      } finally {
        iframe.remove();
      }
    });
    step(
      'token-less fetch from the page context to /api/tor/status is rejected with 401',
      tokenless.status === 401,
      `status=${tokenless.status}, body=${tokenless.body}`,
    );

    // ── Step 3: the app's own wrapped fetch → 200 ──────────────────────────
    const wrapped = await page.evaluate(async () => {
      const installed = !!window.__kyutxoLaunchTokenFetchInstalled;
      const res = await fetch('/api/tor/status');
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON is a failure below */
      }
      return { installed, status: res.status, hasBody: body !== null && typeof body === 'object' };
    });
    step(
      'app wrapper is installed (main.tsx called installLaunchTokenFetch)',
      wrapped.installed,
      `__kyutxoLaunchTokenFetchInstalled=${wrapped.installed}`,
    );
    step(
      "app's wrapped fetch to /api/tor/status succeeds with 200 + JSON body",
      wrapped.status === 200 && wrapped.hasBody,
      `status=${wrapped.status}, jsonBody=${wrapped.hasBody}`,
    );

    // ── Step 4: attachment write + read round trip through the page ────────
    const roundTrip = await page.evaluate(
      async ({ CHECK_FILE_PATH, CHECK_FILE_BYTES }) => {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(CHECK_FILE_BYTES)]));
        form.append('relativePath', CHECK_FILE_PATH);
        const writeRes = await fetch('/api/attachments/write', { method: 'POST', body: form });
        if (!writeRes.ok) return { writeStatus: writeRes.status, readStatus: null, bytes: null };
        const readRes = await fetch(`/api/attachments/download/${CHECK_FILE_PATH}`);
        const bytes = readRes.ok ? [...new Uint8Array(await readRes.arrayBuffer())] : null;
        return { writeStatus: writeRes.status, readStatus: readRes.status, bytes };
      },
      { CHECK_FILE_PATH, CHECK_FILE_BYTES },
    );
    step(
      'attachment write through the page succeeds',
      roundTrip.writeStatus === 200,
      `write status=${roundTrip.writeStatus}`,
    );
    step(
      'attachment read back through the page returns byte-exact content',
      roundTrip.readStatus === 200 &&
        JSON.stringify(roundTrip.bytes) === JSON.stringify(CHECK_FILE_BYTES),
      `read status=${roundTrip.readStatus}, bytes=${JSON.stringify(roundTrip.bytes)}`,
    );
  } finally {
    await browser.close().catch(() => {});
    await apiDeleteFile(CHECK_FILE_PATH);
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        devProc.kill('SIGTERM');
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n[launch-token-browser] Results:');
  for (const s of steps) {
    console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
  }
  const failed = steps.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\n[launch-token-browser] ${failed.length}/${steps.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n[launch-token-browser] all ${steps.length} checks passed`);
}

main().catch((err) => {
  console.error('[launch-token-browser] fatal:', err);
  process.exit(1);
});
