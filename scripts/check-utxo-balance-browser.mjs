#!/usr/bin/env node
// Real-browser regression guard for the UTXOs page total with Electrum-shaped
// sync data (task: "Fix UTXO page inflated balance").
//
// Electrum-synced transactions store inputs with prevTxid/prevVout outpoints
// but NO prevout address/amount. The Standard (heuristic) mode used to match
// spends only by input `address:amount`, so those spends were never subtracted
// and the page total showed TOTAL RECEIVED instead of the unspent balance.
// The fix makes spent detection outpoint-first in heuristic mode too, with FIFO
// amount-matching only for inputs that lack outpoints, plus a data-coverage
// warning when some inputs are missing outpoint data.
//
// This script drives a REAL headless Chromium against the running dev server:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds one owned address with two confirmed outputs (50k + 30k sats),
//      one Electrum-shaped input spending the 50k output (outpoint only,
//      blank address / 0 amount), and one legacy input with NO outpoint data
//      (so outpoint coverage is 50%)
//   3. opens the UTXOs page in the default Standard mode and asserts:
//      - the total balance reads 0.00030000 BTC (unspent), NOT 0.00080000
//        (total received — the pre-fix inflated value)
//      - the UTXO count card shows 1
//      - the heuristic low-coverage warning with the re-sync hint is visible
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-utxo-balance-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'utxo-balance-check-123';

const OWNED_ADDR = 'bc1qutxobalancecheckownedaddressxxxxxxxx';
const TX_RECEIVE_1 = 'e1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0aa01';
const TX_RECEIVE_2 = 'e1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0aa02';
const TX_SPEND = 'e1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0aa03';
const TX_LEGACY = 'e1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0aa04';
const SPENT_SATS = 50_000;
const UNSPENT_SATS = 30_000;

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
  const hasConfirm = await confirmInput.isVisible().catch(() => false);
  if (hasConfirm) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
  return true;
}

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[utxo-balance-browser] legacy-migration overlay detected; waiting it out ...');
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

async function main() {
  const exe = resolveChromium();
  console.log(`[utxo-balance-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[utxo-balance-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[utxo-balance-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[utxo-balance-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (msg.type() === 'error' || t.toLowerCase().includes('buffer is not defined')) {
        console.log(`[utxo-balance-browser][page-console] ${t}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed an Electrum-shaped vault via the live Vite module singletons ───
    const seed = await page.evaluate(
      async ({ addr, txR1, txR2, txSpend, txLegacy, spentSats, unspentSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'UTXO balance check address',
        });
        const now = Math.floor(Date.now() / 1000);
        const txs = [
          { txid: txR1, blockHeight: 800000, blockTime: now - 3 * 86400 },
          { txid: txR2, blockHeight: 800100, blockTime: now - 2 * 86400 },
          { txid: txSpend, blockHeight: 800200, blockTime: now - 86400 },
          { txid: txLegacy, blockHeight: 800300, blockTime: now - 43200 },
        ];
        for (const t of txs) {
          await txCrud.addTransaction({ ...t, fee: 100, feeRate: 1, syncedAt: Date.now() });
        }
        // Two received outputs.
        await txCrud.addParticipant({ txid: txR1, role: 'output', address: addr, amount: spentSats, vout: 0, recordId });
        await txCrud.addParticipant({ txid: txR2, role: 'output', address: addr, amount: unspentSats, vout: 0, recordId });
        // Electrum-shaped spend of the first output: outpoint present, NO
        // prevout address/amount. Amount-matching can never subtract this.
        await txCrud.addParticipant({ txid: txSpend, role: 'input', address: '', amount: 0, prevTxid: txR1, prevVout: 0 });
        // Legacy pre-migration input: no outpoint data at all (drops coverage
        // to 50% so the heuristic warning must appear). Its amount matches no
        // output, so it must not change the total.
        await txCrud.addParticipant({ txid: txLegacy, role: 'input', address: addr, amount: 99_999 });
        return { recordId };
      },
      {
        addr: OWNED_ADDR,
        txR1: TX_RECEIVE_1,
        txR2: TX_RECEIVE_2,
        txSpend: TX_SPEND,
        txLegacy: TX_LEGACY,
        spentSats: SPENT_SATS,
        unspentSats: UNSPENT_SATS,
      },
    );
    steps.push({
      name: 'seeded Electrum-shaped vault (2 outputs, 1 outpoint-only spend, 1 legacy input)',
      passed: Number.isInteger(seed.recordId) && seed.recordId > 0,
      detail: `recordId=${seed.recordId}`,
    });

    // ── UTXOs page (default Standard/heuristic mode) ────────────────────────
    await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const totalEl = page.getByTestId('text-total-balance');
    await totalEl.waitFor({ state: 'visible', timeout: 30_000 });
    // Wait until the async UTXO computation settles on a non-zero total.
    const expectedBtc = (UNSPENT_SATS / 100_000_000).toFixed(8); // 0.00030000
    const inflatedBtc = ((UNSPENT_SATS + SPENT_SATS) / 100_000_000).toFixed(8); // 0.00080000
    let totalText = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      totalText = ((await totalEl.textContent()) ?? '').trim();
      if (totalText.includes(expectedBtc) || totalText.includes(inflatedBtc)) break;
      await page.waitForTimeout(500);
    }
    steps.push({
      name: 'Standard-mode total equals the UNSPENT balance (outpoint spend subtracted)',
      passed: totalText.includes(expectedBtc) && !totalText.includes(inflatedBtc),
      detail: `total balance: "${totalText}" (expected ${expectedBtc} BTC, inflated pre-fix value would be ${inflatedBtc} BTC)`,
    });

    const countText = ((await page.getByTestId('text-utxo-count').textContent()) ?? '').trim();
    steps.push({
      name: 'UTXO count reflects one remaining unspent output',
      passed: /^1\b/.test(countText),
      detail: `utxo count: "${countText}" (expected 1)`,
    });

    const warning = page.getByTestId('text-heuristic-coverage-warning');
    const warningVisible = await warning
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const warningText = warningVisible ? ((await warning.textContent()) ?? '').trim() : '';
    steps.push({
      name: 'heuristic low-coverage warning with re-sync hint is shown',
      passed: warningVisible && /50%/.test(warningText) && /re-sync/i.test(warningText),
      detail: warningVisible ? `warning: "${warningText}"` : 'warning never appeared',
    });
  } finally {
    await browser.close();
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

  console.log(`[utxo-balance-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[utxo-balance-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[utxo-balance-browser] PASSED: UTXOs page shows the true unspent balance for Electrum-shaped data, with the coverage warning.',
  );
}

main().catch((err) => {
  console.error('[utxo-balance-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
