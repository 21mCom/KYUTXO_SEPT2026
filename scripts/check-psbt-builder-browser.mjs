#!/usr/bin/env node
// Real-browser regression guard for the watch-only PSBT builder on the UTXOs
// page:
//   1. creates a fresh vault and seeds one owned address (a REAL BIP-84
//      test-vector address, so scriptPubKey reconstruction works) with two
//      confirmed outputs (100k + 60k sats),
//   2. expands the address group, selects both UTXOs via the checkboxes and
//      asserts the selection bar total,
//   3. opens the Build PSBT dialog, enters a destination, and asserts the live
//      fee math (2 P2WPKH inputs + 1 output = 178 vB at 5 sats/vB = 890 sats),
//   4. saves the PSBT, then opens Saved PSBTs and asserts the entry exists with
//      its decoded components and that the stored base64 round-trips through
//      bitcoinjs-lib IN THE BROWSER (this is what catches a Buffer-global
//      crash that vitest cannot),
//   5. reloads the page and asserts the saved PSBT persists.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-psbt-builder-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'psbt-builder-check-123';

// BIP-84 test-vector addresses (valid mainnet P2WPKH).
const ADDR_W0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ADDR_W1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
const TX_A = 'aa'.repeat(32);
const TX_B = 'bb'.repeat(32);
const SATS_A = 100_000;
const SATS_B = 60_000;
// 2 P2WPKH inputs (68 vB) + 1 P2WPKH output (31) + 10.5 overhead = 178 vB.
const EXPECTED_FEE = 178 * 5;

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
  console.log('[psbt-builder-browser] legacy-migration overlay detected; waiting it out ...');
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

async function launchWithRetry(exe, attempts = 3) {
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
      console.log(`[psbt-builder-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function openSavedPsbts(page) {
  await page.getByTestId('button-saved-psbts').click();
  await page.getByTestId('dialog-saved-psbts').waitFor({ state: 'visible', timeout: 15_000 });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[psbt-builder-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[psbt-builder-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[psbt-builder-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  let bufferErrorSeen = false;

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('buffer is not defined')) bufferErrorSeen = true;
      if (msg.type() === 'error') {
        console.log(`[psbt-builder-browser][page-console] ${t}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true });

    // ── Seed one owned address with two confirmed outputs ───────────────────
    const seed = await page.evaluate(
      async ({ addr, txA, txB, satsA, satsB }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'PSBT builder check address',
        });
        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({ txid: txA, blockHeight: 800000, blockTime: now - 2 * 86400, fee: 100, feeRate: 1, syncedAt: Date.now() });
        await txCrud.addTransaction({ txid: txB, blockHeight: 800100, blockTime: now - 86400, fee: 100, feeRate: 1, syncedAt: Date.now() });
        await txCrud.addParticipant({ txid: txA, role: 'output', address: addr, amount: satsA, vout: 0, recordId });
        await txCrud.addParticipant({ txid: txB, role: 'output', address: addr, amount: satsB, vout: 1, recordId });
        return { recordId };
      },
      { addr: ADDR_W0, txA: TX_A, txB: TX_B, satsA: SATS_A, satsB: SATS_B },
    );
    steps.push({
      name: 'seeded one owned address with two confirmed outputs',
      passed: Number.isInteger(seed.recordId) && seed.recordId > 0,
      detail: `recordId=${seed.recordId}`,
    });

    // ── UTXOs page: expand the group and select both UTXOs ──────────────────
    await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const groupRow = page.getByTestId(`row-address-${ADDR_W0.slice(0, 8)}`);
    await groupRow.waitFor({ state: 'visible', timeout: 30_000 });
    await groupRow.click();

    const checkboxA = page.getByTestId(`checkbox-utxo-${TX_A}:0`);
    const checkboxB = page.getByTestId(`checkbox-utxo-${TX_B}:1`);
    await checkboxA.waitFor({ state: 'visible', timeout: 15_000 });
    await checkboxA.click();
    await checkboxB.click();

    const summary = page.getByTestId('text-selection-summary');
    await summary.waitFor({ state: 'visible', timeout: 10_000 });
    const summaryText = ((await summary.textContent()) ?? '').trim();
    steps.push({
      name: 'selection bar shows both UTXOs and the combined total',
      passed: summaryText.includes('2 UTXOs selected') && summaryText.includes('160,000 sats'),
      detail: `summary: "${summaryText}"`,
    });

    // ── Build dialog: live fee math for a send-max build ────────────────────
    await page.getByTestId('button-build-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('input-destination').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('input-destination').fill(ADDR_W1);

    const summaryPanel = page.getByTestId('panel-build-summary');
    await summaryPanel.waitFor({ state: 'visible', timeout: 15_000 });
    const feeText = ((await page.getByTestId('text-fee').textContent()) ?? '').trim();
    const sendText = ((await page.getByTestId('text-send-amount').textContent()) ?? '').trim();
    steps.push({
      name: `live fee math shows ${EXPECTED_FEE.toLocaleString()} sats at 5 sats/vB`,
      passed: feeText === `${EXPECTED_FEE.toLocaleString()} sats` && sendText === `${(160_000 - EXPECTED_FEE).toLocaleString()} sats`,
      detail: `fee: "${feeText}", send: "${sendText}"`,
    });

    // ── Save, then inspect in Saved PSBTs ───────────────────────────────────
    await page.getByTestId('button-save-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'detached', timeout: 15_000 });

    await openSavedPsbts(page);
    const savedRows = page.locator('[data-testid^="row-saved-psbt-"]');
    const savedCount = await savedRows.count();
    steps.push({
      name: 'saved PSBT appears in the Saved PSBTs list',
      passed: savedCount === 1,
      detail: `rows: ${savedCount}`,
    });

    await savedRows.first().click();
    const inputRows = page.locator('[data-testid^="row-psbt-input-"]');
    await inputRows.first().waitFor({ state: 'visible', timeout: 10_000 });
    const inputCount = await inputRows.count();
    steps.push({
      name: 'detail view lists both decoded inputs',
      passed: inputCount === 2,
      detail: `input rows: ${inputCount}`,
    });

    // Round-trip the stored base64 through the app's own decoder IN THE
    // BROWSER (bare package specifiers don't resolve inside page.evaluate,
    // so go through the Vite-served app module).
    const roundTrip = await page.evaluate(async () => {
      const crud = await import('/src/lib/data/saved-psbts-crud.ts');
      const psbtLib = await import('/src/lib/psbt.ts');
      const rows = await crud.getAllSavedPsbts();
      if (rows.length !== 1) return { ok: false, detail: `saved rows: ${rows.length}` };
      try {
        const s = psbtLib.decodePsbtSummary(rows[0].psbtBase64);
        return {
          ok: s.inputCount === 2 && s.outputCount === 1 && s.allInputsHaveWitnessUtxo && !s.hasSignatures,
          detail: `inputs=${s.inputCount} outputs=${s.outputCount} witnessUtxo=${s.allInputsHaveWitnessUtxo} sigs=${s.hasSignatures}`,
        };
      } catch (err) {
        return { ok: false, detail: `decode threw: ${err.message}` };
      }
    });
    steps.push({
      name: 'stored PSBT base64 round-trips through bitcoinjs-lib in the browser',
      passed: roundTrip.ok,
      detail: roundTrip.detail,
    });

    await page.keyboard.press('Escape');

    // ── Persistence across reload ────────────────────────────────────────────
    await page.reload({ waitUntil: 'load' });
    await unlockIfNeeded(page);
    await page.getByTestId('button-saved-psbts').waitFor({ state: 'visible', timeout: 30_000 });
    await openSavedPsbts(page);
    const afterReloadCount = await page.locator('[data-testid^="row-saved-psbt-"]').count();
    steps.push({
      name: 'saved PSBT persists across a page reload',
      passed: afterReloadCount === 1,
      detail: `rows after reload: ${afterReloadCount}`,
    });

    steps.push({
      name: 'no "Buffer is not defined" page error at any point',
      passed: !bufferErrorSeen,
      detail: bufferErrorSeen ? 'Buffer global referenced in the browser bundle' : 'clean',
    });
  } finally {
    await browser.close().catch(() => {});
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }

  const ok = steps.every((s) => s.passed);
  console.log(`[psbt-builder-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name}${step.detail ? ` :: ${step.detail}` : ''}`);
  }

  if (!ok) {
    console.error('\n[psbt-builder-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail ?? ''}`);
    }
    process.exit(1);
  }

  console.log('[psbt-builder-browser] PASSED: select UTXOs -> build -> save -> inspect -> reload all work in a real browser.');
}

main().catch((err) => {
  console.error('[psbt-builder-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
