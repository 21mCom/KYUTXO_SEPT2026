#!/usr/bin/env node
// Real-browser UI guard for the Database Doctor "Recompute selected" button
// (task: "Confirm 'Recompute selected' in the browser only rebuilds the
// ticked rows").
//
// jsdom tests already prove the BalanceIntegrityCard's selected-recompute
// wiring, and a programmatic scale check covers recomputeAddressStats with
// recordIds. What no test drives is the real end-to-end path in a browser:
// clicking a stale-row checkbox (Radix Checkbox), clicking
// "Recompute selected (1)", and confirming that ONLY the ticked stale row is
// rebuilt — the unticked stale row must keep its old wrong cache and a
// never-synced address must never be stamped.
//
// This script, in a real Chromium:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds THREE address records:
//      - STALE-A and STALE-B: each has an addressSyncState row, one confirmed
//        output (50,000 / 70,000 sats) and a deliberately WRONG cached
//        balance (123 / 456 sats) so the Doctor's balance check flags both
//      - NEVER-SYNCED: a bare record with no sync state and no cached stats
//   3. on /database-doctor, clicks "Run balance check" (finds 2 stale rows)
//   4. ticks ONLY the STALE-A row's checkbox (checkbox-stale-<recordId>) and
//      clicks "Recompute selected (1)" (button-recompute-selected)
//   5. waits for the automatic post-recompute re-check, which must now report
//      exactly 1 remaining stale address (STALE-B was NOT rebuilt)
//   6. asserts in IndexedDB: STALE-A now carries its corrected 50,000-sat
//      balance, STALE-B still has the stale 456-sat cache, and the
//      never-synced record still has NO statsComputedAt
//
// NOTE for reviewers: the controls under test live in the BalanceIntegrityCard
// of client/src/pages/DatabaseDoctor.tsx (route /database-doctor):
// per-row checkboxes are data-testid="checkbox-stale-<recordId>" inside
// StaleAddressList, and the button is data-testid="button-recompute-selected"
// which calls recomputeAddressStats({ recordIds }) and then re-runs the check.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-database-doctor-recompute-selected-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dbdoctor-recompute-selected-check-123';

const STALE_A_ADDR = 'bc1qddselrecomputestalea00000001xcheck';
const STALE_B_ADDR = 'bc1qddselrecomputestaleb00000001xcheck';
const NEVER_SYNCED_ADDR = 'bc1qddselrecomputenever00000001xcheck';
const TXID_A = 'ddc1'.padEnd(64, 'a');
const TXID_B = 'ddc2'.padEnd(64, 'b');
const REAL_SATS_A = 50_000;
const REAL_SATS_B = 70_000;
const STALE_CACHED_SATS_A = 123;
const STALE_CACHED_SATS_B = 456;

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
    .waitFor({ state: 'visible', timeout: 30_000 })
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
  console.log('[dbdoctor-recompute-selected] legacy-migration overlay detected; waiting it out ...');
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

async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(
        `[dbdoctor-recompute-selected] goto ${url} failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dbdoctor-recompute-selected] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dbdoctor-recompute-selected] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dbdoctor-recompute-selected] starting dev server (npm run dev) ...`);
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
    console.log(`[dbdoctor-recompute-selected] dev server ready at ${BASE_URL}`);
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
        `[dbdoctor-recompute-selected] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
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
        console.log(`[dbdoctor-recompute-selected][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await gotoWithRetry(page, BASE_URL);
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: two stale synced addresses + one never-synced address ─────────
    const seed = await page.evaluate(
      async ({
        staleAAddr,
        staleBAddr,
        neverSyncedAddr,
        txidA,
        txidB,
        realSatsA,
        realSatsB,
        staleCachedSatsA,
        staleCachedSatsB,
      }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const syncCrud = await import('/src/lib/data/address-sync-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        const [staleAId, staleBId, neverSyncedId] = await recordCrud.bulkCreateRecords(
          [
            { type: 'address', inputString: staleAAddr, label: 'DD stale A (ticked)' },
            { type: 'address', inputString: staleBAddr, label: 'DD stale B (unticked)' },
            { type: 'address', inputString: neverSyncedAddr, label: 'DD never synced' },
          ],
          { skipVocabularySync: true, skipNotification: true },
        );

        // One confirmed transaction per stale address, each with a single
        // owned output.
        const now = Math.floor(Date.now() / 1000);
        await txCrud.bulkAddTransactions([
          { txid: txidA, blockHeight: 800_000, blockTime: now - 3_600, fee: 100, feeRate: 1, syncedAt: Date.now() },
          { txid: txidB, blockHeight: 800_001, blockTime: now - 3_000, fee: 100, feeRate: 1, syncedAt: Date.now() },
        ]);
        await txCrud.bulkAddParticipants([
          { txid: txidA, role: 'output', address: staleAAddr, amount: realSatsA, vout: 0, recordId: staleAId },
          { txid: txidB, role: 'output', address: staleBAddr, amount: realSatsB, vout: 0, recordId: staleBId },
        ]);

        // Mark ONLY the two stale addresses as synced.
        await syncCrud.bulkAddAddressSyncState([
          { address: staleAAddr, recordId: staleAId, lastSyncedHeight: 800_100, lastSyncedAt: Date.now(), txCount: 1 },
          { address: staleBAddr, recordId: staleBId, lastSyncedHeight: 800_100, lastSyncedAt: Date.now(), txCount: 1 },
        ]);

        // Deliberately wrong cached stats on both synced addresses so the
        // Doctor's balance check flags them and reveals the stale list.
        await recordCrud.bulkUpdateAddressStats(
          [
            {
              id: staleAId,
              stats: {
                cachedBalanceSats: staleCachedSatsA,
                cachedTxCount: 1,
                cachedLastActivityTime: now - 3_600,
                cachedUtxoCount: 1,
                statsComputedAt: Date.now(),
              },
            },
            {
              id: staleBId,
              stats: {
                cachedBalanceSats: staleCachedSatsB,
                cachedTxCount: 1,
                cachedLastActivityTime: now - 3_000,
                cachedUtxoCount: 1,
                statsComputedAt: Date.now(),
              },
            },
          ],
          { skipNotification: true },
        );

        const staleARec = await db.records.get(staleAId);
        const staleBRec = await db.records.get(staleBId);
        const neverRec = await db.records.get(neverSyncedId);
        return {
          staleAId,
          staleBId,
          neverSyncedId,
          staleACached: staleARec?.cachedBalanceSats ?? null,
          staleBCached: staleBRec?.cachedBalanceSats ?? null,
          neverStatsComputedAt: neverRec?.statsComputedAt ?? null,
        };
      },
      {
        staleAAddr: STALE_A_ADDR,
        staleBAddr: STALE_B_ADDR,
        neverSyncedAddr: NEVER_SYNCED_ADDR,
        txidA: TXID_A,
        txidB: TXID_B,
        realSatsA: REAL_SATS_A,
        realSatsB: REAL_SATS_B,
        staleCachedSatsA: STALE_CACHED_SATS_A,
        staleCachedSatsB: STALE_CACHED_SATS_B,
      },
    );
    steps.push({
      name: 'seeded two stale synced addresses and a never-synced address',
      passed:
        seed.staleAId != null &&
        seed.staleBId != null &&
        seed.neverSyncedId != null &&
        seed.staleACached === STALE_CACHED_SATS_A &&
        seed.staleBCached === STALE_CACHED_SATS_B &&
        seed.neverStatsComputedAt === null,
      detail: JSON.stringify(seed),
    });

    // ── Database Doctor: run the balance check ──────────────────────────────
    await gotoWithRetry(page, `${BASE_URL}database-doctor`);
    await unlockIfNeeded(page);

    await page.getByTestId('button-run-balance-check').click();
    const verdict = page.getByTestId('text-balance-verdict');
    await verdict.waitFor({ state: 'visible', timeout: 60_000 });
    const firstVerdict = ((await verdict.textContent()) ?? '').trim();
    steps.push({
      name: 'balance check flagged both seeded stale addresses',
      passed: /^2 of 2 /.test(firstVerdict) && firstVerdict.includes('stale cached balance'),
      detail: `verdict="${firstVerdict}"`,
    });

    // ── Tick ONLY the stale-A row's checkbox ────────────────────────────────
    const checkboxA = page.getByTestId(`checkbox-stale-${seed.staleAId}`);
    await checkboxA.waitFor({ state: 'visible', timeout: 30_000 });
    await checkboxA.click();
    // The unticked row's checkbox must remain unchecked.
    const checkboxB = page.getByTestId(`checkbox-stale-${seed.staleBId}`);
    const aState = await checkboxA.getAttribute('data-state');
    const bState = await checkboxB.getAttribute('data-state');
    steps.push({
      name: 'ticked exactly one stale row (A checked, B unchecked)',
      passed: aState === 'checked' && bState === 'unchecked',
      detail: `A data-state="${aState}", B data-state="${bState}"`,
    });

    // ── Click "Recompute selected (1)" ──────────────────────────────────────
    const recomputeSelectedBtn = page.getByTestId('button-recompute-selected');
    await recomputeSelectedBtn.waitFor({ state: 'visible', timeout: 30_000 });
    const btnLabel = ((await recomputeSelectedBtn.textContent()) ?? '').trim();
    steps.push({
      name: 'button reflects the single selection',
      passed: btnLabel.includes('Recompute selected (1)'),
      detail: `label="${btnLabel}"`,
    });
    await recomputeSelectedBtn.click();

    // The card auto re-runs the check after the recompute; the unticked stale
    // row must still be flagged, so the re-check must report exactly 1 of 2.
    await page
      .getByTestId('text-balance-verdict')
      .filter({ hasText: 'stale cached balance' })
      .waitFor({ state: 'visible', timeout: 120_000 });
    // Wait until the verdict settles on the post-recompute count (the element
    // persists across the re-check, so poll its text).
    const deadline = Date.now() + 120_000;
    let secondVerdict = '';
    while (Date.now() < deadline) {
      secondVerdict = ((await page.getByTestId('text-balance-verdict').textContent().catch(() => '')) ?? '').trim();
      if (/^1 of 2 /.test(secondVerdict)) break;
      await page.waitForTimeout(500);
    }
    steps.push({
      name: 'post-recompute re-check reports exactly 1 remaining stale address',
      passed: /^1 of 2 /.test(secondVerdict) && secondVerdict.includes('stale cached balance'),
      detail: `verdict="${secondVerdict}"`,
    });

    // ── DB-level assertions after the selected recompute ────────────────────
    const after = await page.evaluate(
      async ({ staleAId, staleBId, neverSyncedId }) => {
        const { db } = await import('/src/lib/database.ts');
        const aRec = await db.records.get(staleAId);
        const bRec = await db.records.get(staleBId);
        const neverRec = await db.records.get(neverSyncedId);
        return {
          ticked: {
            statsComputedAt: aRec?.statsComputedAt ?? null,
            cachedBalanceSats: aRec?.cachedBalanceSats ?? null,
            cachedUtxoCount: aRec?.cachedUtxoCount ?? null,
            cachedTxCount: aRec?.cachedTxCount ?? null,
          },
          unticked: {
            cachedBalanceSats: bRec?.cachedBalanceSats ?? null,
          },
          neverSynced: {
            statsComputedAt: neverRec?.statsComputedAt ?? null,
            cachedBalanceSats: neverRec?.cachedBalanceSats ?? null,
          },
        };
      },
      { staleAId: seed.staleAId, staleBId: seed.staleBId, neverSyncedId: seed.neverSyncedId },
    );
    steps.push({
      name: 'ticked row was corrected to the real balance',
      passed:
        after.ticked.statsComputedAt != null &&
        after.ticked.cachedBalanceSats === REAL_SATS_A &&
        after.ticked.cachedUtxoCount === 1 &&
        after.ticked.cachedTxCount === 1,
      detail: JSON.stringify(after.ticked),
    });
    steps.push({
      name: 'unticked stale row still carries its old wrong cache',
      passed: after.unticked.cachedBalanceSats === STALE_CACHED_SATS_B,
      detail: JSON.stringify(after.unticked),
    });
    steps.push({
      name: 'never-synced record was NOT stamped by the selected recompute',
      passed: after.neverSynced.statsComputedAt === null && after.neverSynced.cachedBalanceSats === null,
      detail: JSON.stringify(after.neverSynced),
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

  console.log(`[dbdoctor-recompute-selected] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dbdoctor-recompute-selected] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dbdoctor-recompute-selected] PASSED: "Recompute selected" rebuilt only the ticked stale row; the unticked stale row kept its old cache and the never-synced record was never stamped.',
  );
}

main().catch((err) => {
  console.error('[dbdoctor-recompute-selected] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
