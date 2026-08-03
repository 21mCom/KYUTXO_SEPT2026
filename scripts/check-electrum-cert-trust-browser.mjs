#!/usr/bin/env node
// Real-browser regression guard for the Electrum TLS certificate trust prompt
// (Task #1758: TOFU flow in Node Settings).
//
// The main-process handlers are covered by electron/electrum-client.test.ts,
// but the renderer flow — trust dialog opening on CERT_UNTRUSTED, the
// fingerprint display, "Trust This Certificate" calling
// electrumTrustCertificate, and the automatic retry rendering the
// "Transport: Direct" + certificate badges — only runs in a real browser.
//
// The script drives a REAL headless Chromium against the running dev server
// with a MOCKED Electron bridge (window.electronAPI injected via
// addInitScript before app code runs):
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. opens Node Settings, enables the Electrum protocol, fills in a host
//   3. clicks "Test Electrum Connection"; the mock's electrumTest fails with
//      errorCode CERT_UNTRUSTED + a certificate payload
//   4. asserts the trust dialog (dialog-electrum-cert-trust) opens and shows
//      the certificate's SHA-256 fingerprint
//   5. clicks "Trust This Certificate" and asserts:
//      - electrumTrustCertificate was called with the host/port/fingerprint
//      - the retried electrumTest succeeded (2 calls total)
//      - the result panel shows "Transport: Direct" and
//        "Certificate: trusted fingerprint" badges
//
// Everything runs offline — the Electron bridge is a page-side mock, no
// network request leaves the machine.
// Usage: node scripts/check-electrum-cert-trust-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'electrum-cert-trust-check-123';

const MOCK_HOST = 'electrum.trust-check.test';
const MOCK_PORT = 50002;
const MOCK_FINGERPRINT =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No `chromium` binary found on PATH. Install it (Nix: chromium) or set CHROMIUM_BIN.',
    );
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

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
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

async function gotoWithRetry(page, url, firstSelectorTestId) {
  // Retry the initial load: under parallel validation the dev server can be
  // slow to compile and single-shot waits flake.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      if (firstSelectorTestId) {
        await page
          .getByTestId(firstSelectorTestId)
          .waitFor({ state: 'visible', timeout: 30_000 })
          .catch(() => {});
      }
      return;
    } catch (err) {
      lastErr = err;
      console.log(`[electrum-cert-trust-browser] goto failed (attempt ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  throw lastErr;
}

// Injected before any app code runs on every page load. Provides a mocked
// window.electronAPI whose electrumTest fails with CERT_UNTRUSTED until
// electrumTrustCertificate is called, then succeeds with a pinned cert.
function buildInitScript({ fingerprint }) {
  return `(() => {
    const calls = { electrumTest: [], electrumTrustCertificate: [] };
    let trusted = false;
    const certificate = {
      fingerprint: ${JSON.stringify(fingerprint)},
      subject: 'CN=electrum.trust-check.test',
      issuer: 'CN=electrum.trust-check.test',
      validTo: 'Dec 31 23:59:59 2030 GMT',
      selfSigned: true,
    };
    const ok = async () => ({ success: true });
    const api = {
      isElectron: true,
      platform: 'linux',
      electrumTest: async (params) => {
        calls.electrumTest.push(params);
        if (!trusted) {
          return {
            success: false,
            error: 'Untrusted server certificate',
            errorCode: 'CERT_UNTRUSTED',
            transport: 'direct',
            certificate,
          };
        }
        return {
          success: true,
          serverVersion: 'MockElectrumX 1.16',
          blockHeight: 850000,
          latency: 12,
          transport: 'direct',
          certificate: Object.assign({}, certificate, { trust: 'pinned' }),
        };
      },
      electrumTrustCertificate: async (params) => {
        calls.electrumTrustCertificate.push(params);
        trusted = true;
        return {
          success: true,
          pinned: Object.assign({}, params.certificate, { trustedAt: Date.now() }),
        };
      },
      electrumGetCertificateTrust: async () => ({
        success: true,
        pinned: trusted ? Object.assign({}, certificate, { trustedAt: Date.now() }) : null,
      }),
      electrumRevokeCertificate: async () => { trusted = false; return { success: true, revoked: true }; },
      torUpdateSettings: ok,
      torStatus: async () => ({ success: true, running: false }),
      torTest: async () => ({ success: false, error: 'mock' }),
    };
    window.__electrumMockCalls = calls;
    // Any bridge method the app touches that we didn't stub resolves benignly
    // instead of throwing "not a function" (the NodeSettings flow only needs
    // the electrum* + tor* stubs above). No engine key: the app must treat
    // the native read-engine as unavailable.
    window.electronAPI = new Proxy(api, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'engine') return undefined;
        if (typeof prop === 'string') return ok;
        return undefined;
      },
      has(target, prop) { return prop === 'engine' ? false : true; },
    });
  })();`;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[electrum-cert-trust-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[electrum-cert-trust-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[electrum-cert-trust-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel
  // validation load.
  let browser = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`[electrum-cert-trust-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 2400 },
    });
    await context.addInitScript(buildInitScript({ fingerprint: MOCK_FINGERPRINT }));
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[electrum-cert-trust-browser][page-console] ${msg.text()}`);
      }
    });

    await gotoWithRetry(page, `${BASE_URL}node-settings`, 'input-password');
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Enable Electrum protocol + configure the mock server ────────────────
    const electrumSwitch = page.getByTestId('switch-use-electrum');
    await electrumSwitch.waitFor({ state: 'visible', timeout: 30_000 });
    await electrumSwitch.scrollIntoViewIfNeeded();
    if ((await electrumSwitch.getAttribute('data-state')) !== 'checked') {
      await electrumSwitch.click();
    }
    const hostInput = page.getByTestId('input-electrum-host');
    await hostInput.waitFor({ state: 'visible', timeout: 15_000 });
    await hostInput.fill(MOCK_HOST);
    const portInput = page.getByTestId('input-electrum-port');
    if (await portInput.isVisible().catch(() => false)) {
      await portInput.fill(String(MOCK_PORT));
    }
    steps.push({ name: 'Electrum protocol enabled and host configured', passed: true, detail: `${MOCK_HOST}:${MOCK_PORT}` });

    // ── First test → CERT_UNTRUSTED → trust dialog opens ────────────────────
    const testButton = page.getByTestId('button-test-electrum');
    await testButton.scrollIntoViewIfNeeded();
    await testButton.click();

    const dialog = page.getByTestId('dialog-electrum-cert-trust');
    const dialogVisible = await dialog
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'trust dialog opens on CERT_UNTRUSTED',
      passed: dialogVisible,
      detail: `dialog-electrum-cert-trust visible=${dialogVisible}`,
    });
    if (!dialogVisible) throw new Error('trust dialog never opened — aborting remaining steps');

    const dialogText = ((await dialog.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    const shownFingerprint =
      ((await page.getByTestId('text-electrum-cert-fingerprint').textContent().catch(() => '')) ?? '').trim();
    steps.push({
      name: 'dialog shows the untrusted-cert copy and SHA-256 fingerprint',
      passed:
        dialogText.includes('Untrusted Server Certificate') && shownFingerprint === MOCK_FINGERPRINT,
      detail: `fingerprint shown="${shownFingerprint.slice(0, 60)}..."`,
    });

    // ── Trust → electrumTrustCertificate called → retry succeeds ────────────
    await page.getByTestId('button-electrum-cert-trust').click();
    await dialog.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});

    // Retry runs automatically after trusting; wait for the success badges.
    const transportBadge = page.getByTestId('badge-electrum-transport');
    const transportVisible = await transportBadge
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const transportText = transportVisible
      ? ((await transportBadge.textContent().catch(() => '')) ?? '').trim()
      : '';
    steps.push({
      name: 'retried test shows the Transport: Direct badge',
      passed: transportVisible && transportText === 'Transport: Direct',
      detail: `visible=${transportVisible} text="${transportText}"`,
    });

    const certBadge = page.getByTestId('badge-electrum-cert-trust');
    const certBadgeText = ((await certBadge.textContent().catch(() => '')) ?? '').trim();
    steps.push({
      name: 'retried test shows the trusted-fingerprint certificate badge',
      passed: certBadgeText === 'Certificate: trusted fingerprint',
      detail: `text="${certBadgeText}"`,
    });

    const calls = await page.evaluate(() => {
      const c = window.__electrumMockCalls;
      return {
        testCount: c.electrumTest.length,
        trustCount: c.electrumTrustCertificate.length,
        trustCall: c.electrumTrustCertificate[0] ?? null,
        testHosts: c.electrumTest.map((p) => `${p.host}:${p.port}`),
      };
    });
    steps.push({
      name: 'electrumTrustCertificate called once with the host/port/fingerprint',
      passed:
        calls.trustCount === 1 &&
        calls.trustCall?.host === MOCK_HOST &&
        calls.trustCall?.port === MOCK_PORT &&
        calls.trustCall?.certificate?.fingerprint === MOCK_FINGERPRINT,
      detail: `trustCount=${calls.trustCount} call=${JSON.stringify({ host: calls.trustCall?.host, port: calls.trustCall?.port, fp: (calls.trustCall?.certificate?.fingerprint || '').slice(0, 20) })}`,
    });
    steps.push({
      name: 'electrumTest ran twice (initial failure + post-trust retry) against the same server',
      passed: calls.testCount === 2 && calls.testHosts.every((h) => h === `${MOCK_HOST}:${MOCK_PORT}`),
      detail: `testCount=${calls.testCount} hosts=${JSON.stringify(calls.testHosts)}`,
    });

    // ── Pinned-certificate panel refreshes after trust (bonus assertion) ────
    const pinnedFp = page.getByTestId('text-pinned-cert-fingerprint');
    const pinnedVisible = await pinnedFp
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const pinnedText = pinnedVisible ? ((await pinnedFp.textContent().catch(() => '')) ?? '').trim() : '';
    steps.push({
      name: 'pinned-certificate panel shows the newly trusted fingerprint',
      passed: pinnedVisible && pinnedText === MOCK_FINGERPRINT,
      detail: `visible=${pinnedVisible} text="${pinnedText.slice(0, 40)}..."`,
    });
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try { devProc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
  }

  const ok = steps.every((s) => s.passed);
  console.log(`[electrum-cert-trust-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[electrum-cert-trust-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[electrum-cert-trust-browser] PASSED: Electrum certificate trust prompt works end to end.');
}

main().catch((err) => {
  console.error('[electrum-cert-trust-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
