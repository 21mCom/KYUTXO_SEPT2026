#!/usr/bin/env node
// Real-browser regression guard for the Dormant Coins per-row "Check node"
// live verification.
//
// NOTE for reviewers: the page under test is client/src/pages/DormantCoins.tsx
// (routed at /dormant-coins); the per-row action lives in
// client/src/pages/dormant-coins/dormant-results-list.tsx (LiveCheckCell +
// runLiveCheck) and the outpoint check itself in
// client/src/lib/dormant-live-check.ts. The default node provider is
// mempool.space (Esplora), whose /tx/:txid/outspend/:vout endpoint this check
// stubs via Playwright route interception — no real network traffic occurs.
//
// The jsdom tests (client/src/lib/dormant-coins.test.ts,
// client/src/pages/DormantCoins.test.tsx) stub the provider factory; this
// check proves the real wiring end-to-end in Chromium: vault unlock → seed →
// scan → click "Check node" on real rows → the provider issues the real
// Esplora outspend fetch → badge annotations render ("Still unspent", "Spent",
// "Unknown — retry"), the error path recovers via retry, and all annotations
// survive scrolling the rows out of the virtualized window and back (state
// lives in the list component, not the windowed row cache).
//
// Seed design (mirrors check-dormant-coins-browser.mjs, smaller N):
//   - One owned address record OWN (manual tier).
//   - N old funding txs (5y): outputs OWN vout0 + unknown UP_i vout1
//     → N own-dormant + N paid-alongside rows.
//   - One co-spend tx TXC (6y): inputs OWN + U1 + U2.
//   - One funding tx TXU1 (7y): output U1 vout0, unspent → oldest row, first.
//   - Expected rows: 2N + 1.
//
// Stubbed outspend behavior (keyed by txid/vout):
//   - TXU1:0        → { spent: false }               → "Still unspent"
//   - mkTx(0):0     → { spent: true, txid: SPENDER } → "Spent" (+ txid title)
//   - mkTx(0):1     → 404 on first call ("node does not know") → error state
//                     "Unknown — retry"; second call → { spent: false } →
//                     retry recovers to "Still unspent".
//
// Usage: node scripts/check-dormant-live-check-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}dormant-coins`;
const SETUP_PASSWORD = 'dormant-live-check-123';

const N = 150; // 2N + 1 = 301 rows — enough that the 420px list virtualizes.
const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365.25 * 24 * 60 * 60;
const OLD_5Y = Math.floor(NOW - 5 * YEAR);
const OLD_6Y = Math.floor(NOW - 6 * YEAR);
const OLD_7Y = Math.floor(NOW - 7 * YEAR);

const OWN = 'bc1qdormlivecheckown' + 'o'.repeat(22);
const U1 = 'bc1qdormlivechecku1' + 'u'.repeat(23);
const U2 = 'bc1qdormlivechecku2' + 'v'.repeat(23);
const TXC = 'cb'.repeat(32);
const TXU1 = '1d'.repeat(32);
const SPENDER_TXID = 'fe'.repeat(32);
// Must match the seeder's mkTx(0) below.
const TX0 = (0).toString(16).padStart(8, '0') + 'ab'.repeat(28);

for (const [name, addr] of [['OWN', OWN], ['U1', U1], ['U2', U2]]) {
  if (addr.length !== 42) throw new Error(`${name} must be 42 chars (got ${addr.length})`);
}

const EXPECTED_ROWS = 2 * N + 1;
const fmt = (n) => n.toLocaleString('en-US');
const rowKey = (txid, vout) => `${txid.slice(0, 12)}-${vout}`;

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
      console.log(`[dormant-live-check-browser] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dormant-live-check-browser] chromium: ${exe}`);

  let devProc = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[dormant-live-check-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[dormant-live-check-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[dormant-live-check-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[dormant-live-check-browser] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) console.log(`[dormant-live-check-browser][page-console] ${t}`);
    });

    // ── Stub the Esplora outspend endpoint (default provider: mempool.space).
    // Everything else under mempool.space is refused so no request can leak
    // to the real network.
    const outspendCalls = [];
    let tx0Vout1Calls = 0;
    await context.route('https://mempool.space/**', async (route) => {
      const url = route.request().url();
      const m = url.match(/\/api\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/);
      if (!m) {
        console.log(`[dormant-live-check-browser] BLOCKED unexpected request: ${url}`);
        return route.abort();
      }
      const [, txid, voutStr] = m;
      const vout = Number(voutStr);
      outspendCalls.push(`${txid}:${vout}`);
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (txid === TXU1 && vout === 0) return json({ spent: false });
      if (txid === TX0 && vout === 0)
        return json({ spent: true, txid: SPENDER_TXID, vin: 0, status: { confirmed: true } });
      if (txid === TX0 && vout === 1) {
        tx0Vout1Calls++;
        if (tx0Vout1Calls === 1) return route.fulfill({ status: 404, body: 'Transaction not found' });
        return json({ spent: false });
      }
      // Any other outpoint is unexpected in this check.
      return route.fulfill({ status: 500, body: 'unexpected outpoint' });
    });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault ──────────────────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    await page.getByTestId('button-run-scan').waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed records + transactions (live CRUD singletons) ────────────────
    await page.evaluate(
      async ({ n, own, u1, u2, txc, txu1, old5y, old6y, old7y }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        await recordCrud.createRecord({
          type: 'address',
          inputString: own,
          label: 'Old savings wallet',
          addressImportance: 'manual',
        });

        const mkAddr = (p, i) => (`${p}${i}` + 'z'.repeat(42)).slice(0, 42);
        const mkTx = (i) => i.toString(16).padStart(8, '0') + 'ab'.repeat(28);
        const fakePrev = (i) => i.toString(16).padStart(8, '0') + '00'.repeat(28);

        const TX_CHUNK = 500;
        for (let start = 0; start < n; start += TX_CHUNK) {
          const end = Math.min(start + TX_CHUNK, n);
          const txs = [];
          const parts = [];
          for (let i = start; i < end; i++) {
            const txid = mkTx(i);
            txs.push({ txid, blockHeight: 700_000 + i, blockTime: old5y + i, fee: 500, feeRate: 2, syncedAt: Date.now() });
            parts.push({ txid, role: 'input', address: mkAddr('bc1qfunder', i), amount: 60_000 + i, prevTxid: fakePrev(i), prevVout: 0 });
            parts.push({ txid, role: 'output', address: own, amount: 20_000 + i, vout: 0 });
            parts.push({ txid, role: 'output', address: mkAddr('bc1qpaidup', i), amount: 30_000 + i, vout: 1 });
          }
          await txCrud.bulkAddTransactions(txs);
          await txCrud.bulkAddParticipants(parts);
        }

        await txCrud.addTransaction({ txid: txc, blockHeight: 600_000, blockTime: old6y, fee: 500, feeRate: 2, syncedAt: Date.now() });
        await txCrud.bulkAddParticipants([
          { txid: txc, role: 'input', address: own, amount: 100_000, prevTxid: fakePrev(n + 1), prevVout: 0 },
          { txid: txc, role: 'input', address: u1, amount: 640_000, prevTxid: fakePrev(n + 2), prevVout: 0 },
          { txid: txc, role: 'input', address: u2, amount: 50_000, prevTxid: fakePrev(n + 3), prevVout: 0 },
          { txid: txc, role: 'output', address: mkAddr('bc1qcospenddest', 0), amount: 780_000, vout: 0 },
        ]);

        await txCrud.addTransaction({ txid: txu1, blockHeight: 500_000, blockTime: old7y, fee: 500, feeRate: 2, syncedAt: Date.now() });
        await txCrud.bulkAddParticipants([
          { txid: txu1, role: 'input', address: mkAddr('bc1qu1funder', 0), amount: 510_000, prevTxid: fakePrev(n + 4), prevVout: 0 },
          { txid: txu1, role: 'output', address: u1, amount: 500_000, vout: 0 },
        ]);
        return true;
      },
      { n: N, own: OWN, u1: U1, u2: U2, txc: TXC, txu1: TXU1, old5y: OLD_5Y, old6y: OLD_6Y, old7y: OLD_7Y },
    );
    record('seed', true, `${N} funding txs + co-spend fixtures seeded`);

    // ── Run the scan ──────────────────────────────────────────────────────
    await page.getByTestId('button-run-scan').click();
    await page.getByTestId('text-summary-rows').waitFor({ state: 'visible', timeout: 120_000 });
    const rowsText = await page.getByTestId('text-summary-rows').textContent();
    record('scan', rowsText === fmt(EXPECTED_ROWS), `rows=${rowsText} (expected ${fmt(EXPECTED_ROWS)})`);

    // The three oldest rows are at the top of the list: TXU1:0 (7y), then
    // mkTx(0):0 and mkTx(0):1 (both 5y+0s).
    const kU1 = rowKey(TXU1, 0);
    const kSpent = rowKey(TX0, 0);
    const kRetry = rowKey(TX0, 1);
    await page.getByTestId(`row-dormant-${kU1}`).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId(`row-dormant-${kSpent}`).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId(`row-dormant-${kRetry}`).waitFor({ state: 'visible', timeout: 15_000 });

    // ── "Still unspent" path ──────────────────────────────────────────────
    await page.getByTestId(`button-live-check-${kU1}`).click();
    const unspentBadge = page.getByTestId(`live-unspent-${kU1}`);
    await unspentBadge.waitFor({ state: 'visible', timeout: 15_000 });
    const unspentText = await unspentBadge.textContent();
    record('unspent-badge', unspentText?.trim() === 'Still unspent', `badge text="${unspentText?.trim()}"`);

    // ── "Spent" path (with spender txid in the tooltip) ───────────────────
    await page.getByTestId(`button-live-check-${kSpent}`).click();
    const spentBadge = page.getByTestId(`live-spent-${kSpent}`);
    await spentBadge.waitFor({ state: 'visible', timeout: 15_000 });
    const spentText = await spentBadge.textContent();
    const spentTitle = (await spentBadge.getAttribute('title')) ?? '';
    record(
      'spent-badge',
      spentText?.trim() === 'Spent' && spentTitle.includes(`Spent by ${SPENDER_TXID}`),
      `badge text="${spentText?.trim()}" title includes spender txid=${spentTitle.includes(SPENDER_TXID)}`,
    );

    // ── Unknown/error path → retry recovers ───────────────────────────────
    await page.getByTestId(`button-live-check-${kRetry}`).click();
    const retryBtn = page.getByTestId(`button-live-retry-${kRetry}`);
    await retryBtn.waitFor({ state: 'visible', timeout: 15_000 });
    const retryText = await retryBtn.textContent();
    const retryTitle = (await retryBtn.getAttribute('title')) ?? '';
    record(
      'unknown-retry',
      (retryText?.includes('Unknown — retry') ?? false) && retryTitle.includes('Could not verify'),
      `retry button text="${retryText?.trim()}" title="${retryTitle.slice(0, 60)}..."`,
    );
    await retryBtn.click();
    await page.getByTestId(`live-unspent-${kRetry}`).waitFor({ state: 'visible', timeout: 15_000 });
    record('retry-recovers', tx0Vout1Calls === 2, `second outspend call succeeded (calls=${tx0Vout1Calls})`);

    // ── Annotations survive scrolling out of and back into the window ─────
    const scrollBox = page.getByTestId('scroll-dormant-rows');
    await scrollBox.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    // The virtualizer must actually unmount the top rows (overscan 12 << 301).
    await page.getByTestId(`row-dormant-${kU1}`).waitFor({ state: 'detached', timeout: 15_000 });
    // Wait for a bottom window to load so the scroll genuinely rendered rows.
    const lastRowIdx = EXPECTED_ROWS - 1;
    await page
      .getByTestId(`row-dormant-loading-${lastRowIdx}`)
      .waitFor({ state: 'detached', timeout: 15_000 })
      .catch(() => {}); // may never have shown if the window loaded instantly
    record('scrolled-away', true, 'top rows unmounted after scrolling to the bottom');

    await scrollBox.evaluate((el) => { el.scrollTop = 0; });
    await page.getByTestId(`row-dormant-${kU1}`).waitFor({ state: 'visible', timeout: 15_000 });
    const persistedUnspent = await page.getByTestId(`live-unspent-${kU1}`).isVisible();
    const persistedSpent = await page.getByTestId(`live-spent-${kSpent}`).isVisible();
    const persistedRetryUnspent = await page.getByTestId(`live-unspent-${kRetry}`).isVisible();
    record(
      'persist-scroll',
      persistedUnspent && persistedSpent && persistedRetryUnspent,
      `after scroll round-trip: unspent=${persistedUnspent} spent=${persistedSpent} retried-unspent=${persistedRetryUnspent}`,
    );

    // No duplicate fetches happened for already-resolved rows on re-render.
    const expectedCalls = 4; // TXU1:0, TX0:0, TX0:1 (404), TX0:1 (retry)
    record(
      'call-count',
      outspendCalls.length === expectedCalls,
      `outspend endpoint hit ${outspendCalls.length} times (expected ${expectedCalls}): ${outspendCalls.join(', ')}`,
    );

    await context.close();
  } finally {
    await browser.close();
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[dormant-live-check-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length > 0) {
    console.error('[dormant-live-check-browser] FAILED steps:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[dormant-live-check-browser] fatal:', err);
  process.exit(1);
});
