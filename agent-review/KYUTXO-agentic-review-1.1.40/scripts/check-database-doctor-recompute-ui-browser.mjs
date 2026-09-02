#!/usr/bin/env node
// Real-browser UI guard for the Database Doctor recompute button
// (task: "Make sure the Database Doctor recompute button can't mis-stamp
// non-synced addresses in the browser").
//
// Node/fake-indexeddb tests already prove recomputeAddressStats leaves a
// never-synced address untouched (statsComputedAt stays undefined) and only
// stamps addresses with an addressSyncState entry. What they cannot see is the
// end-to-end wiring: the Database Doctor "Recompute" button → the recompute
// call → the sync status the user actually sees on screen. This script drives
// that whole path in a real Chromium:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds TWO address records:
//      - SYNCED: has an addressSyncState row, one confirmed 50,000-sat output,
//        and deliberately STALE cached stats (cachedBalanceSats=123) so the
//        Doctor's balance check finds it and reveals the Recompute button
//      - NEVER-SYNCED: a bare address record with no sync state, no
//        participants, and no cached stats
//   3. on /database-doctor, clicks "Run balance check" (finds 1 stale row),
//      then clicks the "Recompute" button (full-vault recompute — the exact
//      path that could mis-stamp a non-synced address)
//   4. waits for the automatic post-recompute re-check to report all balances
//      up to date
//   5. asserts in IndexedDB that the never-synced record still has NO
//      statsComputedAt while the synced record now carries the corrected
//      50,000-sat balance
//   6. opens the Records page and asserts the on-screen balance cells: the
//      never-synced address shows "Not synced" and the synced address shows
//      its 0.00050000 balance
//
// NOTE for reviewers: the on-screen sync status lives in
// client/src/components/RecordTable.tsx (cells data-testid="text-balance-<id>",
// rendered by client/src/pages/Records.tsx at /records); the recompute button
// is data-testid="button-recompute-balances" in the BalanceIntegrityCard of
// client/src/pages/DatabaseDoctor.tsx.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-database-doctor-recompute-ui-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dbdoctor-recompute-ui-check-123';

const SYNCED_ADDR = 'bc1qddrecomputeuisyncedaddr000001xcheck';
const NEVER_SYNCED_ADDR = 'bc1qddrecomputeuineversynced0001xcheck';
const TXID = 'ddc0'.padEnd(64, 'a');
const REAL_SATS = 50_000;
const STALE_CACHED_SATS = 123;

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

async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`[dbdoctor-recompute-ui] goto ${url} failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dbdoctor-recompute-ui] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dbdoctor-recompute-ui] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dbdoctor-recompute-ui] starting dev server (npm run dev) ...`);
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
    console.log(`[dbdoctor-recompute-ui] dev server ready at ${BASE_URL}`);
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
      console.log(
        `[dbdoctor-recompute-ui] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[dbdoctor-recompute-ui][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await gotoWithRetry(page, BASE_URL);
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'dbdoctor-recompute-ui',
    });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: one synced-but-stale address, one never-synced address ────────
    const seed = await page.evaluate(
      async ({ syncedAddr, neverSyncedAddr, txid, realSats, staleCachedSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const syncCrud = await import('/src/lib/data/address-sync-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        const [syncedId, neverSyncedId] = await recordCrud.bulkCreateRecords(
          [
            { type: 'address', inputString: syncedAddr, label: 'DD synced (stale cache)' },
            { type: 'address', inputString: neverSyncedAddr, label: 'DD never synced' },
          ],
          { skipVocabularySync: true, skipNotification: true },
        );

        // One confirmed transaction with a single 50,000-sat output owned by
        // the synced address.
        const now = Math.floor(Date.now() / 1000);
        await txCrud.bulkAddTransactions([
          {
            txid,
            blockHeight: 800_000,
            blockTime: now - 3_600,
            fee: 100,
            feeRate: 1,
            syncedAt: Date.now(),
          },
        ]);
        await txCrud.bulkAddParticipants([
          {
            txid,
            role: 'output',
            address: syncedAddr,
            amount: realSats,
            vout: 0,
            recordId: syncedId,
          },
        ]);

        // Mark ONLY the first address as synced.
        await syncCrud.bulkAddAddressSyncState([
          {
            address: syncedAddr,
            recordId: syncedId,
            lastSyncedHeight: 800_100,
            lastSyncedAt: Date.now(),
            txCount: 1,
          },
        ]);

        // Deliberately stale cached stats on the synced address so the
        // Doctor's balance check flags it and reveals the Recompute button.
        await recordCrud.bulkUpdateAddressStats(
          [
            {
              id: syncedId,
              stats: {
                cachedBalanceSats: staleCachedSats,
                cachedTxCount: 1,
                cachedLastActivityTime: now - 3_600,
                cachedUtxoCount: 1,
                statsComputedAt: Date.now(),
              },
            },
          ],
          { skipNotification: true },
        );

        const syncedRec = await db.records.get(syncedId);
        const neverRec = await db.records.get(neverSyncedId);
        return {
          syncedId,
          neverSyncedId,
          syncedCached: syncedRec?.cachedBalanceSats ?? null,
          neverStatsComputedAt: neverRec?.statsComputedAt ?? null,
        };
      },
      {
        syncedAddr: SYNCED_ADDR,
        neverSyncedAddr: NEVER_SYNCED_ADDR,
        txid: TXID,
        realSats: REAL_SATS,
        staleCachedSats: STALE_CACHED_SATS,
      },
    );
    steps.push({
      name: 'seeded a stale-synced address and a never-synced address',
      passed:
        seed.syncedId != null &&
        seed.neverSyncedId != null &&
        seed.syncedCached === STALE_CACHED_SATS &&
        seed.neverStatsComputedAt === null,
      detail: JSON.stringify(seed),
    });

    // ── Database Doctor: run the balance check ──────────────────────────────
    await gotoWithRetry(page, `${BASE_URL}database-doctor`);
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'dbdoctor-recompute-ui',
    });

    await page.getByTestId('button-run-balance-check').click();
    const verdict = page.getByTestId('text-balance-verdict');
    await verdict.waitFor({ state: 'visible', timeout: 60_000 });
    const firstVerdict = ((await verdict.textContent()) ?? '').trim();
    steps.push({
      name: 'balance check flagged the seeded stale address',
      passed: /^1 of 1 /.test(firstVerdict) && firstVerdict.includes('stale cached balance'),
      detail: `verdict="${firstVerdict}"`,
    });

    // ── Click the Recompute button (the real UI control under test) ─────────
    const recomputeBtn = page.getByTestId('button-recompute-balances');
    await recomputeBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await recomputeBtn.click();

    // The card auto re-runs the check after the recompute; wait for the
    // all-clear verdict (the recompute corrected the one stale row).
    await page
      .getByTestId('text-balance-verdict')
      .filter({ hasText: 'up-to-date cached balances' })
      .waitFor({ state: 'visible', timeout: 120_000 });
    const secondVerdict = ((await page.getByTestId('text-balance-verdict').textContent()) ?? '').trim();
    steps.push({
      name: 'recompute button ran and the re-check reports all balances up to date',
      passed: secondVerdict.includes('up-to-date cached balances'),
      detail: `verdict="${secondVerdict}"`,
    });

    // ── DB-level assertions after the UI-driven recompute ───────────────────
    const after = await page.evaluate(
      async ({ syncedId, neverSyncedId }) => {
        const { db } = await import('/src/lib/database.ts');
        const syncedRec = await db.records.get(syncedId);
        const neverRec = await db.records.get(neverSyncedId);
        return {
          synced: {
            statsComputedAt: syncedRec?.statsComputedAt ?? null,
            cachedBalanceSats: syncedRec?.cachedBalanceSats ?? null,
            cachedUtxoCount: syncedRec?.cachedUtxoCount ?? null,
            cachedTxCount: syncedRec?.cachedTxCount ?? null,
          },
          neverSynced: {
            statsComputedAt: neverRec?.statsComputedAt ?? null,
            cachedBalanceSats: neverRec?.cachedBalanceSats ?? null,
          },
        };
      },
      { syncedId: seed.syncedId, neverSyncedId: seed.neverSyncedId },
    );
    steps.push({
      name: 'never-synced record was NOT stamped by the recompute',
      passed: after.neverSynced.statsComputedAt === null && after.neverSynced.cachedBalanceSats === null,
      detail: JSON.stringify(after.neverSynced),
    });
    steps.push({
      name: 'synced record now carries the corrected balance',
      passed:
        after.synced.statsComputedAt != null &&
        after.synced.cachedBalanceSats === REAL_SATS &&
        after.synced.cachedUtxoCount === 1 &&
        after.synced.cachedTxCount === 1,
      detail: JSON.stringify(after.synced),
    });

    // ── Records page: the ON-SCREEN sync status the user actually sees ──────
    // The Balance column is off by default; turn it on (same as the user's
    // column picker would) so the sync-status cells render.
    await page.evaluate(async () => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const settings = await settingsCrud.ensureSettings();
      await settingsCrud.updateSettings('default', {
        tableColumns: { ...settings.tableColumns, balance: true },
      });
    });
    await gotoWithRetry(page, `${BASE_URL}records`);
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'dbdoctor-recompute-ui',
    });

    const neverCell = page.getByTestId(`text-balance-${seed.neverSyncedId}`);
    await neverCell.waitFor({ state: 'visible', timeout: 60_000 });
    const neverText = ((await neverCell.textContent()) ?? '').trim();
    steps.push({
      name: 'Records page still shows "Not synced" for the never-synced address',
      passed: /not synced/i.test(neverText),
      detail: `cell="${neverText}"`,
    });

    const syncedCell = page.getByTestId(`text-balance-${seed.syncedId}`);
    await syncedCell.waitFor({ state: 'visible', timeout: 60_000 });
    const syncedText = ((await syncedCell.textContent()) ?? '').trim();
    steps.push({
      name: 'Records page shows the corrected balance for the synced address',
      passed: syncedText.includes('0.00050000') && !/not synced/i.test(syncedText),
      detail: `cell="${syncedText}"`,
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

  console.log(`[dbdoctor-recompute-ui] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dbdoctor-recompute-ui] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dbdoctor-recompute-ui] PASSED: the Database Doctor Recompute button fixes a stale synced address without stamping a never-synced one, and the Records page keeps showing "Not synced".',
  );
}

main().catch((err) => {
  console.error('[dbdoctor-recompute-ui] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
