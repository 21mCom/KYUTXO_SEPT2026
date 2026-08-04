#!/usr/bin/env node
// Real-browser regression guard for the Wallet Import private-key safety gate
// (Task #1798, pattern: scripts/check-wallet-import-reattribution-browser.mjs).
//
// Reproduced end to end in a REAL headless Chromium:
//   1. On /wallet-import, upload a file containing WIF/xprv-style private key
//      material.
//   2. Confirm the "Security Warning - File Rejected" destructive toast
//      appears with its warning text.
//   3. Confirm the file card does NOT appear (file state was cleared).
//   4. Confirm Next still blocks with the "No file selected" toast.
//   5. Sanity: upload a clean file afterwards and confirm it IS accepted,
//      proving the rejection didn't wedge the dropzone.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-private-key-file-reject-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'privkey-reject-check-123';

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

async function main() {
  const exe = resolveChromium();
  console.log(`[privkey-reject-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[privkey-reject-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[privkey-reject-browser] starting dev server (npm run dev) ...`);
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
      console.log(`[privkey-reject-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1600 },
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[privkey-reject-browser][page-console] ${msg.text()}`);
      }
    });

    await page.goto(`${BASE_URL}wallet-import`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    await page.getByTestId('dropzone-wallet-import').waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({ name: 'app unlocked and Wallet Import upload step visible', passed: true, detail: 'dropzone rendered' });

    // ── Upload a file containing private key material ─────────────────────
    // Both an xprv-style extended private key and a WIF-style key on its own
    // line — either alone must trip the gate; together they make the check
    // robust to a single pattern regressing.
    const fakeXprv = 'xprv' + 'A1B2c3D4e5F6g7H8i9J1k2L3m4N5o6P7q8R9s1T2u3V4w5X6y7Z8a9B1c2D3e4F5g6H7i8J9k1L2m3N4o5P6q7R8s9T1u2V3w4X5y6Z7a8B9c1D2e3F4g5H6';
    const fakeWif = 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ';
    const keyFile = [
      '{',
      `  "wallet": "sparrow",`,
      `  "master": "${fakeXprv}",`,
      `  "note": "backup"`,
      '}',
      fakeWif,
      '',
    ].join('\n');

    await page.setInputFiles('[data-testid="input-file-upload"]', {
      name: 'wallet-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(keyFile, 'utf8'),
    });

    // ── The destructive security toast must appear ────────────────────────
    const toastTitle = page.getByText('Security Warning - File Rejected', { exact: false }).first();
    const toastSeen = await toastTitle
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'destructive "Security Warning - File Rejected" toast appears',
      passed: toastSeen,
      detail: `toastSeen=${toastSeen}`,
    });

    const warningBody = await page
      .getByText('private key material and cannot be imported', { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'toast body explains the file contains private key material',
      passed: warningBody,
      detail: `warningBody=${warningBody}`,
    });

    // ── File card must NOT appear (file state cleared) ────────────────────
    // Give React a moment to (incorrectly) render the card if the state had
    // been kept, then assert its absence.
    await page.waitForTimeout(1_500);
    const cardVisible = await page
      .getByText('wallet-backup.json', { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    const walletTypeSelectVisible = await page
      .getByTestId('select-wallet-type')
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'file card does NOT appear after rejection (fileName + wallet-type select absent)',
      passed: !cardVisible && !walletTypeSelectVisible,
      detail: `cardVisible=${cardVisible} walletTypeSelectVisible=${walletTypeSelectVisible}`,
    });

    // ── The rejected content must not linger in page state ────────────────
    // Next must block exactly as if no file was ever chosen. In the real UI
    // the canProceed() gate (which requires fileContent) keeps the Next
    // button disabled — and React swallows even forced DOM clicks while
    // props.disabled is set, so the disabled state IS the block. (The
    // handler's own "No file selected" toast is unreachable defense-in-depth
    // behind it.) If the rejected fileContent had survived, Next would be
    // enabled and clicking it would advance to Setup.
    const nextDisabled = await page
      .getByTestId('button-next-step')
      .isDisabled()
      .catch(() => false);
    await page.getByTestId('button-next-step').click({ force: true }).catch(() => {});
    await page.waitForTimeout(1_000);
    const stillOnUpload = await page
      .getByTestId('dropzone-wallet-import')
      .isVisible()
      .catch(() => false);
    const setupVisible = await page
      .getByTestId('select-wallet-name')
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'Next stays disabled after rejection and even a forced click cannot leave the Upload step',
      passed: nextDisabled && stillOnUpload && !setupVisible,
      detail: `nextDisabled=${nextDisabled} stillOnUpload=${stillOnUpload} setupVisible=${setupVisible}`,
    });

    // ── SLIP-132 round: a real Sparrow/Electrum-style zprv export ─────────
    // The first fixture only covered xprv/WIF. The safety scan also rejects
    // SLIP-132 prefixes (yprv/zprv/uprv/vprv/...); prove the full
    // upload→reject path with a zprv-containing export file.
    //
    // First wait for the previous security toast to clear so the second
    // toast assertion cannot pass on the stale one.
    const staleToastGone = await toastTitle
      .waitFor({ state: 'detached', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!staleToastGone) {
      // Try dismissing via any visible toast close buttons, then re-wait.
      const closeButtons = page.locator('[toast-close], [data-radix-toast-announce-exclude] button, [aria-label="Close"]');
      const n = await closeButtons.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        await closeButtons.nth(i).click().catch(() => {});
      }
      await toastTitle.waitFor({ state: 'detached', timeout: 15_000 });
    }
    steps.push({ name: 'first security toast cleared before SLIP-132 round', passed: true, detail: 'toast detached' });

    // Structure mirrors a Sparrow "Export Wallet" / Electrum JSON: keystore
    // with a zprv master private key. 111 base58-ish chars after the prefix
    // (same shape as a real serialized extended key).
    const fakeZprv = 'zprv' + 'AWgYBBk7JR8Gj9r2X4t6V8w1Y3z5B7d9F2h4K6m8P1r3T5v7X9z2C4e6G8j1L3n5Q7s9U2w4Y6a8C1e3G5i7K9m2O4q6S8u1W3y5A7c9E2g4I6k8M';
    const zprvExport = [
      '{',
      '  "wallet_type": "standard",',
      '  "keystore": {',
      '    "type": "bip32",',
      `    "xprv": "${fakeZprv}",`,
      '    "derivation": "m/84h/0h/0h"',
      '  }',
      '}',
      '',
    ].join('\n');

    await page.setInputFiles('[data-testid="input-file-upload"]', {
      name: 'sparrow-zprv-export.json',
      mimeType: 'application/json',
      buffer: Buffer.from(zprvExport, 'utf8'),
    });

    const zprvToastSeen = await page
      .getByText('Security Warning - File Rejected', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'zprv export triggers the "Security Warning - File Rejected" toast',
      passed: zprvToastSeen,
      detail: `zprvToastSeen=${zprvToastSeen}`,
    });

    await page.waitForTimeout(1_500);
    const zprvCardVisible = await page
      .getByText('sparrow-zprv-export.json', { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    const zprvSelectVisible = await page
      .getByTestId('select-wallet-type')
      .isVisible()
      .catch(() => false);
    const zprvNextDisabled = await page
      .getByTestId('button-next-step')
      .isDisabled()
      .catch(() => false);
    steps.push({
      name: 'zprv file state cleared (no card, no wallet-type select, Next disabled)',
      passed: !zprvCardVisible && !zprvSelectVisible && zprvNextDisabled,
      detail: `zprvCardVisible=${zprvCardVisible} zprvSelectVisible=${zprvSelectVisible} zprvNextDisabled=${zprvNextDisabled}`,
    });

    // ── Sanity: a clean file is still accepted afterwards ─────────────────
    const cleanJson = JSON.stringify({
      wallet: 'sparrow',
      addresses: [
        { address: 'bc1qprivkeyrejectclean000', label: 'clean 0' },
        { address: 'bc1qprivkeyrejectclean001', label: 'clean 1' },
      ],
    });
    await page.setInputFiles('[data-testid="input-file-upload"]', {
      name: 'clean-labels.json',
      mimeType: 'application/json',
      buffer: Buffer.from(cleanJson, 'utf8'),
    });
    const cleanAccepted = await page
      .getByText('clean-labels.json', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'a clean file uploaded afterwards is still accepted (dropzone not wedged)',
      passed: cleanAccepted,
      detail: `cleanAccepted=${cleanAccepted}`,
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
  console.log(`[privkey-reject-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[privkey-reject-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[privkey-reject-browser] PASSED: wallet files containing private keys (xprv/WIF and SLIP-132 zprv) are rejected with a clear warning, the file state is cleared, and Next stays blocked.');
}

main().catch((err) => {
  console.error('[privkey-reject-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
