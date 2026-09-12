// Shared attacker-page harness for the cross-origin launch-token checks.
//
// Both the dev-server check (check-launch-token-cross-origin-browser.mjs) and
// the production-build check (check-launch-token-cross-origin-prod-browser.mjs)
// pin the exact same refusal scenario — an attacker page served from a SECOND
// local origin must not be able to reach the local API:
//   1. Preflighted fetch with the custom x-kyutxo-launch-token header must be
//      refused (the server never grants Access-Control-Allow-*).
//   2. A simple headerless GET must yield no readable response.
//   3. The token-bearing HTML must not be readable cross-origin.
//   4. A raw OPTIONS preflight (Node-side) gets NO Access-Control-Allow-*.
//   5. Control: the server is genuinely up same-origin (401 without token).
//
// Keeping the scenario in one module guarantees the dev and prod checks can
// never drift apart when the attack model evolves.

import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import http from 'node:http';

export function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.');
  }
}

export async function isServerUp(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function launchWithRetry(exe, label, attempts = 4) {
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
      console.log(`[${label}] launch attempt ${i + 1} failed: ${err.message}`);
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

export function startAttackerServer(attackerPort) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ATTACKER_HTML);
    });
    server.on('error', reject);
    server.listen(attackerPort, '127.0.0.1', () => resolve(server));
  });
}

// Runs the full attacker-page scenario against a target server that is
// already up. Returns the list of step results; caller reports/exits.
export async function runCrossOriginSuite({ label, baseUrl, apiUrl, attackerPort }) {
  const exe = resolveChromium();
  console.log(`[${label}] chromium: ${exe}`);

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const attackerServer = await startAttackerServer(attackerPort);
  const attackerOrigin = `http://localhost:${attackerPort}`;
  console.log(`[${label}] attacker origin up at ${attackerOrigin}`);

  const browser = await launchWithRetry(exe, label);
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
        console.log(`[${label}] attacker page load attempt ${i + 1} failed: ${err.message}`);
        await page.waitForTimeout(2_000);
      }
    }
    if (!loaded) throw new Error('Could not load the attacker page.');

    // ── Step 1: preflighted cross-origin fetch with the custom header ──────
    // The custom x-kyutxo-launch-token header forces a CORS preflight. The
    // server never grants Access-Control-Allow-* headers, so the browser must
    // refuse: fetch() rejects with a TypeError and the attacker reads NOTHING
    // (not even a status code).
    const preflighted = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
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
    }, apiUrl);
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
    const simple = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        let body = null;
        try {
          body = (await res.text()).slice(0, 100);
        } catch {}
        return { blocked: false, status: res.status, body };
      } catch (err) {
        return { blocked: true, error: String(err).slice(0, 200) };
      }
    }, apiUrl);
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
    const htmlRead = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        const text = await res.text();
        return { blocked: false, sawToken: text.includes('kyutxo-launch-token') };
      } catch (err) {
        return { blocked: true, error: String(err).slice(0, 200) };
      }
    }, baseUrl);
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
  const preflightRes = await fetch(apiUrl, {
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
  const control = await fetch(apiUrl).catch(() => null);
  step(
    'control: server reachable same-origin (401 without token)',
    control !== null && control.status === 401,
    `status=${control ? control.status : 'network error'}`,
  );

  attackerServer.close();
  return steps;
}

export function reportAndExit(label, steps) {
  console.log(`\n[${label}] Results:`);
  for (const s of steps) {
    console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
  }
  const failed = steps.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\n[${label}] ${failed.length}/${steps.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n[${label}] all ${steps.length} checks passed`);
  process.exit(0);
}
