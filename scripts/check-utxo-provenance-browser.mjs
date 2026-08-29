#!/usr/bin/env node
// Real-browser regression guard for the UTXO Provenance page.
//
// Page under test: client/src/pages/UtxoProvenance.tsx (/utxo-provenance);
// walk engine: client/src/lib/utxo-provenance.ts (unit-tested in
// utxo-provenance.test.ts). This script proves the real wiring in Chromium:
// vault create → seed → page computes the unspent set + hop chains → wallet,
// search, and provenance filters → expand a row → hover a hop chip (tooltip)
// → click it (details dialog).
//
// Seed design (deterministic):
//   OWN_A/OWN_B/OWN_C owned records (manual tier), split between two wallets.
//   tx0 (origin):        ext input (no prevout) -> OWN_A 100k + ext change
//   tx1 (partial spend): spends tx0:0 -> merchant 60k + OWN_B 39k (change)
//   tx2 (wallet reorg):  spends tx1:1 -> OWN_C 38k + OWN_A 500 (all owned)
//   tx3 (origin):        ext input (no prevout) -> OWN_A 50k, unspent
//   tx5 (origin):        ext input (no prevout) -> OWN_A 70k
//   tx6 (partial spend): BLANK-address input spending tx5:0 (Electrum-style)
//                        -> merchant 40k + OWN_C 29k (change, unspent)
//   long fixture: 101 later-dated unspent outputs per wallet, used to cross
//                 the 100-row page boundary without changing the hop fixtures
//
// Expected unspent UTXOs:
//   tx2:0 / tx2:1 — hopsBack 3, patterns {wallet-reorg, partial-spend, origin}
//   tx3:0         — hopsBack 1, patterns {origin}
//   tx6:1         — hopsBack 2, patterns {partial-spend, origin}; tx6's input
//                   ownership must come from the tx5:0 prevout, not the blank
//                   input address
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-utxo-provenance-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}utxo-provenance`;
const SETUP_PASSWORD = 'utxo-provenance-check-123';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

const OWN_A = 'bc1qprovowna' + 'a'.repeat(30);
const OWN_B = 'bc1qprovownb' + 'b'.repeat(30);
const OWN_C = 'bc1qprovownc' + 'c'.repeat(30);
const MERCHANT = 'bc1qprovmerchant' + 'm'.repeat(26);
const EXT = 'bc1qprovext' + 'e'.repeat(30);

// Distinct first-8 chars per txid (testids embed txid.slice(0,8)).
const TX0 = 'aa00aa00' + '10'.repeat(28);
const TX1 = 'bb11bb11' + '20'.repeat(28);
const TX2 = 'cc22cc22' + '30'.repeat(28);
const TX3 = 'dd33dd33' + '40'.repeat(28);
const TX5 = 'ee44ee44' + '50'.repeat(28);
const TX6 = 'ff55ff55' + '60'.repeat(28);
const LONG_A_COUNT = 101;
const LONG_C_COUNT = 101;
const LONG_A_TXS = Array.from({ length: LONG_A_COUNT }, (_, i) =>
  `a1${i.toString(16).padStart(6, '0')}${'f'.repeat(56)}`,
);
const LONG_C_TXS = Array.from({ length: LONG_C_COUNT }, (_, i) =>
  `c2${i.toString(16).padStart(6, '0')}${'f'.repeat(56)}`,
);
const LONG_TXS = [
  ...LONG_A_TXS.map((txid, i) => ({
    txid,
    blockHeight: 701_000 + i,
    blockTime: NOW - 20 * DAY + i,
    fee: 0,
    feeRate: 0,
  })),
  ...LONG_C_TXS.map((txid, i) => ({
    txid,
    blockHeight: 702_000 + i,
    blockTime: NOW - 10 * DAY + i,
    fee: 0,
    feeRate: 0,
  })),
];
const LONG_PARTICIPANTS = [
  ...LONG_A_TXS.map((txid, i) => ({ txid, role: 'output', address: OWN_A, amount: 10_000 + i, vout: 0 })),
  ...LONG_C_TXS.map((txid, i) => ({ txid, role: 'output', address: OWN_C, amount: 20_000 + i, vout: 0 })),
];
const LONG_A_FIRST = LONG_A_TXS[0];
const LONG_A_LAST = LONG_A_TXS.at(-1);
const LONG_C_FIRST = LONG_C_TXS[0];
const LONG_C_LAST = LONG_C_TXS.at(-1);
const PAGE_BOUNDARY_DUST_OUTPOINTS = [
  { txid: LONG_A_LAST, vout: 0, address: OWN_A, amountSats: 10_000 + LONG_A_COUNT - 1 },
  ...LONG_C_TXS.slice(-6).map((txid, i) => ({
    txid,
    vout: 0,
    address: OWN_C,
    amountSats: 20_000 + LONG_C_COUNT - 6 + i,
  })),
];
const LIVE_UNFLAG_BOUNDARY_DUST_OUTPOINTS = PAGE_BOUNDARY_DUST_OUTPOINTS.slice(-2);
const dateDaysAgo = (days) => new Date((NOW - days * DAY) * 1000).toISOString().slice(0, 10);

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

async function launchWithRetry(exe) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(`[utxo-provenance-browser] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[utxo-provenance-browser] chromium: ${exe}`);

  let devProc = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[utxo-provenance-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[utxo-provenance-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[utxo-provenance-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[utxo-provenance-browser] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    // Fresh context => empty IndexedDB => "Create Vault" setup form. Block the
    // PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) console.log(`[utxo-provenance-browser][page-console] ${t}`);
    });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault ──────────────────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    await page.getByTestId('utxo-provenance-page').waitFor({ state: 'visible', timeout: 30_000 });

    const unlockPageIfNeeded = async () => {
      const pageRoot = page.getByTestId('utxo-provenance-page');
      if (await pageRoot.isVisible().catch(() => false)) return;
      await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
      await pageRoot.waitFor({ state: 'visible', timeout: 30_000 });
    };

    // ── Seed records + transactions (live CRUD singletons) ────────────────
    await page.evaluate(
      async ({ ownA, ownB, ownC, merchant, ext, tx0, tx1, tx2, tx3, tx5, tx6, now, day }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        await recordCrud.createRecord({ type: 'address', inputString: ownA, label: 'Savings', walletName: 'Savings wallet', addressImportance: 'manual' });
        await recordCrud.createRecord({ type: 'address', inputString: ownB, walletName: 'Savings wallet', addressImportance: 'manual' });
        await recordCrud.createRecord({ type: 'address', inputString: ownC, walletName: 'Spending wallet', addressImportance: 'manual' });

        await txCrud.bulkAddTransactions([
          { txid: tx0, blockHeight: 700_000, blockTime: now - 300 * day, fee: 1_000, feeRate: 2, syncedAt: Date.now() },
          { txid: tx1, blockHeight: 700_100, blockTime: now - 200 * day, fee: 1_000, feeRate: 2, syncedAt: Date.now() },
          { txid: tx2, blockHeight: 700_200, blockTime: now - 100 * day, fee: 500, feeRate: 2, syncedAt: Date.now() },
          { txid: tx3, blockHeight: 700_300, blockTime: now - 50 * day, fee: 1_000, feeRate: 2, syncedAt: Date.now() },
          { txid: tx5, blockHeight: 700_400, blockTime: now - 40 * day, fee: 1_000, feeRate: 2, syncedAt: Date.now() },
          { txid: tx6, blockHeight: 700_500, blockTime: now - 30 * day, fee: 1_000, feeRate: 2, syncedAt: Date.now() },
        ]);
        await txCrud.bulkAddParticipants([
          // tx0: external origin funding OWN_A
          { txid: tx0, role: 'input', address: ext, amount: 101_000 },
          { txid: tx0, role: 'output', address: ownA, amount: 100_000, vout: 0 },
          // tx1: partial spend — merchant leaves, change returns to OWN_B
          { txid: tx1, role: 'input', address: ownA, amount: 100_000, prevTxid: tx0, prevVout: 0 },
          { txid: tx1, role: 'output', address: merchant, amount: 60_000, vout: 0 },
          { txid: tx1, role: 'output', address: ownB, amount: 39_000, vout: 1 },
          // tx2: wallet reorg — everything stays owned
          { txid: tx2, role: 'input', address: ownB, amount: 39_000, prevTxid: tx1, prevVout: 1 },
          { txid: tx2, role: 'output', address: ownC, amount: 38_000, vout: 0 },
          { txid: tx2, role: 'output', address: ownA, amount: 500, vout: 1 },
          // tx3: fresh external inflow to OWN_A, unspent
          { txid: tx3, role: 'input', address: ext, amount: 51_000 },
          { txid: tx3, role: 'output', address: ownA, amount: 50_000, vout: 0 },
          // tx5: funds the Electrum-style spend below
          { txid: tx5, role: 'input', address: ext, amount: 71_000 },
          { txid: tx5, role: 'output', address: ownA, amount: 70_000, vout: 0 },
          // tx6: Electrum-style input — blank address, outpoint present.
          // Ownership must be derived from the tx5:0 prevout.
          { txid: tx6, role: 'input', address: '', amount: 70_000, prevTxid: tx5, prevVout: 0 },
          { txid: tx6, role: 'output', address: merchant, amount: 40_000, vout: 0 },
          { txid: tx6, role: 'output', address: ownC, amount: 29_000, vout: 1 },
        ]);
        return true;
      },
      { ownA: OWN_A, ownB: OWN_B, ownC: OWN_C, merchant: MERCHANT, ext: EXT, tx0: TX0, tx1: TX1, tx2: TX2, tx3: TX3, tx5: TX5, tx6: TX6, now: NOW, day: DAY },
    );
    record('seed', true, '3 owned addresses, 6 transactions seeded (incl. blank-input Electrum spend)');

    // Seeding happens through dynamic imports outside the page's live-query
    // wiring — reload once so the page re-reads, then re-unlock.
    await page.reload({ waitUntil: 'load' });
    await unlockPageIfNeeded();

    // ── Unspent set + hop counts ──────────────────────────────────────────
    // Unspent: tx2:0, tx2:1 (both reorg outputs), tx3:0 (fresh inflow) and
    // tx6:1 (Electrum blank-input change) — 4 rows total.
    await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByTestId(`utxo-prov-row-${TX3.slice(0, 8)}-0`).waitFor({ state: 'visible', timeout: 15_000 });
    const countText = await page.getByTestId('prov-count').textContent();
    record('unspent-set', countText?.startsWith('4 '), `row count text="${countText}" (tx2:0, tx2:1, tx3:0, tx6:1)`);

    // ── Wallet scope ───────────────────────────────────────────────────────
    const walletSelector = page.getByLabel('Wallet');
    record(
      'wallet-label',
      await walletSelector.getAttribute('data-testid') === 'prov-wallet-filter',
      'visible Wallet label names the wallet selector',
    );
    await page.getByTestId('prov-wallet-filter').click();
    await page.getByRole('option', { name: 'Savings wallet' }).click();
    const savingsCount = await page.getByTestId('prov-count').textContent();
    const savingsTx2ChangeVisible = await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-1`).isVisible().catch(() => false);
    const savingsTx3Visible = await page.getByTestId(`utxo-prov-row-${TX3.slice(0, 8)}-0`).isVisible().catch(() => false);
    const spendingTx2OutputVisible = await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).isVisible().catch(() => false);
    const spendingTx6ChangeVisible = await page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).isVisible().catch(() => false);
    record(
      'wallet-scope',
      savingsCount?.startsWith('2 ') &&
        savingsTx2ChangeVisible &&
        savingsTx3Visible &&
        !spendingTx2OutputVisible &&
        !spendingTx6ChangeVisible,
      `Savings wallet shows ${savingsCount}; Savings rows visible=${savingsTx2ChangeVisible && savingsTx3Visible}; Spending rows hidden=${!spendingTx2OutputVisible && !spendingTx6ChangeVisible}`,
    );
    await page.getByTestId('prov-wallet-filter').click();
    await page.getByRole('option', { name: 'All wallets' }).click();
    const allWalletsCount = await page.getByTestId('prov-count').textContent();
    record('all-wallets-scope', allWalletsCount?.startsWith('4 ') ?? false, `All wallets restores ${allWalletsCount}`);

    // ── Search independently by address, transaction ID, and label ─────────
    const search = page.getByTestId('prov-search');
    await search.fill(OWN_A);
    await page.getByTestId('prov-count').waitFor({ state: 'visible', timeout: 10_000 });
    const addressSearchCount = await page.getByTestId('prov-count').textContent();
    const addressTx2ChangeVisible = await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-1`).isVisible().catch(() => false);
    const addressTx3Visible = await page.getByTestId(`utxo-prov-row-${TX3.slice(0, 8)}-0`).isVisible().catch(() => false);
    const addressTx2OutputVisible = await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).isVisible().catch(() => false);
    const addressTx6ChangeVisible = await page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).isVisible().catch(() => false);
    record(
      'search-address',
      addressSearchCount?.startsWith('2 ') &&
        addressTx2ChangeVisible &&
        addressTx3Visible &&
        !addressTx2OutputVisible &&
        !addressTx6ChangeVisible,
      `address search shows ${addressSearchCount}; OWN_A rows visible=${addressTx2ChangeVisible && addressTx3Visible}; other rows hidden=${!addressTx2OutputVisible && !addressTx6ChangeVisible}`,
    );

    await search.fill(TX6);
    const txidSearchCount = await page.getByTestId('prov-count').textContent();
    const txidRowVisible = await page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).isVisible().catch(() => false);
    const txidOtherRowsHidden =
      !(await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).isVisible().catch(() => false)) &&
      !(await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-1`).isVisible().catch(() => false)) &&
      !(await page.getByTestId(`utxo-prov-row-${TX3.slice(0, 8)}-0`).isVisible().catch(() => false));
    record(
      'search-transaction-id',
      txidSearchCount?.startsWith('1 ') && txidRowVisible && txidOtherRowsHidden,
      `transaction-ID search shows ${txidSearchCount}; TX6 row visible=${txidRowVisible}; other rows hidden=${txidOtherRowsHidden}`,
    );

    await search.fill('Savings');
    const labelSearchCount = await page.getByTestId('prov-count').textContent();
    const labelTx2ChangeVisible = await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-1`).isVisible().catch(() => false);
    const labelTx3Visible = await page.getByTestId(`utxo-prov-row-${TX3.slice(0, 8)}-0`).isVisible().catch(() => false);
    const labelOtherRowsHidden =
      !(await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).isVisible().catch(() => false)) &&
      !(await page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).isVisible().catch(() => false));
    record(
      'search-label',
      labelSearchCount?.startsWith('2 ') &&
        labelTx2ChangeVisible &&
        labelTx3Visible &&
        labelOtherRowsHidden,
      `label search shows ${labelSearchCount}; Savings rows visible=${labelTx2ChangeVisible && labelTx3Visible}; other rows hidden=${labelOtherRowsHidden}`,
    );
    await search.fill('');

    // ── Flagged dust toggle + live flag updates ─────────────────────────────
    // Keep a date filter active while changing dust. Marking the wallet-reorg
    // output plus the blank-input partial-spend output changes all four summary
    // cards as well as the table without touching either filter control.
    const liveDustDateRange = page.getByTestId('utxo-provenance-date-range');
    await liveDustDateRange.getByTestId('input-utxo-provenance-date-range-from').fill(dateDaysAgo(120));
    await liveDustDateRange.getByTestId('input-utxo-provenance-date-range-to').fill(dateDaysAgo(1));
    await page.getByText('4 UTXOs', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    const scopedSummaryBeforeDust = await Promise.all(
      ['prov-stat-total', 'prov-stat-history', 'prov-stat-partial', 'prov-stat-reorg'].map((testId) =>
        page.getByTestId(testId).textContent(),
      ),
    );
    record(
      'dust-summary-scoped-baseline',
      scopedSummaryBeforeDust.map((value) => value?.trim()).join(',') === '4,3,3,2',
      `date-filtered baseline summaries total/history/partial/reorg=${scopedSummaryBeforeDust.join('/')}`,
    );

    await page.getByTestId('switch-ignore-prov-dust').click();
    await page.evaluate(
      async (outpoints) => {
        const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
        await dustCrud.markOutpointsAsDust(outpoints);
      },
      [
        { txid: TX2, vout: 0, address: OWN_C, amountSats: 38_000 },
        { txid: TX6, vout: 1, address: OWN_C, amountSats: 29_000 },
      ],
    );
    await page.getByTestId('prov-dust-status').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).waitFor({ state: 'hidden', timeout: 10_000 });
    await page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).waitFor({ state: 'hidden', timeout: 10_000 });
    const countIgnoringDust = await page.getByTestId('prov-count').textContent();
    const dustRowsVisible = await Promise.all([
      page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).isVisible().catch(() => false),
      page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).isVisible().catch(() => false),
    ]);
    const dustStatus = await page.getByTestId('prov-dust-status').textContent();
    const scopedSummaryIgnoringDust = await Promise.all(
      ['prov-stat-total', 'prov-stat-history', 'prov-stat-partial', 'prov-stat-reorg'].map((testId) =>
        page.getByTestId(testId).textContent(),
      ),
    );
    record(
      'ignore-flagged-dust-summary',
      countIgnoringDust?.startsWith('2 ') &&
        dustRowsVisible.every((visible) => !visible) &&
        dustStatus?.includes('Hiding 2 flagged dust UTXOs') === true &&
        scopedSummaryIgnoringDust.map((value) => value?.trim()).join(',') === '2,1,1,1',
      `ignoring dust shows ${countIgnoringDust}, summaries total/history/partial/reorg=${scopedSummaryIgnoringDust.join('/')} and dust rows hidden=${dustRowsVisible.every((visible) => !visible)}`,
    );
    await page.evaluate(
      async (outpoints) => {
        const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
        await dustCrud.unmarkDustOutpoints(outpoints);
      },
      [`${TX2}:0`, `${TX6}:1`],
    );
    await page.getByTestId('prov-dust-status').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).waitFor({ state: 'visible', timeout: 10_000 });
    const restoredDustCount = await page.getByTestId('prov-count').textContent();
    const scopedSummaryAfterUnflag = await Promise.all(
      ['prov-stat-total', 'prov-stat-history', 'prov-stat-partial', 'prov-stat-reorg'].map((testId) =>
        page.getByTestId(testId).textContent(),
      ),
    );
    record(
      'live-dust-unflag-summary',
      restoredDustCount?.startsWith('4 ') &&
        scopedSummaryAfterUnflag.map((value) => value?.trim()).join(',') === '4,3,3,2',
      `unflagging dust live restores ${restoredDustCount}; summaries total/history/partial/reorg=${scopedSummaryAfterUnflag.join('/')}`,
    );
    await liveDustDateRange.getByTestId('button-utxo-provenance-date-range-clear').click();
    await page.getByTestId('switch-ignore-prov-dust').click();
    if (process.env.UTXO_PROVENANCE_SCREENSHOT) {
      await page.screenshot({
        path: 'client/public/downloads/utxo-provenance-wallet-dust.png',
        fullPage: true,
      });
      console.log('[utxo-provenance-browser] screenshot saved: client/public/downloads/utxo-provenance-wallet-dust.png');
    }

    const hopsBackTx2 = await page.getByTestId(`hops-back-${TX2.slice(0, 8)}-0`).textContent();
    const hopsBackTx3 = await page.getByTestId(`hops-back-${TX3.slice(0, 8)}-0`).textContent();
    const hopsBackTx6 = await page.getByTestId(`hops-back-${TX6.slice(0, 8)}-1`).textContent();
    record(
      'hop-depth',
      hopsBackTx2?.trim() === '3' && hopsBackTx3?.trim() === '1' && hopsBackTx6?.trim() === '2',
      `tx2 hopsBack="${hopsBackTx2}" (want 3), tx3 hopsBack="${hopsBackTx3}" (want 1), tx6 hopsBack="${hopsBackTx6}" (want 2)`,
    );

    // Blank-address input (Electrum) must classify via its owned prevout as a
    // partial spend, not as an external origin.
    await page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).click();
    await page.getByTestId(`hop-list-${TX6.slice(0, 8)}-1`).waitFor({ state: 'visible', timeout: 15_000 });
    const chipTx6 = await page.getByTestId(`hop-chip-${TX6.slice(0, 8)}`).textContent();
    record(
      'electrum-blank-input',
      (chipTx6?.includes('H1') ?? false) && (chipTx6?.includes('Partial spend') ?? false),
      `tx6 H1 chip="${chipTx6}" (blank input owned via prevout tx5:0)`,
    );
    // Collapse it again so later row interactions are unambiguous.
    await page.getByTestId(`utxo-prov-row-${TX6.slice(0, 8)}-1`).click();

    // ── Expand the reorg row: hop chips with dates + classifications ──────
    await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).click();
    await page.getByTestId(`hop-list-${TX2.slice(0, 8)}-0`).waitFor({ state: 'visible', timeout: 15_000 });
    const chipTx2 = await page.getByTestId(`hop-chip-${TX2.slice(0, 8)}`).textContent();
    const chipTx1 = await page.getByTestId(`hop-chip-${TX1.slice(0, 8)}`).textContent();
    const chipTx0 = await page.getByTestId(`hop-chip-${TX0.slice(0, 8)}`).textContent();
    record(
      'hop-chips',
      (chipTx2?.includes('H1') && chipTx2?.includes('Wallet reorg')) &&
        (chipTx1?.includes('H2') && chipTx1?.includes('Partial spend')) &&
        (chipTx0?.includes('H3') && chipTx0?.includes('External origin')),
      `chips: H1="${chipTx2}" H2="${chipTx1}" H3="${chipTx0}"`,
    );

    // ── Hover exposes transaction details in a tooltip ────────────────────
    await page.getByTestId(`hop-chip-${TX1.slice(0, 8)}`).hover();
    const tooltip = page.getByRole('tooltip');
    await tooltip.waitFor({ state: 'visible', timeout: 10_000 });
    const tooltipText = await tooltip.textContent();
    record(
      'hop-tooltip',
      (tooltipText?.includes(TX1) ?? false) &&
        (tooltipText?.includes('1 in') ?? false) &&
        (tooltipText?.includes('2 out') ?? false) &&
        (tooltipText?.includes('Fee 1,000 sats') ?? false),
      `tooltip="${(tooltipText ?? '').slice(0, 160)}…"`,
    );

    // ── Click opens the details popup ─────────────────────────────────────
    // Move away first so the tooltip does not swallow the click.
    await page.mouse.move(0, 0);
    await page.getByTestId(`hop-chip-${TX1.slice(0, 8)}`).click();
    const dialog = page.getByTestId('hop-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    const dialogText = await dialog.textContent();
    record(
      'hop-dialog',
      (dialogText?.includes(TX1) ?? false) &&
        (dialogText?.includes('Inputs (1)') ?? false) &&
        (dialogText?.includes('Outputs (2)') ?? false) &&
        (dialogText?.includes(MERCHANT.slice(0, 10)) ?? false) &&
        (dialogText?.includes('60,000 sats') ?? false),
      `dialog shows txid, both sides and the merchant output`,
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });

    // Opening (and closing) the dialog must not collapse the expanded trail.
    const trailStillOpen = await page.getByTestId(`hop-list-${TX2.slice(0, 8)}-0`).isVisible().catch(() => false);
    record('row-stays-expanded', trailStillOpen, 'hop list still visible after dialog open/close');

    // ── Filters ───────────────────────────────────────────────────────────
    await page.getByTestId('prov-min-hops').click();
    await page.getByRole('option', { name: '≥ 2' }).click();
    await page.getByTestId(`utxo-prov-row-${TX2.slice(0, 8)}-0`).waitFor({ state: 'visible', timeout: 10_000 });
    const tx3VisibleAfterMinHops = await page.getByTestId(`utxo-prov-row-${TX3.slice(0, 8)}-0`).isVisible().catch(() => false);
    const countAfterMinHops = await page.getByTestId('prov-count').textContent();
    record(
      'filter-min-hops',
      !tx3VisibleAfterMinHops && countAfterMinHops?.startsWith('3 '),
      `min-hops≥2 leaves ${countAfterMinHops} (tx2:0, tx2:1, tx6:1), tx3 hidden=${!tx3VisibleAfterMinHops}`,
    );

    await page.getByTestId('prov-min-hops').click();
    await page.getByRole('option', { name: 'Any' }).click();
    await page.getByTestId('prov-class-filter').click();
    await page.getByRole('option', { name: 'Has partial spend' }).click();
    const countAfterClass = await page.getByTestId('prov-count').textContent();
    record(
      'filter-classification',
      countAfterClass?.startsWith('3 ') ?? false,
      `partial-spend filter leaves ${countAfterClass} (tx2:0, tx2:1 via tx1; tx6:1 via tx6)`,
    );

    // ── Long-list wallet/search/pagination coverage ────────────────────────
    // Keep these outputs later than the six hop fixtures so the original
    // assertions above remain on page 1. Their first-8 txid prefixes are
    // distinct and each wallet has 101 extra rows: 103 rows per wallet,
    // 206 total, spanning the 100-row page boundary.
    await page.evaluate(
      async ({ transactions, participants }) => {
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        await txCrud.bulkAddTransactions(
          transactions.map((tx) => ({ ...tx, syncedAt: Date.now() })),
        );
        await txCrud.bulkAddParticipants(participants);
        return true;
      },
      { transactions: LONG_TXS, participants: LONG_PARTICIPANTS },
    );
    record('long-list-seed', true, '202 later-dated unspent outputs seeded (101 per wallet)');

    // As with the first seed, reload to make the page re-read the live CRUD
    // writes. The reload also proves controls return to their default scope.
    await page.reload({ waitUntil: 'load' });
    await unlockPageIfNeeded();
    const pageStatus = page.getByTestId('prov-page-status');
    const rowVisible = async (txid, vout = 0) =>
      page.getByTestId(`utxo-prov-row-${txid.slice(0, 8)}-${vout}`).isVisible().catch(() => false);
    const waitForPage = async (status) => {
      await pageStatus.waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByText(status, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    };
    await page.getByTestId(`utxo-prov-row-${LONG_A_FIRST.slice(0, 8)}-0`).waitFor({ state: 'visible', timeout: 60_000 });
    await waitForPage('Page 1 of 3');
    const longAllCount = await page.getByTestId('prov-count').textContent();
    record(
      'long-list-all-wallets',
      longAllCount?.startsWith('206 ') &&
        await rowVisible(LONG_A_FIRST) &&
        !(await rowVisible(LONG_C_LAST)),
      `all-wallet view shows ${longAllCount} on page 1 of 3 without a page-3 row`,
    );

    // Navigate to the end, then switch wallets. The selected wallet must
    // reset to its own first page rather than leave the old page-3 slice
    // visible or show rows from the other wallet.
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 3');
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 3 of 3');
    record(
      'long-list-last-page',
      await rowVisible(LONG_C_LAST) && !(await rowVisible(LONG_A_FIRST)),
      'page 3 shows the final Spending-wallet row and no stale page-1 row',
    );

    await page.getByTestId('prov-wallet-filter').click();
    await page.getByRole('option', { name: 'Savings wallet' }).click();
    await page.getByTestId('prov-count').waitFor({ state: 'visible', timeout: 15_000 });
    await waitForPage('Page 1 of 2');
    const longSavingsCount = await page.getByTestId('prov-count').textContent();
    record(
      'long-list-wallet-savings-reset',
      longSavingsCount?.startsWith('103 ') &&
        await rowVisible(TX2, 1) &&
        await rowVisible(LONG_A_FIRST) &&
        !(await rowVisible(LONG_C_LAST)),
      `Savings wallet resets to page 1 of 2 with ${longSavingsCount}; no Spending row`,
    );

    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 2');
    record(
      'long-list-wallet-savings-page-2',
      await rowVisible(LONG_A_LAST) && !(await rowVisible(LONG_A_FIRST)),
      'Savings page 2 contains its final output across the page boundary',
    );

    // Address search keeps all 103 Savings rows and reaches the same second
    // page; this catches filtering against only the currently rendered page.
    const longSearch = page.getByTestId('prov-search');
    await longSearch.fill(OWN_A);
    await waitForPage('Page 1 of 2');
    const longAddressCount = await page.getByTestId('prov-count').textContent();
    const addressPageOneCorrect =
      longAddressCount?.startsWith('103 ') &&
      await rowVisible(TX2, 1) &&
      await rowVisible(LONG_A_FIRST) &&
      !(await rowVisible(LONG_A_LAST));
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 2');
    record(
      'long-list-search-address',
      addressPageOneCorrect && await rowVisible(LONG_A_LAST) && !(await rowVisible(LONG_C_FIRST)),
      `address search keeps ${longAddressCount} rows across two pages`,
    );

    // The label is attached to OWN_A, so label search must have identical
    // count/page behavior and must not retain the address-search page slice.
    await longSearch.fill('Savings');
    await waitForPage('Page 1 of 2');
    const longLabelCount = await page.getByTestId('prov-count').textContent();
    const labelPageOneCorrect =
      longLabelCount?.startsWith('103 ') &&
      await rowVisible(TX2, 1) &&
      await rowVisible(LONG_A_FIRST) &&
      !(await rowVisible(LONG_A_LAST));
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 2');
    record(
      'long-list-search-label',
      labelPageOneCorrect && await rowVisible(LONG_A_LAST) && !(await rowVisible(LONG_C_FIRST)),
      `label search keeps ${longLabelCount} rows across two pages`,
    );

    // Every A fixture txid shares the "a1" prefix. This is a transaction-ID
    // search with 101 matches, so its final matching row is only on page 2.
    await longSearch.fill('a1');
    await waitForPage('Page 1 of 2');
    const longTxidCount = await page.getByTestId('prov-count').textContent();
    const txidPageOneCorrect =
      longTxidCount?.startsWith('101 ') &&
      await rowVisible(LONG_A_FIRST) &&
      !(await rowVisible(LONG_A_LAST));
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 2');
    record(
      'long-list-search-transaction-id',
      txidPageOneCorrect && await rowVisible(LONG_A_LAST) && !(await rowVisible(LONG_C_FIRST)),
      `transaction-ID search keeps ${longTxidCount} rows across two pages`,
    );

    // Narrowing from page 2 to one exact transaction must reset to page 1
    // and remove every previously rendered row, not merely clamp its label.
    await longSearch.fill(LONG_A_LAST);
    await page.getByTestId('prov-count').waitFor({ state: 'visible', timeout: 15_000 });
    await waitForPage('Page 1 of 1');
    const exactTxidCount = await page.getByTestId('prov-count').textContent();
    record(
      'long-list-search-reset',
      exactTxidCount?.startsWith('1 ') &&
        await rowVisible(LONG_A_LAST) &&
        !(await rowVisible(LONG_A_FIRST)) &&
        !(await rowVisible(LONG_C_FIRST)),
      `exact txid search resets to ${exactTxidCount} on page 1 of 1 without stale rows`,
    );

    // Switch from the narrowed Savings view to Spending and back to All to
    // verify both wallet scopes and the page count are recalculated.
    await longSearch.fill('');
    await waitForPage('Page 1 of 2');
    await page.getByTestId('prov-wallet-filter').click();
    await page.getByRole('option', { name: 'Spending wallet' }).click();
    await waitForPage('Page 1 of 2');
    const longSpendingCount = await page.getByTestId('prov-count').textContent();
    record(
      'long-list-wallet-spending',
      longSpendingCount?.startsWith('103 ') &&
        await rowVisible(TX2, 0) &&
        await rowVisible(LONG_C_FIRST) &&
        !(await rowVisible(LONG_A_FIRST)),
      `Spending wallet shows ${longSpendingCount} on page 1 of 2 without Savings rows`,
    );
    await page.getByTestId('prov-wallet-filter').click();
    await page.getByRole('option', { name: 'All wallets' }).click();
    await waitForPage('Page 1 of 3');
    const longRestoredAllCount = await page.getByTestId('prov-count').textContent();
    record(
      'long-list-wallet-all-reset',
      longRestoredAllCount?.startsWith('206 ') &&
        await rowVisible(TX2, 0) &&
        await rowVisible(LONG_A_FIRST) &&
        !(await rowVisible(LONG_C_LAST)),
      `All wallets restores ${longRestoredAllCount} on page 1 of 3`,
    );

    // Enable Hide dust before navigating to page 3, then mark rows from that
    // later page through the live dust CRUD path. The exclusion crosses the
    // 200-row boundary: 206 rows become 199, so the control must clamp to
    // page 2 of 2 and replace the old page-3 slice without a toggle change.
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 3');
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 3 of 3');
    await page.getByTestId('switch-ignore-prov-dust').click();
    await waitForPage('Page 1 of 3');
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 3');
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 3 of 3');
    await page.evaluate(async (outpoints) => {
      const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
      await dustCrud.markOutpointsAsDust(outpoints);
    }, PAGE_BOUNDARY_DUST_OUTPOINTS);
    await page.getByText('199 UTXOs', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await waitForPage('Page 2 of 2');
    const hiddenBoundaryDustCount = await page.getByTestId('prov-count').textContent();
    const boundaryDustRowsAfterMark = await Promise.all(
      PAGE_BOUNDARY_DUST_OUTPOINTS.map(({ txid, vout }) => rowVisible(txid, vout)),
    );
    record(
      'long-list-live-mark-dust-pagination',
      hiddenBoundaryDustCount?.startsWith('199 ') &&
        await rowVisible(LONG_C_FIRST) &&
        !(await rowVisible(LONG_A_FIRST)) &&
        boundaryDustRowsAfterMark.every((visible) => !visible) &&
        (await page.getByTestId('prov-dust-status').textContent()) === 'Hiding 7 flagged dust UTXOs' &&
        (await page.getByTestId('switch-ignore-prov-dust').getAttribute('data-state')) === 'checked',
      `live dust marking clamps page 3 to page 2 of 2 with ${hiddenBoundaryDustCount}; rebuilt slice has C rows, no flagged row remains mounted, and Hide dust stays on`,
    );

    const boundaryDustRowsOnPageTwo = await Promise.all(
      PAGE_BOUNDARY_DUST_OUTPOINTS.map(({ txid, vout }) => rowVisible(txid, vout)),
    );
    record(
      'long-list-hide-dust-no-stale-rows',
      await rowVisible(LONG_C_FIRST) &&
        boundaryDustRowsOnPageTwo.every((visible) => !visible) &&
        !(await rowVisible(LONG_A_LAST)),
      'filtered page 2 contains live non-dust rows and no stale dust rows',
    );

    // Unflag two rows that were removed from the original final page while
    // Hide dust remains enabled. The result grows from 199 to 201, crossing
    // the 200-row boundary again; live dust CRUD must restore page 3 and its
    // newly unflagged final-page row without requiring the toggle to be changed.
    await page.evaluate(async (outpoints) => {
      const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
      await dustCrud.unmarkDustOutpoints(outpoints.map(({ txid, vout }) => `${txid}:${vout}`));
    }, LIVE_UNFLAG_BOUNDARY_DUST_OUTPOINTS);
    await page.getByText('201 UTXOs', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await waitForPage('Page 3 of 3');
    await page.getByTestId('prov-prev').click();
    await waitForPage('Page 2 of 3');
    const liveUnflagRowOnPageTwo = await rowVisible(LIVE_UNFLAG_BOUNDARY_DUST_OUTPOINTS[0].txid, LIVE_UNFLAG_BOUNDARY_DUST_OUTPOINTS[0].vout);
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 3 of 3');
    const liveUnflagRowsOnPageThree = await Promise.all(
      LIVE_UNFLAG_BOUNDARY_DUST_OUTPOINTS.map(({ txid, vout }) => rowVisible(txid, vout)),
    );
    const liveUnflagDustStatus = await page.getByTestId('prov-dust-status').textContent();
    const hideDustStillEnabled = (await page.getByTestId('switch-ignore-prov-dust').getAttribute('data-state')) === 'checked';
    const liveUnflagCount = await page.getByTestId('prov-count').textContent();
    record(
      'long-list-live-unflag-dust-pagination',
      liveUnflagCount?.startsWith('201 ') &&
        liveUnflagRowOnPageTwo &&
        liveUnflagRowsOnPageThree[0] === false &&
        liveUnflagRowsOnPageThree[1] === true &&
        liveUnflagDustStatus === 'Hiding 5 flagged dust UTXOs' &&
        hideDustStillEnabled,
      `live unflagging shows ${liveUnflagCount} across pages 2/3; revived rows page 2=${liveUnflagRowOnPageTwo}, page 3=${liveUnflagRowsOnPageThree[1]}, Hide dust on=${hideDustStillEnabled}`,
    );

    // Clear the remaining boundary flags while the filter is still enabled so
    // the existing toggle-off assertion continues to prove the original
    // unfiltered count is restored.
    await page.evaluate(async (outpoints) => {
      const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
      await dustCrud.unmarkDustOutpoints(outpoints.map(({ txid, vout }) => `${txid}:${vout}`));
    }, PAGE_BOUNDARY_DUST_OUTPOINTS);
    await page.getByText('206 UTXOs', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('prov-dust-status').waitFor({ state: 'hidden', timeout: 15_000 });

    await page.getByTestId('switch-ignore-prov-dust').click();
    await waitForPage('Page 1 of 3');
    const restoredAfterHideDustCount = await page.getByTestId('prov-count').textContent();
    record(
      'long-list-hide-dust-page-count-restored',
      restoredAfterHideDustCount?.startsWith('206 ') &&
        await rowVisible(LONG_A_FIRST) &&
        !(await page.getByTestId('prov-dust-status').isVisible().catch(() => false)),
      `turning Hide dust off restores ${restoredAfterHideDustCount} on page 1 of 3`,
    );

    // Date filtering from page 3 must reset to the first page of the
    // filtered result, not leave the prior page-3 rows mounted. The A long
    // fixture occupies a 21-to-19-days-ago window and has 101 rows, so its
    // filtered result still crosses the 100-row boundary.
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 3');
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 3 of 3');
    const dateRange = page.getByTestId('utxo-provenance-date-range');
    await dateRange.getByTestId('input-utxo-provenance-date-range-from').fill(dateDaysAgo(21));
    await dateRange.getByTestId('input-utxo-provenance-date-range-to').fill(dateDaysAgo(19));
    await waitForPage('Page 1 of 2');
    const dateFilteredCount = await page.getByTestId('prov-count').textContent();
    const datePageOneCorrect =
      dateFilteredCount?.startsWith('101 ') &&
      await rowVisible(LONG_A_FIRST) &&
      !(await rowVisible(LONG_A_LAST)) &&
      !(await rowVisible(LONG_C_FIRST)) &&
      !(await rowVisible(LONG_C_LAST));
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 2');
    record(
      'long-list-date-filter-reset',
      datePageOneCorrect &&
        await rowVisible(LONG_A_LAST) &&
        !(await rowVisible(LONG_A_FIRST)) &&
        !(await rowVisible(LONG_C_FIRST)) &&
        !(await rowVisible(LONG_C_LAST)),
      `date range leaves ${dateFilteredCount} A-wallet rows across two pages without stale C-wallet rows`,
    );

    // Clear the date window before testing the pattern filter, then move
    // back to page 3 so the pattern change has to reset the page explicitly.
    await dateRange.getByTestId('button-utxo-provenance-date-range-clear').click();
    await waitForPage('Page 1 of 3');
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 2 of 3');
    await page.getByTestId('prov-next').click();
    await waitForPage('Page 3 of 3');
    await page.getByTestId('prov-class-filter').click();
    await page.getByRole('option', { name: 'Has wallet reorg' }).click();
    await waitForPage('Page 1 of 1');
    const patternFilteredCount = await page.getByTestId('prov-count').textContent();
    record(
      'long-list-pattern-filter-reset',
      patternFilteredCount?.startsWith('2 ') &&
        await rowVisible(TX2, 0) &&
        await rowVisible(TX2, 1) &&
        !(await rowVisible(LONG_A_FIRST)) &&
        !(await rowVisible(LONG_A_LAST)) &&
        !(await rowVisible(LONG_C_LAST)),
      `wallet-reorg pattern leaves ${patternFilteredCount} core rows on page 1 of 1 without stale long-list rows`,
    );
  } finally {
    await browser.close();
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[utxo-provenance-browser] ${steps.length - failed.length}/${steps.length} checks passed`);
  if (failed.length > 0) {
    console.error('[utxo-provenance-browser] FAILED: ' + failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log('[utxo-provenance-browser] OK');
}

main().catch((err) => {
  console.error('[utxo-provenance-browser] fatal:', err);
  process.exit(1);
});
