#!/usr/bin/env node
// Real-browser regression guard for Nudgie's Electrum-synced spend nudges
// (Task #1716: Sent nudges for blank-address spend inputs).
//
// Electrum-synced spend inputs are stored with a BLANK address (only
// prevTxid/prevVout). The jsdom test (Nudgie.outpointSpendDiscovery.test.ts)
// covers the extracted loaders, but the full component path — useAsyncMemo
// chains, useLiveQuery record loading, and the rendered "Sent" badge with a
// negative net flow — only runs in a real browser.
//
// The script drives a REAL headless Chromium against the running dev server:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds the Electrum blank-address spend fixture via Vite-singleton
//      dynamic imports: one owned (manual) address record, a funding tx paying
//      that address, and a spend tx whose ONLY owned link is a blank-address
//      input (prevTxid/prevVout pointing at the funding output)
//   3. opens the Nudgie page and asserts:
//      - the spend tx card renders (i.e. outpoint discovery attributed the
//        blank input back to the owned address)
//      - the card shows the "Sent" badge with a negative net flow amount
//      - the funding tx card renders too, with the "Received" badge
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-electrum-sent-nudge-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'electrum-sent-nudge-check-123';

const OWNED_ADDR = 'bc1qelectrumsentnudgeownedaddressxxxxxxx';
const COUNTERPARTY_ADDR = 'bc1qelectrumsentnudgecounterpartyxxxxxxx';
const FUND_TXID = 'fund'.padEnd(64, '0');
const SPEND_TXID = 'spend'.padEnd(64, '1');
const FUND_AMOUNT = 50_000;
const SPEND_OUTPUT = 49_000;

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

async function gotoWithRetry(page, url, waitForLoginScreen) {
  // Retry the initial load: under parallel validation the dev server can be
  // slow to compile and single-shot waits flake.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      if (waitForLoginScreen) {
        await waitForLoginScreenVisible(page, { timeoutMs: 30_000 }).catch(() => {});
      }
      return;
    } catch (err) {
      lastErr = err;
      console.log(`[electrum-sent-nudge-browser] goto failed (attempt ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[electrum-sent-nudge-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[electrum-sent-nudge-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[electrum-sent-nudge-browser] starting dev server (npm run dev) ...`);
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
      console.log(`[electrum-sent-nudge-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 2200 },
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[electrum-sent-nudge-browser][page-console] ${msg.text()}`);
      }
    });

    await gotoWithRetry(page, `${BASE_URL}nudgie`, true);
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed via the live Vite module singletons (CRUD helpers) ─────────────
    // Fixture mirrors Nudgie.outpointSpendDiscovery.test.ts: the spend tx's
    // ONLY link to the owned address is a blank-address input carrying
    // prevTxid/prevVout of the funding output.
    const seed = await page.evaluate(
      async ({ ownedAddr, counterpartyAddr, fundTxid, spendTxid, fundAmount, spendOutput }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        const ownedId = await recordCrud.createRecord({
          type: 'address',
          inputString: ownedAddr,
          label: 'Electrum owned addr',
          addressImportance: 'manual',
        });

        const now = Math.floor(Date.now() / 1000);
        await txCrud.bulkAddTransactions([
          { txid: fundTxid, blockHeight: 800_000, blockTime: now - 3_600, fee: 100, feeRate: 1, syncedAt: Date.now() },
          { txid: spendTxid, blockHeight: 800_001, blockTime: now - 600, fee: 1_000, feeRate: 5, syncedAt: Date.now() },
        ]);
        await txCrud.bulkAddParticipants([
          // Funding tx pays the owned address (vout 0), linked to the record.
          { txid: fundTxid, role: 'output', address: ownedAddr, amount: fundAmount, vout: 0, recordId: ownedId },
          // Electrum-style spend input: BLANK address, only the outpoint.
          { txid: spendTxid, role: 'input', address: '', amount: fundAmount, prevTxid: fundTxid, prevVout: 0 },
          // Spend pays an (unowned) counterparty.
          { txid: spendTxid, role: 'output', address: counterpartyAddr, amount: spendOutput, vout: 0 },
        ]);
        return { ownedId };
      },
      {
        ownedAddr: OWNED_ADDR,
        counterpartyAddr: COUNTERPARTY_ADDR,
        fundTxid: FUND_TXID,
        spendTxid: SPEND_TXID,
        fundAmount: FUND_AMOUNT,
        spendOutput: SPEND_OUTPUT,
      },
    );
    steps.push({
      name: 'seeded Electrum blank-address spend fixture',
      passed: Number.isFinite(seed.ownedId),
      detail: JSON.stringify(seed),
    });

    // Reload so the page's useLiveQuery/useAsyncMemo chains see the seeded
    // rows from a clean mount.
    await gotoWithRetry(page, `${BASE_URL}nudgie`, null);
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    // ── The spend tx nudge card renders ──────────────────────────────────────
    const spendCard = page.getByTestId(`card-transaction-${SPEND_TXID}`);
    const spendVisible = await spendCard
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'spend tx nudge card renders (blank-address input attributed to owner)',
      passed: spendVisible,
      detail: `card-transaction-${SPEND_TXID.slice(0, 12)}… visible=${spendVisible}`,
    });

    // ── It carries the Sent badge with a negative net flow ──────────────────
    let spendText = '';
    if (spendVisible) {
      spendText = ((await spendCard.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    }
    // Card text has no whitespace between elements ("SentAug 2, ..."), so
    // plain substring checks, not word-boundary regexes.
    const hasSentBadge = spendText.includes('Sent') && !spendText.includes('Received');
    steps.push({
      name: 'spend card shows the Sent badge (not Received)',
      passed: hasSentBadge,
      detail: `card text: "${spendText.slice(0, 160)}"`,
    });
    // Negative net flow renders without a "+" prefix; formatSats compacts
    // 50,000 sats to "50.0k sats".
    const hasSpendAmount = /50(\.0k|,000)/.test(spendText) && !/\+50(\.0k|,000)/.test(spendText);
    steps.push({
      name: 'spend card shows the 50k sat outflow without a "+" prefix',
      passed: hasSpendAmount,
      detail: `card text: "${spendText.slice(0, 160)}"`,
    });

    // ── The funding tx renders as a Received nudge (sanity baseline) ────────
    const fundCard = page.getByTestId(`card-transaction-${FUND_TXID}`);
    const fundVisible = await fundCard
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const fundText = fundVisible
      ? ((await fundCard.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
      : '';
    steps.push({
      name: 'funding tx card renders with the Received badge and "+" inflow',
      passed: fundVisible && fundText.includes('Received') && /\+50(\.0k|,000)/.test(fundText),
      detail: `visible=${fundVisible} text="${fundText.slice(0, 120)}"`,
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
  console.log(`[electrum-sent-nudge-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[electrum-sent-nudge-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[electrum-sent-nudge-browser] PASSED: Electrum-synced spend renders as a Sent nudge end to end.');
}

main().catch((err) => {
  console.error('[electrum-sent-nudge-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
