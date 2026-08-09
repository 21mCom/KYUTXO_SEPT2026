#!/usr/bin/env node
// Real-browser regression guard for the Dormant Coins per-row "Re-sync"
// action shown next to a "Spent" node-check annotation.
//
// NOTE for reviewers: the page under test is client/src/pages/DormantCoins.tsx
// (routed at /dormant-coins); the per-row action lives in
// client/src/pages/dormant-coins/dormant-results-list.tsx (LiveCheckCell +
// runResync). The jsdom tests (client/src/pages/DormantCoins.test.tsx) stub
// the sync service; this check exercises the REAL wiring in Chromium:
// vault unlock → seed → scan → "Check node" reports Spent → Re-sync runs the
// real provider probe (createProviderFromSettings + getBlockHeight) and the
// real transactionSyncService.syncSingleAddress against a route-stubbed
// Esplora (mempool.space) — no real network traffic occurs.
//
// Covered paths:
//   1. Failure: the provider probe is unreachable (tip-height request
//      aborted) → destructive "Can't reach the blockchain provider" toast,
//      and the Re-sync button is restored (state cleared, retry possible).
//   2. Success: probe OK, syncSingleAddress completes against the stubbed
//      Esplora endpoints → "Address re-synced" nudge toast and the amber
//      "Re-synced — re-run scan" stale badge replaces the button.
//   3. The real sync actually hit the network layer: the stub records the
//      tip-height, address-summary, and address-txs endpoint calls.
//   4. Full promise: the stubbed history returns the transaction that spends
//      the re-synced outpoint, so re-running the scan drops that row and both
//      sats totals shrink by exactly that output's amount.
//
// Seed design (mirrors check-dormant-live-check-browser.mjs, smaller N):
//   - One owned address record OWN (manual tier).
//   - N old funding txs (5y): outputs OWN vout0 + unknown UP_i vout1.
//   - One co-spend tx TXC (6y) + one funding tx TXU1 (7y) for U1.
//   - Expected rows: 2N + 1. The Re-sync target row is mkTx(0):0 (OWN's
//     oldest own-dormant output), stubbed as spent by the node.
//
// Usage: node scripts/check-dormant-resync-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}dormant-coins`;
const SETUP_PASSWORD = 'dormant-resync-check-123';

const N = 60; // 2N + 1 = 121 rows
const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365.25 * 24 * 60 * 60;
const OLD_5Y = Math.floor(NOW - 5 * YEAR);
const OLD_6Y = Math.floor(NOW - 6 * YEAR);
const OLD_7Y = Math.floor(NOW - 7 * YEAR);

const OWN = 'bc1qdormresyncown' + 'o'.repeat(25);
const U1 = 'bc1qdormresyncu1' + 'u'.repeat(26);
const U2 = 'bc1qdormresyncu2' + 'v'.repeat(26);
const TXC = 'cb'.repeat(32);
const TXU1 = '1d'.repeat(32);
const SPENDER_TXID = 'fe'.repeat(32);
// Destination of the spending tx; below the min-amount floor (10k sats) so it
// can never surface as a dormant candidate row of its own.
const SPEND_DEST = 'bc1qdormresyncdst' + 'w'.repeat(25);
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
      console.log(`[dormant-resync-browser] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dormant-resync-browser] chromium: ${exe}`);

  let devProc = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[dormant-resync-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[dormant-resync-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[dormant-resync-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[dormant-resync-browser] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) console.log(`[dormant-resync-browser][page-console] ${t}`);
    });

    // ── Stub the Esplora API (default provider: mempool.space) ────────────
    // providerUp toggles the failure vs success re-sync paths. Everything
    // unexpected under mempool.space is refused so no request leaks out.
    let providerUp = false;
    const calls = { tipHeight: 0, addressSummary: 0, addressTxs: 0, outspend: 0 };
    await context.route('**://mempool.space/**', async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

      if (p === '/api/blocks/tip/height') {
        calls.tipHeight++;
        if (!providerUp) return route.abort('failed');
        return route.fulfill({ status: 200, contentType: 'text/plain', body: '850000' });
      }
      const outspend = p.match(/^\/api\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/);
      if (outspend) {
        calls.outspend++;
        const [, txid, voutStr] = outspend;
        if (txid === TX0 && Number(voutStr) === 0)
          return json({ spent: true, txid: SPENDER_TXID, vin: 0, status: { confirmed: true } });
        return json({ spent: false });
      }
      if (p === `/api/address/${OWN}/txs` || p.startsWith(`/api/address/${OWN}/txs/`)) {
        calls.addressTxs++;
        if (!providerUp) return route.abort('failed');
        // Confirmed history containing the transaction that SPENDS the
        // "Spent" row's outpoint (TX0:0). The real sync imports it, so a
        // re-run of the dormant scan must drop that row. The spend is OLD
        // (still before the dormancy cutoff) so OWN's other outputs stay
        // dormant, and its own output is below the min-amount floor so it
        // never becomes a candidate row itself. Single page (<25 txs).
        return json([
          {
            txid: SPENDER_TXID,
            version: 2,
            locktime: 0,
            vin: [
              {
                txid: TX0,
                vout: 0,
                sequence: 0xfffffffd,
                prevout: {
                  scriptpubkey_address: OWN,
                  value: 20_000,
                  scriptpubkey_type: 'v0_p2wpkh',
                },
              },
            ],
            vout: [
              {
                n: 0,
                scriptpubkey_address: SPEND_DEST,
                value: 9_000,
                scriptpubkey_type: 'v0_p2wpkh',
              },
            ],
            fee: 11_000,
            size: 191,
            weight: 764,
            status: { confirmed: true, block_height: 750_000, block_time: OLD_5Y + 100_000 },
          },
        ]);
      }
      if (p === `/api/address/${OWN}`) {
        calls.addressSummary++;
        if (!providerUp) return route.abort('failed');
        return json({
          address: OWN,
          chain_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
          mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
        });
      }
      console.log(`[dormant-resync-browser] BLOCKED unexpected request: ${url.href}`);
      return route.abort();
    });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault ──────────────────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
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

    // ── "Check node" on OWN's oldest output → Spent + Re-sync button ──────
    const kSpent = rowKey(TX0, 0);
    await page.getByTestId(`row-dormant-${kSpent}`).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId(`button-live-check-${kSpent}`).click();
    const spentBadge = page.getByTestId(`live-spent-${kSpent}`);
    await spentBadge.waitFor({ state: 'visible', timeout: 15_000 });
    const resyncBtn = page.getByTestId(`button-resync-${kSpent}`);
    const resyncVisible = await resyncBtn.isVisible();
    record('spent-with-resync', resyncVisible, `Spent badge shown with Re-sync button beside it (visible=${resyncVisible})`);

    // ── Failure path: provider unreachable → destructive toast + button ───
    const tipCallsBefore = calls.tipHeight;
    await resyncBtn.click();
    // Toast text duplicates into aria-live; use .first().
    await page
      .getByText("Can't reach the blockchain provider")
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    // The button must be restored (state cleared) so the user can retry —
    // and no stale badge may appear.
    await resyncBtn.waitFor({ state: 'visible', timeout: 15_000 });
    const staleAfterFail = await page.getByTestId(`resynced-stale-${kSpent}`).isVisible().catch(() => false);
    record(
      'fail-toast-and-restore',
      calls.tipHeight > tipCallsBefore && !staleAfterFail,
      `probe hit tip-height (${calls.tipHeight - tipCallsBefore} call), destructive toast shown, Re-sync button restored, no stale badge`,
    );

    // ── Success path: provider up → real sync → nudge toast + stale badge ─
    providerUp = true;
    const tipBefore = calls.tipHeight;
    const txsBefore = calls.addressTxs;
    await resyncBtn.click();
    await page
      .getByText('Address re-synced')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    const staleBadge = page.getByTestId(`resynced-stale-${kSpent}`);
    await staleBadge.waitFor({ state: 'visible', timeout: 15_000 });
    const staleText = await staleBadge.textContent();
    const btnGone = !(await resyncBtn.isVisible().catch(() => false));
    record(
      'resync-success',
      (staleText?.includes('Re-synced — re-run scan') ?? false) && btnGone,
      `stale badge text="${staleText?.trim()}" button replaced=${btnGone}`,
    );
    record(
      'real-sync-network',
      calls.tipHeight >= tipBefore + 2 && calls.addressTxs > txsBefore,
      `tip-height calls +${calls.tipHeight - tipBefore} (probe + sync), address-txs calls +${calls.addressTxs - txsBefore}, address-summary=${calls.addressSummary}`,
    );

    // ── Stale badge survives scrolling out of the window and back ─────────
    const scrollBox = page.getByTestId('scroll-dormant-rows');
    await scrollBox.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.getByTestId(`row-dormant-${kSpent}`).waitFor({ state: 'detached', timeout: 15_000 });
    await scrollBox.evaluate((el) => { el.scrollTop = 0; });
    await page.getByTestId(`row-dormant-${kSpent}`).waitFor({ state: 'visible', timeout: 15_000 });
    const stalePersisted = await staleBadge.isVisible();
    record('persist-scroll', stalePersisted, `stale badge visible after scroll round-trip=${stalePersisted}`);

    // ── Re-run the scan: the re-synced spent outpoint must drop out ───────
    // The Re-sync imported SPENDER_TXID, whose input consumes TX0:0. Exact
    // outpoint matching must now classify TX0:0 as spent: one fewer row and
    // both sats totals shrink by exactly the row's 20,000-sat amount.
    const parseSats = (t) => Number((t ?? '').replace(/[^0-9]/g, ''));
    const totalBefore = parseSats(await page.getByTestId('text-summary-total-sats').textContent());
    const ownBefore = parseSats(await page.getByTestId('text-summary-own-sats').textContent());

    await page.getByTestId('button-run-scan').click();
    await page.waitForFunction(
      (expected) =>
        document.querySelector('[data-testid="text-summary-rows"]')?.textContent === expected,
      fmt(EXPECTED_ROWS - 1),
      { timeout: 120_000 },
    );
    const rowsAfter = await page.getByTestId('text-summary-rows').textContent();
    const spentRowGone = (await page.getByTestId(`row-dormant-${kSpent}`).count()) === 0;
    record(
      'rescan-drops-spent-row',
      rowsAfter === fmt(EXPECTED_ROWS - 1) && spentRowGone,
      `rows=${rowsAfter} (expected ${fmt(EXPECTED_ROWS - 1)}), spent row ${kSpent} gone=${spentRowGone}`,
    );

    const totalAfter = parseSats(await page.getByTestId('text-summary-total-sats').textContent());
    const ownAfter = parseSats(await page.getByTestId('text-summary-own-sats').textContent());
    record(
      'rescan-shrinks-totals',
      totalBefore - totalAfter === 20_000 && ownBefore - ownAfter === 20_000,
      `total ${totalBefore}→${totalAfter} (Δ${totalBefore - totalAfter}), own ${ownBefore}→${ownAfter} (Δ${ownBefore - ownAfter}); expected Δ20,000 each`,
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
  console.log(`\n[dormant-resync-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length > 0) {
    console.error('[dormant-resync-browser] FAILED steps:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[dormant-resync-browser] fatal:', err);
  process.exit(1);
});
