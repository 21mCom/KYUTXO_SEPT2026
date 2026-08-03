#!/usr/bin/env node
// Real-browser regression guard for the CROSS-origin half of the launch-token
// security model (server/launch-token.ts).
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
// collapses — this check turns that into a hard validation failure:
//   1. An attacker page on a second port fetches /api/tor/status with the
//      custom token header (guessed value) → the browser's preflight must be
//      refused, so fetch() rejects with a network/CORS error (no response
//      readable, regardless of status).
//   2. The same attacker page's simple (headerless) GET to /api must not
//      yield a readable response either (no Access-Control-Allow-Origin).
//   3. A direct OPTIONS preflight (Node-side, emulating the browser's exact
//      preflight request) gets NO Access-Control-Allow-* headers back.
//   4. Control: the server is genuinely up (same-origin request works), so a
//      pass can't be a dead-server false negative.
//
// Usage: node scripts/check-launch-token-cross-origin-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const API_URL = `http://localhost:${PORT}/api/tor/status`;
const ATTACKER_PORT = Number(process.env.KYUTXO_ATTACKER_PORT || 5299);

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
      console.log(`[launch-token-xorigin] launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

// Minimal attacker origin: a second local HTTP server on a different port.
// Same host, different port = different origin under the same-origin policy.
const ATTACKER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>attacker</title></head>
<body>attacker page</body></html>`;

function startAttackerServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ATTACKER_HTML);
    });
    server.on('error', reject);
    server.listen(ATTACKER_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[launch-token-xorigin] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[launch-token-xorigin] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[launch-token-xorigin] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[launch-token-xorigin] dev server ready at ${BASE_URL}`);
  }

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const attackerServer = await startAttackerServer();
  const attackerOrigin = `http://localhost:${ATTACKER_PORT}`;
  console.log(`[launch-token-xorigin] attacker origin up at ${attackerOrigin}`);

  const browser = await launchWithRetry(exe);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

    // Retry the initial load of the attacker page (trivial, but keep parity
    // with the hardening pattern for validation runs under load).
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        await page.goto(`${attackerOrigin}/`, { waitUntil: 'load', timeout: 30_000 });
        loaded = true;
      } catch (err) {
        console.log(`[launch-token-xorigin] attacker page load attempt ${i + 1} failed: ${err.message}`);
        await page.waitForTimeout(2_000);
      }
    }
    if (!loaded) throw new Error('Could not load the attacker page.');

    // ── Step 1: preflighted cross-origin fetch with the custom header ──────
    // The custom x-kyutxo-launch-token header forces a CORS preflight. The
    // server never grants Access-Control-Allow-* headers, so the browser must
    // refuse: fetch() rejects with a TypeError and the attacker reads NOTHING
    // (not even a status code).
    const preflighted = await page.evaluate(async (apiUrl) => {
      try {
        const res = await fetch(apiUrl, {
          headers: { 'x-kyutxo-launch-token': 'guess' },
        });
        // If we get here, the preflight was GRANTED — protection collapsed.
        let body = null;
        try {
          body = (await res.text()).slice(0, 100);
        } catch {}
        return { blocked: false, status: res.status, body };
      } catch (err) {
        return { blocked: true, error: String(err).slice(0, 200) };
      }
    }, API_URL);
    step(
      'cross-origin fetch with x-kyutxo-launch-token header is blocked (preflight refused)',
      preflighted.blocked === true,
      preflighted.blocked
        ? `fetch rejected: ${preflighted.error}`
        : `NOT BLOCKED: status=${preflighted.status}, body=${preflighted.body}`,
    );

    // ── Step 2: simple cross-origin GET yields no readable response ────────
    // Even a headerless GET (no preflight) must be opaque to the attacker:
    // without Access-Control-Allow-Origin the browser rejects the promise.
    const simple = await page.evaluate(async (apiUrl) => {
      try {
        const res = await fetch(apiUrl);
        let body = null;
        try {
          body = (await res.text()).slice(0, 100);
        } catch {}
        return { blocked: false, status: res.status, body };
      } catch (err) {
        return { blocked: true, error: String(err).slice(0, 200) };
      }
    }, API_URL);
    step(
      'simple cross-origin GET to /api gets no readable response (no CORS grant)',
      simple.blocked === true,
      simple.blocked
        ? `fetch rejected: ${simple.error}`
        : `READABLE: status=${simple.status}, body=${simple.body}`,
    );

    // ── Step 3: cross-origin page cannot read the token <meta> tag ─────────
    // Reading the served HTML cross-origin requires a CORS grant too; the
    // attacker must not be able to scrape the token out of the document.
    const htmlRead = await page.evaluate(async (baseUrl) => {
      try {
        const res = await fetch(baseUrl);
        const text = await res.text();
        return { blocked: false, sawToken: text.includes('kyutxo-launch-token') };
      } catch (err) {
        return { blocked: true, error: String(err).slice(0, 200) };
      }
    }, BASE_URL);
    step(
      'cross-origin page cannot read the token-bearing HTML',
      htmlRead.blocked === true,
      htmlRead.blocked
        ? `fetch rejected: ${htmlRead.error}`
        : `READABLE: sawTokenMeta=${htmlRead.sawToken}`,
    );
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Step 4: raw OPTIONS preflight gets no Access-Control-Allow-* grant ───
  // Emulate the browser's exact preflight from Node so we can inspect the
  // response headers directly (the browser hides refused preflights).
  const preflightRes = await fetch(API_URL, {
    method: 'OPTIONS',
    headers: {
      Origin: attackerOrigin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-kyutxo-launch-token',
    },
  });
  const allowHeaders = [...preflightRes.headers.entries()].filter(([k]) =>
    k.toLowerCase().startsWith('access-control-allow'),
  );
  step(
    'OPTIONS preflight to /api gets no Access-Control-Allow-* headers',
    allowHeaders.length === 0,
    allowHeaders.length === 0
      ? `status=${preflightRes.status}, no allow headers`
      : `GRANTED: ${JSON.stringify(allowHeaders)}`,
  );

  // ── Step 5 (control): server genuinely up — same-origin path works ───────
  // Guards against a dead server making the blocked-fetch steps pass vacuously.
  const control = await fetch(API_URL).catch(() => null);
  step(
    'control: server reachable same-origin (401 without token)',
    control !== null && control.status === 401,
    `status=${control ? control.status : 'network error'}`,
  );

  attackerServer.close();
  if (startedServer && devProc) {
    try {
      process.kill(-devProc.pid, 'SIGTERM');
    } catch {
      devProc.kill('SIGTERM');
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n[launch-token-xorigin] Results:');
  for (const s of steps) {
    console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
  }
  const failed = steps.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\n[launch-token-xorigin] ${failed.length}/${steps.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n[launch-token-xorigin] all ${steps.length} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[launch-token-xorigin] fatal:', err);
  process.exit(1);
});
