#!/usr/bin/env node
// Real-browser regression guard for the Dormant Coins report page.
//
// NOTE for reviewers: the page under test is client/src/pages/DormantCoins.tsx,
// routed at /dormant-coins (client/src/App.tsx); the scan engine is
// client/src/lib/dormant-coins.ts and results persist in the scratch store
// client/src/lib/data/dormant-coins-report-store.ts.
//
// The unit tests (client/src/lib/dormant-coins.test.ts,
// client/src/pages/DormantCoins.test.tsx) cover the engine math and jsdom
// rendering, but nothing proves the real wiring in a browser: vault unlock →
// page → run scan with visible progress → cancel → streamed results in the
// virtualized list → persistence across reload → interrupted-run notice →
// CSV export — at a multi-thousand-transaction scale.
//
// Seed design (deterministic, expectations computed from N below):
//   - One owned address record OWN (manual tier).
//   - N old funding txs (5y old): input from a fake funder (outpoint to a
//     nonexistent prev tx), outputs OWN vout0 (20_000+i sats) and unknown
//     UP_i vout1 (30_000+i sats) → N own-dormant + N paid-alongside rows.
//   - One co-spend tx TXC (6y old): inputs OWN + U1 + U2 → co-spend cluster.
//   - One funding tx TXU1 (7y old): output U1 vout0 500_000 sats, unspent →
//     1 co-spent row, ranked FIRST (oldest). Group #1 members: U1, U2.
//   - Expected rows: 2N + 1; groupCount: 1.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-dormant-coins-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}dormant-coins`;
const SETUP_PASSWORD = 'dormant-coins-check-123';

const N = 4000; // old funding transactions (2N + 1 expected rows)
const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365.25 * 24 * 60 * 60;
const OLD_5Y = Math.floor(NOW - 5 * YEAR);
const OLD_6Y = Math.floor(NOW - 6 * YEAR);
const OLD_7Y = Math.floor(NOW - 7 * YEAR);

const OWN = 'bc1qdormbrowserown' + 'o'.repeat(24);
const U1 = 'bc1qdormbrowseru1' + 'u'.repeat(25);
const U2 = 'bc1qdormbrowseru2' + 'v'.repeat(25);
const TXC = 'cb'.repeat(32);
const TXU1 = '1d'.repeat(32);

for (const [name, addr] of [['OWN', OWN], ['U1', U1], ['U2', U2]]) {
  if (addr.length !== 42) throw new Error(`${name} must be 42 chars (got ${addr.length})`);
}

// Expected totals, derived from the seed shape (not hardcoded).
const sumOwn = N * 20_000 + ((N - 1) * N) / 2;
const sumPaid = N * 30_000 + ((N - 1) * N) / 2;
const EXPECTED_ROWS = 2 * N + 1;
const EXPECTED_TOTAL = sumOwn + sumPaid + 500_000;
const fmt = (n) => n.toLocaleString('en-US');

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
      console.log(`[dormant-coins-browser] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dormant-coins-browser] chromium: ${exe}`);

  let devProc = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[dormant-coins-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[dormant-coins-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[dormant-coins-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[dormant-coins-browser] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    // Fresh context => empty IndexedDB => "Create Vault" setup form. Block the
    // PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) console.log(`[dormant-coins-browser][page-console] ${t}`);
    });

    // Slow the CPU so the scan spans many progress frames — the cancel click
    // below gates on a streamed phase and needs the run to still be in flight.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault ──────────────────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });

    await page.getByTestId('button-run-scan').waitFor({ state: 'visible', timeout: 30_000 });

    // Every reload returns to the lock screen (the vault key is session-only),
    // so re-unlock before expecting the page. After a reload, React has not
    // mounted yet at waitUntil:'load' — wait for EITHER the password input or
    // the page itself, then unlock only if the lock screen actually showed.
    const reUnlockIfNeeded = async () => {
      const runBtn = page.getByTestId('button-run-scan');
      const first = await Promise.race([
        waitForLoginScreenVisible(page, { timeoutMs: 30_000 }).then(() => 'locked'),
        runBtn.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'unlocked'),
      ]).catch(() => 'timeout');
      if (first === 'locked') {
        await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
      }
      await runBtn.waitFor({ state: 'visible', timeout: 30_000 });
    };

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

        // Co-spend tx: owned + two unknown inputs in one old transaction.
        await txCrud.addTransaction({ txid: txc, blockHeight: 600_000, blockTime: old6y, fee: 500, feeRate: 2, syncedAt: Date.now() });
        await txCrud.bulkAddParticipants([
          { txid: txc, role: 'input', address: own, amount: 100_000, prevTxid: fakePrev(n + 1), prevVout: 0 },
          { txid: txc, role: 'input', address: u1, amount: 640_000, prevTxid: fakePrev(n + 2), prevVout: 0 },
          { txid: txc, role: 'input', address: u2, amount: 50_000, prevTxid: fakePrev(n + 3), prevVout: 0 },
          { txid: txc, role: 'output', address: mkAddr('bc1qcospenddest', 0), amount: 780_000, vout: 0 },
        ]);

        // U1's dormant output (7y old — the oldest row, ranked first).
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

    // ── Cancel path: start a scan, cancel it mid-run, expect idle + notice ─
    await page.getByTestId('button-run-scan').click();
    await page.getByTestId('button-cancel-scan').waitFor({ state: 'visible', timeout: 15_000 });
    // Gate the cancel on a streamed scan phase, not on button visibility.
    await page.getByTestId('text-scan-progress').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('button-cancel-scan').click();
    await page.getByTestId('alert-interrupted').waitFor({ state: 'visible', timeout: 15_000 });
    const runBtnText = await page.getByTestId('button-run-scan').textContent();
    record('cancel', runBtnText?.includes('Run scan') ?? false, 'cancel mid-scan returns to idle and shows the interrupted notice');

    // ── Full run ──────────────────────────────────────────────────────────
    const started = Date.now();
    await page.getByTestId('button-run-scan').click();
    await page.getByTestId('text-summary-rows').waitFor({ state: 'visible', timeout: 180_000 });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    const rowsText = await page.getByTestId('text-summary-rows').textContent();
    const totalText = await page.getByTestId('text-summary-total-sats').textContent();
    const ownText = await page.getByTestId('text-summary-own-sats').textContent();
    const groupsText = await page.getByTestId('text-summary-groups').textContent();
    record(
      'summary',
      rowsText === fmt(EXPECTED_ROWS) &&
        totalText === `${fmt(EXPECTED_TOTAL)} sats` &&
        ownText === `${fmt(sumOwn)} sats` &&
        groupsText === '1',
      `rows=${rowsText} total=${totalText} own=${ownText} groups=${groupsText} in ${elapsed}s`,
    );

    // Oldest row (U1, 7y) is ranked first and visible at the top of the list.
    const firstRow = page.getByTestId(`row-dormant-${TXU1.slice(0, 12)}-0`);
    await firstRow.waitFor({ state: 'visible', timeout: 15_000 });
    const clue = await page.getByTestId(`badge-clue-${TXU1.slice(0, 12)}-0`).textContent();
    const ownership = await page.getByTestId(`badge-ownership-${TXU1.slice(0, 12)}-0`).textContent();
    record('first-row', clue === 'Co-spent with your keys' && ownership === 'Unknown', `oldest row clue="${clue}" ownership="${ownership}"`);

    // Co-spend clue group.
    await page.getByTestId('row-group-1').waitFor({ state: 'visible', timeout: 15_000 });
    const groupSats = await page.getByTestId('text-group-sats-1').textContent();
    record('group', groupSats === '500,000 sats', `group #1 dormant total=${groupSats}`);

    // ── Persistence across reload ─────────────────────────────────────────
    await page.reload({ waitUntil: 'load' });
    await reUnlockIfNeeded();
    await page.getByTestId('text-summary-rows').waitFor({ state: 'visible', timeout: 30_000 });
    const rowsAfterReload = await page.getByTestId('text-summary-rows').textContent();
    const interruptedVisible = await page.getByTestId('alert-interrupted').isVisible().catch(() => false);
    record(
      'persist-reload',
      rowsAfterReload === fmt(EXPECTED_ROWS) && !interruptedVisible,
      `rows after reload=${rowsAfterReload}, interrupted notice hidden=${!interruptedVisible}`,
    );

    // ── CSV export: capture the download and verify it exactly ────────────
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByTestId('button-export-csv').click(),
    ]);
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const csv = readFileSync(path, 'utf8');
    const lines = csv.trim().split('\r\n');
    const headerOk =
      lines[0] ===
      'Address,Clue,Ownership,Amount Sats,Created,Block,Age Years,Last Meaningful Activity,Txid,Vout,Record Id,Co-spend Group';
    const coSpentLine = lines.find((l) => l.includes(U1));
    record(
      'export-csv',
      headerOk && lines.length - 1 === EXPECTED_ROWS && !!coSpentLine && coSpentLine.includes('Co-spent with your keys'),
      `download=${download.suggestedFilename()} lines=${lines.length - 1} headerOk=${headerOk} coSpentRow=${!!coSpentLine}`,
    );

    // ── Interrupted-run notice on reload mid-run state ────────────────────
    await page.evaluate(async () => {
      const store = await import('/src/lib/data/dormant-coins-report-store.ts');
      await store.beginDormantRun({ minAgeYears: 3, minAmountSats: 10_000, dustThresholdSats: 1000, ignoreDust: false });
    });
    await page.reload({ waitUntil: 'load' });
    await reUnlockIfNeeded();
    await page.getByTestId('alert-interrupted').waitFor({ state: 'visible', timeout: 30_000 });
    record('interrupted-notice', true, 'reload with running meta shows the interrupted notice');

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
  console.log(`\n[dormant-coins-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length > 0) {
    console.error('[dormant-coins-browser] FAILED steps:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[dormant-coins-browser] fatal:', err);
  process.exit(1);
});
