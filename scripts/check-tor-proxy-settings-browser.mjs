#!/usr/bin/env node
// Real-browser regression guard for the hardened server-side Tor proxy trust
// model (server/tor-proxy.ts + client/src/lib/tor-proxy-settings-sync.ts +
// client/src/hooks/use-node-settings.ts).
//
// The proxy's destination allowlist and SOCKS URL now live SERVER-SIDE: the
// client pushes the relevant slice of its stored node settings via
// POST /api/tor/settings (authorized by a loopback-only bootstrap token)
// before any proxied request. Node unit tests cover the allowlist rules, but
// only a real browser can prove the end-to-end chain: node settings load from
// Dexie → useNodeSettings hook pushes them → a proxied sync request for the
// configured custom/trusted-local provider reaches the proxy allowlisted
// (instead of 403/428). This check pins, in headless Chromium:
//   1. Seeded custom provider (trusted local host) settings are pushed by the
//      app itself (POST /api/tor/settings → 200 observed on page load).
//   2. A proxied request to the configured local provider succeeds end-to-end
//      (direct-request path, real local upstream server, real body back).
//   3. An off-allowlist PUBLIC destination is rejected with 403 in-browser.
//   4. An off-allowlist LOCAL destination (not in trusted hosts) is 403'd.
//   5. The Node Settings "Test Tor" button syncs (changed) settings to the
//      server BEFORE calling /api/tor/test, and reports the result in the UI
//      (no Tor in this environment → "Tor Not Available", not a crash/403).
//   6. The Test Tor sync does not clobber the allowlist: the configured
//      provider is still reachable through the proxy afterwards.
//
// Usage: node scripts/check-tor-proxy-settings-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'TorProxyCheck#2026';
const UPSTREAM_TIP_HEIGHT = '834501';

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

/** chromium.launch can hit EAGAIN under parallel-validation load; retry. */
async function launchChromiumWithRetry(exe, attempts = 4) {
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
      console.log(`[tor-proxy-settings-browser] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Fill the setup/unlock form when it is showing; no-op otherwise. */
async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await dismissMigrationOverlayIfPresent(page);
    return false;
  }
  await pwInput.fill(SETUP_PASSWORD);
  const confirmInput = page.getByTestId('input-confirm-password');
  if (await confirmInput.isVisible().catch(() => false)) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
  return true;
}

/**
 * The legacy-migration overlay (z-index 9999) can appear right after unlock
 * and intercepts all pointer events while visible; dismiss it or clicks get
 * swallowed. No-op when it never shows.
 */
async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[tor-proxy-settings-browser] legacy-migration overlay detected; waiting it out ...');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await overlay.isVisible().catch(() => false))) return;
    const dismiss = page.getByTestId('button-dismiss-migration');
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  throw new Error('legacy-migration overlay did not clear within 60s');
}

/**
 * Tiny Esplora-shaped upstream on 127.0.0.1 modelling the user's own local
 * node. The proxy's direct-request path (trusted local host) must reach it.
 */
function startLocalUpstream() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/blocks/tip/height') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(UPSTREAM_TIP_HEIGHT);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[tor-proxy-settings-browser] chromium: ${exe}`);

  const { server: upstream, port: upstreamPort } = await startLocalUpstream();
  const CUSTOM_PROVIDER_URL = `http://127.0.0.1:${upstreamPort}`;
  console.log(`[tor-proxy-settings-browser] local upstream node at ${CUSTOM_PROVIDER_URL}`);

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[tor-proxy-settings-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[tor-proxy-settings-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[tor-proxy-settings-browser] dev server ready at ${BASE_URL}`);
  }

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const browser = await launchChromiumWithRetry(exe);
  try {
    // Fresh context => empty IndexedDB => vault setup form on first load.
    // Block the PWA service worker so it cannot serve a stale bundle.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

    // Record every /api/tor/settings and /api/tor/test exchange so we can
    // prove WHO pushed settings and in what order.
    const torCalls = [];
    page.on('response', (res) => {
      const url = res.url();
      if (url.includes('/api/tor/settings') || url.includes('/api/tor/test')) {
        torCalls.push({
          url,
          method: res.request().method(),
          status: res.status(),
          at: Date.now(),
        });
      }
    });

    // ── Create the vault (retry the initial goto: cold Vite builds flake) ──
    let landed = false;
    for (let i = 0; i < 3 && !landed; i++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await unlockIfNeeded(page);
        landed = true;
      } catch (err) {
        if (i === 2) throw err;
        console.log(`[tor-proxy-settings-browser] initial load retry after: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    step('vault created and app unlocked', true, 'setup form submitted');

    // ── Seed node settings via the LIVE Vite module singletons ─────────────
    // Custom Electrs provider on a trusted local host, Tor enabled (so the
    // Test Tor button renders). This is exactly the "user's own local node"
    // configuration the hardened proxy must keep working.
    await page.evaluate(
      async ({ customUrl }) => {
        const nodeCrud = await import('/src/lib/data/node-settings-crud.ts');
        await nodeCrud.putNodeSettings({
          id: 'default',
          providerType: 'custom-electrs',
          customUrl,
          useTor: true,
          requestTimeout: 30000,
          network: 'mainnet',
          allowLocalNetwork: true,
          trustedLocalHosts: ['127.0.0.1'],
          useElectrum: false,
          electrumPort: 50001,
          electrumSSL: false,
        });
      },
      { customUrl: CUSTOM_PROVIDER_URL },
    );
    step('seeded custom-provider + trusted-local-host node settings', true, CUSTOM_PROVIDER_URL);

    // ── Navigate to Node Settings; the useNodeSettings hook must push the
    //    seeded settings to the server on its own (no manual sync here). ────
    await page.goto(`${BASE_URL}node-settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const pushDeadline = Date.now() + 30_000;
    let hookPush = null;
    while (Date.now() < pushDeadline && !hookPush) {
      hookPush = torCalls.find(
        (c) => c.method === 'POST' && c.url.includes('/api/tor/settings') && !c.url.includes('settings-token'),
      );
      if (!hookPush) await page.waitForTimeout(500);
    }
    step(
      'app pushed node settings to the proxy on load (POST /api/tor/settings → 200)',
      !!hookPush && hookPush.status === 200,
      hookPush ? `status=${hookPush.status}` : 'no settings push observed within 30s',
    );

    // ── Proxied sync request to the configured local provider succeeds ─────
    // Retry briefly: the hook's push and our probe race on a cold page.
    let allowed = null;
    const allowDeadline = Date.now() + 20_000;
    while (Date.now() < allowDeadline) {
      allowed = await page.evaluate(async (url) => {
        const res = await fetch('/api/tor/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: `${url}/api/blocks/tip/height`, method: 'GET' }),
        });
        let body = null;
        try {
          body = await res.json();
        } catch {
          /* handled below */
        }
        return { status: res.status, body };
      }, CUSTOM_PROVIDER_URL);
      if (allowed.status === 200 && allowed.body?.success) break;
      await page.waitForTimeout(1_000);
    }
    step(
      'proxied request to the configured trusted-local provider is allowlisted and succeeds end-to-end',
      allowed?.status === 200 &&
        allowed?.body?.success === true &&
        String(allowed?.body?.data) === UPSTREAM_TIP_HEIGHT,
      `status=${allowed?.status}, success=${allowed?.body?.success}, data=${JSON.stringify(allowed?.body?.data)}`,
    );

    // ── Off-allowlist destinations are rejected in-browser ────────────────
    const rejectPublic = await page.evaluate(async () => {
      const res = await fetch('/api/tor/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://evil.example.com/api/blocks/tip/height' }),
      });
      const body = await res.json().catch(() => null);
      return { status: res.status, error: body?.error ?? null };
    });
    step(
      'off-allowlist PUBLIC destination is rejected with 403',
      rejectPublic.status === 403,
      `status=${rejectPublic.status}, error=${rejectPublic.error}`,
    );

    const rejectLocal = await page.evaluate(async () => {
      const res = await fetch('/api/tor/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://192.168.77.77/api/blocks/tip/height' }),
      });
      const body = await res.json().catch(() => null);
      return { status: res.status, error: body?.error ?? null };
    });
    step(
      'LOCAL destination outside the trusted hosts list is rejected with 403',
      rejectLocal.status === 403,
      `status=${rejectLocal.status}, error=${rejectLocal.error}`,
    );

    // ── Test Tor flow: syncs (changed) settings BEFORE /api/tor/test ──────
    // Change the SOCKS proxy URL in the (unsaved) form so the Test-Tor push
    // is not deduped away, then click Test Tor and verify the ordering:
    // POST /api/tor/settings (200) happens before the /api/tor/test response.
    const torProxyInput = page.getByTestId('input-tor-proxy');
    await torProxyInput.waitFor({ state: 'visible', timeout: 30_000 });
    await torProxyInput.fill('socks5://127.0.0.1:19050');

    const callsBeforeTest = torCalls.length;
    const testTorBtn = page.getByTestId('button-test-tor');
    await testTorBtn.click();

    // No Tor daemon runs in this environment: connection attempts to the
    // custom + built-in SOCKS ports fail fast (ECONNREFUSED), so /test
    // returns a failure envelope rather than hanging.
    const testDeadline = Date.now() + 60_000;
    let testCall = null;
    while (Date.now() < testDeadline && !testCall) {
      testCall = torCalls
        .slice(callsBeforeTest)
        .find((c) => c.url.includes('/api/tor/test'));
      if (!testCall) await page.waitForTimeout(500);
    }
    const testTorPush = torCalls
      .slice(callsBeforeTest)
      .find(
        (c) =>
          c.method === 'POST' &&
          c.url.includes('/api/tor/settings') &&
          !c.url.includes('settings-token') &&
          (!testCall || c.at <= testCall.at),
      );
    step(
      'Test Tor pushed the current (unsaved) settings before calling /api/tor/test',
      !!testTorPush && testTorPush.status === 200 && !!testCall,
      `settingsPush=${testTorPush ? testTorPush.status : 'none'}, testCall=${testCall ? testCall.status : 'none'}`,
    );

    // The button must report the (failed) result in the UI, not crash.
    const torResultVisible = await page
      .getByText('Tor Not Available', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    step(
      'Test Tor reported its result in the UI ("Tor Not Available" — no Tor in this env)',
      torResultVisible,
      `resultVisible=${torResultVisible}`,
    );

    // ── The Test-Tor sync must not clobber the allowlist ──────────────────
    const stillAllowed = await page.evaluate(async (url) => {
      const res = await fetch('/api/tor/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${url}/api/blocks/tip/height`, method: 'GET' }),
      });
      const body = await res.json().catch(() => null);
      return { status: res.status, success: body?.success ?? null, data: body?.data ?? null };
    }, CUSTOM_PROVIDER_URL);
    step(
      'configured provider still allowlisted after the Test Tor settings push',
      stillAllowed.status === 200 &&
        stillAllowed.success === true &&
        String(stillAllowed.data) === UPSTREAM_TIP_HEIGHT,
      `status=${stillAllowed.status}, success=${stillAllowed.success}, data=${JSON.stringify(stillAllowed.data)}`,
    );
  } finally {
    await browser.close().catch(() => {});
    upstream.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        devProc.kill('SIGTERM');
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n[tor-proxy-settings-browser] Results:');
  for (const s of steps) {
    console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
  }
  const failed = steps.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\n[tor-proxy-settings-browser] ${failed.length}/${steps.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n[tor-proxy-settings-browser] all ${steps.length} checks passed`);
}

main().catch((err) => {
  console.error('[tor-proxy-settings-browser] fatal:', err);
  process.exit(1);
});
