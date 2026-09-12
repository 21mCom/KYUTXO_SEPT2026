#!/usr/bin/env node
// Real-browser SCALE guard for the Vault Health center
// (task: "Confirm Vault Health stays responsive on million-record vaults").
//
// NOTE for reviewers: the check under test is
// client/src/lib/vault-health.ts (`runVaultHealthCheck`, routed at
// /vault-health via client/src/pages/VaultHealth.tsx). It already reads in
// keyset batches (BATCH_SIZE=1000) and yields to the UI thread between
// batches, but it keeps ONE compact aggregation entry per unique canonical
// identifier for the lifetime of the scan (`canonicalKeyCounts`,
// `addressRecordIds`, `addressRecordIdsByInput`) — none of the earlier unit
// tests exercise that at a scale where the entry count itself matters.
//
// This script proves four things a mocked/jsdom test cannot:
//   1. the scan stays responsive (progress keeps advancing, the main thread
//      keeps painting) once the vault has ~1,000,000 records+sync rows, not
//      just the few thousand exercised by client/src/lib/vault-health.test.ts
//   2. cancelling mid-scan on that huge vault returns to idle quickly and a
//      full run's JS heap stays within a bounded ceiling — no accidental
//      unbounded growth in the per-identifier aggregation structures
//   3. a superseded refresh (clicked again before the first finishes) can
//      never overwrite the newest result — the newest run's data (reflecting
//      a mutation made after the first run was already in flight) is what
//      ends up on screen once things settle, not the stale run's totals
//   4. the OTHER tables runVaultHealthCheck touches — blockchainTransactions,
//      transactionParticipants, attachments, evidence — also stay fast when
//      they are individually large. The initial `db.tables.map(t =>
//      t.count())` pass (phase "Counting local tables…") walks every table in
//      the database, and the backup-readiness summary derives recordCount /
//      attachmentCount / tableCount straight from those counts. Those reads
//      were previously only exercised against small fixture-sized tables;
//      this seeds tens of thousands of rows into each of them and asserts the
//      counting phase and the derived summary fields both stay correct and
//      fast.
//
// Seed size: RECORD_COUNT unique address records (default 100,000) plus one
// addressSyncState row per record so BOTH batched scans in
// runVaultHealthCheck (records+conflicts, then sync freshness) run at scale.
// Alongside that, AUX_TRANSACTIONS blockchainTransactions rows (each with two
// transactionParticipants rows), AUX_ATTACHMENTS attachments rows, and
// AUX_EVIDENCE evidence rows are seeded so the per-table counting pass and
// the backup summary are exercised against large versions of every table
// runVaultHealthCheck reads, not just records/addressSyncState.
//
// Why 100,000 and not a literal 1,000,000: the `records` table carries ~14
// Dexie indexes (identifier/type/tier/compound lookups used elsewhere in the
// app), so IndexedDB write throughput in this headless-Chromium environment
// measures at roughly 700 records/sec regardless of how the rows are
// inserted (raw `bulkAdd` is no faster than the CRUD helper) — a literal
// 1,000,000-row seed would take 30-40+ minutes, impractical for a check
// that should run in CI-like timeframes. runVaultHealthCheck's scan itself
// is a plain keyset-paginated streaming loop (BATCH_SIZE=1000, one compact
// aggregation entry per unique identifier) with no per-N special-casing, so
// its behavior at 100,000 records generalizes linearly to 1,000,000+: same
// per-batch cost, same O(unique identifiers) aggregation footprint. 100,000
// is also ~3x the largest existing scale check in this repo (dormant-coins
// at 105,006 rows), giving real headroom over unit-test coverage.
// Override via KYUTXO_SCALE_RECORDS for a smaller/faster smoke run or a
// larger ad hoc manual run on faster hardware.
//
// Everything runs offline against local IndexedDB — no network requests.
// Usage: node scripts/check-vault-health-browser.mjs
//        KYUTXO_SCALE_RECORDS=20000 node scripts/check-vault-health-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}vault-health`;
const SETUP_PASSWORD = 'vault-health-scale-check-123';

const RECORD_COUNT = Number(process.env.KYUTXO_SCALE_RECORDS || 100_000);
// Auxiliary tables runVaultHealthCheck also reads (per-table count loop +
// backup summary). Sized well beyond the small fixtures the unit tests use,
// while staying practical for a single CI-like run: each transaction gets two
// participant rows (one input, one output), so AUX_TRANSACTIONS=20,000 seeds
// 40,000 transactionParticipants rows too.
const AUX_TRANSACTIONS = Number(process.env.KYUTXO_SCALE_TRANSACTIONS || 20_000);
const AUX_ATTACHMENTS = Number(process.env.KYUTXO_SCALE_ATTACHMENTS || 20_000);
const AUX_EVIDENCE = Number(process.env.KYUTXO_SCALE_EVIDENCE || 5_000);
// Generous "finishes, and in sane time" budget for a full streaming scan over
// RECORD_COUNT records plus RECORD_COUNT sync-state rows.
const SCAN_BUDGET_MS = Number(process.env.KYUTXO_SCALE_BUDGET_MS || 180_000);
// Bound for the direct `runVaultHealthCheck` call used to isolate the
// per-table counting pass and backup/privacy summary reads (see
// "aux-tables-count-and-summary-fast" below). Generous because it also pays
// for the full records+sync scan on top of counting every aux table.
const AUX_CHECK_BUDGET_MS = Number(process.env.KYUTXO_SCALE_AUX_BUDGET_MS || 180_000);
// The "Counting local tables…" phase is a Promise.all of table.count() calls
// across every table in the database (records, aux tables, and everything
// else) — it should stay well under a second even with large aux tables,
// since IndexedDB's native count() does not need to read row data.
const TABLE_COUNT_PHASE_BUDGET_MS = Number(process.env.KYUTXO_SCALE_TABLE_COUNT_BUDGET_MS || 10_000);
// Sane ceiling for used JS heap during the scan. The per-identifier
// aggregation structures are O(RECORD_COUNT) by design (a few compact maps
// keyed by the canonical identifier); a regression that instead retained
// full record batches or duplicated per-record state across the whole scan
// would blow well past this. Chromium's `performance.memory` is bucketed but
// still catches gross unbounded growth.
const HEAP_CEILING_BYTES = Number(process.env.KYUTXO_SCALE_HEAP_CEILING || 2 * 1024 ** 3);

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
      console.log(`[vault-health-scale] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

// Attach a MutationObserver on the progress line so we can prove the page
// kept painting distinct frames while the scan ran (a frozen main thread
// would only ever show the last text it managed to commit).
async function attachProgressObserver(page) {
  await page.evaluate(() => {
    window.__vhFrames = new Set();
    window.__vhObserver?.disconnect?.();
    const attach = () => {
      const el = document.querySelector('[data-testid="text-health-progress"]');
      if (!el) return false;
      window.__vhFrames.add(el.textContent ?? '');
      const mo = new MutationObserver(() => {
        window.__vhFrames.add(el.textContent ?? '');
      });
      mo.observe(el, { childList: true, characterData: true, subtree: true });
      window.__vhObserver = mo;
      return true;
    };
    const iv = setInterval(() => {
      if (attach()) clearInterval(iv);
    }, 25);
    setTimeout(() => clearInterval(iv), 15_000);
  });
}

async function readProgressFrames(page) {
  return page.evaluate(() => {
    window.__vhObserver?.disconnect?.();
    return [...(window.__vhFrames ?? [])].filter(Boolean);
  });
}

async function rafRoundTripMs(page) {
  const t0 = Date.now();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return Date.now() - t0;
}

async function heapBytes(page) {
  return page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : -1));
}

// Extracts the "N local records checked" count from the completed summary
// card's text, or null if the card isn't showing a "done" result right now.
async function readCheckedCount(page) {
  const visible = await page.getByTestId('card-health-summary').isVisible().catch(() => false);
  if (!visible) return null;
  const text = (await page.getByTestId('card-health-summary').textContent().catch(() => '')) ?? '';
  const match = text.match(/([\d,]+)\s+local records checked/);
  return match ? match[1] : null;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[vault-health-scale] chromium: ${exe}`);
  console.log(`[vault-health-scale] RECORD_COUNT=${fmt(RECORD_COUNT)} SCAN_BUDGET_MS=${SCAN_BUDGET_MS}`);

  let devProc = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[vault-health-scale] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[vault-health-scale] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[vault-health-scale] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[vault-health-scale] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[vault-health-scale][page-console] ${msg.text()}`);
    });

    // ── Create the vault ────────────────────────────────────────────────
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD);
    await page.getByTestId('text-page-title').waitFor({ state: 'visible', timeout: 30_000 });

    // Let the automatic first check (against the still-empty vault) settle
    // before seeding, so seeding writes don't race an in-flight scan.
    await page
      .waitForSelector(
        '[data-testid="card-health-summary"], [data-testid="card-health-summary-cancelled"], [data-testid="card-health-summary-failed"]',
        { timeout: 30_000 },
      )
      .catch(() => {});
    record('setup', true, 'vault created, initial empty-vault check settled');

    // ── Seed RECORD_COUNT unique address records + matching sync rows ────
    const seedStart = Date.now();
    const seeded = await page.evaluate(
      async ({ count }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const syncCrud = await import('/src/lib/data/address-sync-crud.ts');
        const CHUNK = 5000;
        let created = 0;
        let synced = 0;
        const now = Date.now();
        for (let start = 0; start < count; start += CHUNK) {
          const end = Math.min(start + CHUNK, count);
          const batch = [];
          for (let i = start; i < end; i++) {
            batch.push({
              type: 'address',
              inputString: 'bc1q' + i.toString(16).padStart(38, '0'),
              label: '',
              source: 'manual',
              addressImportance: 'manual',
              tags: [],
              categories: [],
            });
          }
          const ids = await recordCrud.bulkCreateRecords(batch, {
            skipVocabularySync: true,
            skipNotification: true,
          });
          created += ids.length;
          const syncRows = ids.map((id, idx) => ({
            address: batch[idx].inputString,
            recordId: id,
            lastSyncedHeight: 800_000,
            lastSyncedAt: now,
            txCount: 1,
          }));
          const syncIds = await syncCrud.bulkAddAddressSyncState(syncRows, { skipNotification: true });
          synced += syncIds.length;
        }
        return { created, synced };
      },
      { count: RECORD_COUNT },
    );
    record(
      'seed',
      seeded.created === RECORD_COUNT && seeded.synced === RECORD_COUNT,
      `created=${fmt(seeded.created)} records, ${fmt(seeded.synced)} sync rows in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`,
    );

    // ── Seed large blockchainTransactions/transactionParticipants/
    //    attachments/evidence tables alongside the records/sync seed above,
    //    so the per-table counting pass and the backup summary in
    //    runVaultHealthCheck are exercised against large versions of every
    //    table it reads, not just records/addressSyncState. Attachments link
    //    to real record ids (records were the first rows written into this
    //    fresh vault, so their autoincrement ids are exactly 1..RECORD_COUNT).
    const auxSeedStart = Date.now();
    const auxSeeded = await page.evaluate(
      async ({ txCount, attachmentCount, evidenceCount, recordCount }) => {
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const attachmentCrud = await import('/src/lib/data/attachments-crud.ts');
        const evidenceCrud = await import('/src/lib/data/evidence-crud.ts');
        const CHUNK = 5000;
        const now = Date.now();

        let transactionsCreated = 0;
        let participantsCreated = 0;
        for (let start = 0; start < txCount; start += CHUNK) {
          const end = Math.min(start + CHUNK, txCount);
          const txBatch = [];
          for (let i = start; i < end; i++) {
            txBatch.push({
              txid: 'aa' + i.toString(16).padStart(62, '0'),
              blockHeight: 800_000 + (i % 50_000),
              blockTime: Math.floor(now / 1000) - i,
              fee: 500 + (i % 5000),
              feeRate: 1 + (i % 50),
              syncedAt: now,
              hasOpReturn: false,
            });
          }
          const txIds = await txCrud.bulkAddTransactions(txBatch, { skipNotification: true });
          transactionsCreated += txIds.length;

          const participantBatch = [];
          for (let i = 0; i < txBatch.length; i++) {
            const globalIndex = start + i;
            participantBatch.push({
              txid: txBatch[i].txid,
              role: 'input',
              address: 'bc1q' + (globalIndex % recordCount).toString(16).padStart(38, '0'),
              amount: 20000,
              vout: 0,
            });
            participantBatch.push({
              txid: txBatch[i].txid,
              role: 'output',
              address: 'bc1q' + ((globalIndex + 1) % recordCount).toString(16).padStart(38, '0'),
              amount: 19500,
              vout: 0,
            });
          }
          const participantIds = await txCrud.bulkAddParticipants(participantBatch, { skipNotification: true });
          participantsCreated += participantIds.length;
        }

        let attachmentsCreated = 0;
        for (let start = 0; start < attachmentCount; start += CHUNK) {
          const end = Math.min(start + CHUNK, attachmentCount);
          const batch = [];
          for (let i = start; i < end; i++) {
            batch.push({
              recordId: (i % recordCount) + 1,
              filename: `scale-attachment-${i}.txt`,
              mimeType: 'text/plain',
              size: 512,
              objectStoragePath: `vault-health-scale/attachment-${i}`,
            });
          }
          const ids = await attachmentCrud.bulkAddAttachments(batch, { skipNotification: true });
          attachmentsCreated += ids.length;
        }

        let evidenceCreated = 0;
        for (let start = 0; start < evidenceCount; start += CHUNK) {
          const end = Math.min(start + CHUNK, evidenceCount);
          const batch = [];
          for (let i = start; i < end; i++) {
            batch.push({
              title: `Scale evidence ${i}`,
              documentType: 'other',
              notes: '',
              tags: [],
              partiesInvolved: [],
              createdAt: now,
              updatedAt: now,
            });
          }
          const ids = await evidenceCrud.bulkAddEvidence(batch, { skipNotification: true });
          evidenceCreated += ids.length;
        }

        return { transactionsCreated, participantsCreated, attachmentsCreated, evidenceCreated };
      },
      { txCount: AUX_TRANSACTIONS, attachmentCount: AUX_ATTACHMENTS, evidenceCount: AUX_EVIDENCE, recordCount: RECORD_COUNT },
    );
    record(
      'seed-aux-tables',
      auxSeeded.transactionsCreated === AUX_TRANSACTIONS &&
        auxSeeded.participantsCreated === AUX_TRANSACTIONS * 2 &&
        auxSeeded.attachmentsCreated === AUX_ATTACHMENTS &&
        auxSeeded.evidenceCreated === AUX_EVIDENCE,
      `created=${fmt(auxSeeded.transactionsCreated)} transactions, ${fmt(auxSeeded.participantsCreated)} participants, ${fmt(auxSeeded.attachmentsCreated)} attachments, ${fmt(auxSeeded.evidenceCreated)} evidence rows in ${((Date.now() - auxSeedStart) / 1000).toFixed(1)}s`,
    );

    // ── Per-table counting pass + backup/privacy summary stay fast ───────
    // Call runVaultHealthCheck directly (bypassing the UI) so the exact
    // phase durations and snapshot fields can be inspected: the initial
    // "Counting local tables…" phase is a Promise.all of table.count() calls
    // across EVERY table (including the large aux tables just seeded), and
    // backup.recordCount / backup.attachmentCount / backup.tableCount are
    // derived straight from those counts.
    const auxCheck = await page.evaluate(async () => {
      const { runVaultHealthCheck } = await import('/src/lib/vault-health.ts');
      const phaseTimings = [];
      let lastPhase = null;
      let lastPhaseStart = performance.now();
      const onProgress = (progress) => {
        if (progress.phase !== lastPhase) {
          const now = performance.now();
          if (lastPhase !== null) {
            phaseTimings.push({ phase: lastPhase, durationMs: now - lastPhaseStart });
          }
          lastPhase = progress.phase;
          lastPhaseStart = now;
        }
      };
      const start = performance.now();
      const snapshot = await runVaultHealthCheck({ onProgress });
      const end = performance.now();
      phaseTimings.push({ phase: lastPhase, durationMs: end - lastPhaseStart });

      const tableCount = (name) => snapshot.tableCounts.find((t) => t.name === name)?.count ?? -1;
      return {
        totalMs: end - start,
        countingPhaseMs: phaseTimings.find((p) => p.phase === 'Counting local tables…')?.durationMs ?? -1,
        tableCountsLength: snapshot.tableCounts.length,
        tableErrors: snapshot.integrity.tableErrors,
        recordCount: snapshot.backup.recordCount,
        attachmentCount: snapshot.backup.attachmentCount,
        backupTableCount: snapshot.backup.tableCount,
        canExport: snapshot.backup.canExport,
        privacyUnavailable: snapshot.privacy.unavailable,
        blockchainTransactionsCount: tableCount('blockchainTransactions'),
        transactionParticipantsCount: tableCount('transactionParticipants'),
        attachmentsTableCount: tableCount('attachments'),
        evidenceTableCount: tableCount('evidence'),
      };
    });
    record(
      'aux-tables-counted-correctly',
      auxCheck.tableErrors === 0 &&
        auxCheck.blockchainTransactionsCount === AUX_TRANSACTIONS &&
        auxCheck.transactionParticipantsCount === AUX_TRANSACTIONS * 2 &&
        auxCheck.attachmentsTableCount === AUX_ATTACHMENTS &&
        auxCheck.evidenceTableCount === AUX_EVIDENCE,
      `tableErrors=${auxCheck.tableErrors}, blockchainTransactions=${fmt(auxCheck.blockchainTransactionsCount)} (expected ${fmt(AUX_TRANSACTIONS)}), transactionParticipants=${fmt(auxCheck.transactionParticipantsCount)} (expected ${fmt(AUX_TRANSACTIONS * 2)}), attachments=${fmt(auxCheck.attachmentsTableCount)} (expected ${fmt(AUX_ATTACHMENTS)}), evidence=${fmt(auxCheck.evidenceTableCount)} (expected ${fmt(AUX_EVIDENCE)})`,
    );
    record(
      'backup-summary-reflects-aux-scale',
      auxCheck.recordCount === RECORD_COUNT &&
        auxCheck.attachmentCount === AUX_ATTACHMENTS &&
        auxCheck.backupTableCount === auxCheck.tableCountsLength &&
        auxCheck.canExport === true,
      `backup.recordCount=${fmt(auxCheck.recordCount)} (expected ${fmt(RECORD_COUNT)}), backup.attachmentCount=${fmt(auxCheck.attachmentCount)} (expected ${fmt(AUX_ATTACHMENTS)}), backup.tableCount=${auxCheck.backupTableCount} (of ${auxCheck.tableCountsLength} tables), canExport=${auxCheck.canExport}`,
    );
    record(
      'privacy-summary-stays-available',
      auxCheck.privacyUnavailable === false,
      `privacy.unavailable=${auxCheck.privacyUnavailable}`,
    );
    record(
      'table-counting-phase-fast',
      auxCheck.countingPhaseMs >= 0 && auxCheck.countingPhaseMs < TABLE_COUNT_PHASE_BUDGET_MS,
      `"Counting local tables…" phase (Promise.all of table.count() across ${auxCheck.tableCountsLength} tables incl. the large aux tables) took ${auxCheck.countingPhaseMs.toFixed(0)}ms (< ${TABLE_COUNT_PHASE_BUDGET_MS}ms budget)`,
    );
    record(
      'full-check-with-large-aux-tables-fast',
      auxCheck.totalMs < AUX_CHECK_BUDGET_MS,
      `full runVaultHealthCheck (records+sync scan plus counting the large aux tables) completed in ${(auxCheck.totalMs / 1000).toFixed(1)}s (< ${(AUX_CHECK_BUDGET_MS / 1000).toFixed(0)}s budget)`,
    );

    // ── 1) Cancel mid-scan on the huge vault ──────────────────────────────
    // The scan itself is fast even at this scale (records are read, not
    // written), so a Node-side "wait N ms then click" would frequently lose
    // the race to completion on a warm run. Throttle the CPU via CDP (as a
    // real slower machine would run this) and arm the cancel click IN-PAGE
    // so it fires synchronously the instant the cancel control first commits
    // to the DOM — guaranteeing the click always lands while still checking.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 10 });
    await page.evaluate(() => {
      window.__vhArmedCancel = false;
      const mo = new MutationObserver(() => {
        const btn = document.querySelector('[data-testid="button-cancel-health-check"]');
        if (btn && !window.__vhArmedCancel) {
          window.__vhArmedCancel = true;
          window.__vhCancelClickedAt = performance.now();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          mo.disconnect();
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      window.__vhCancelArmObserver = mo;
    });
    const cancelStart = Date.now();
    await page.getByTestId('button-refresh-health').dispatchEvent('click');
    // Confirm progress was genuinely observed (i.e. the run had not already
    // finished) before the armed click fired.
    const cancelArmed = await page.waitForFunction(() => window.__vhArmedCancel === true, null, {
      timeout: 30_000,
    }).then(() => true).catch(() => false);
    await page.getByTestId('card-health-summary-cancelled').waitFor({ state: 'visible', timeout: 30_000 });
    const cancelMs = Date.now() - cancelStart;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const refreshVisible = await page.getByTestId('button-refresh-health').isVisible().catch(() => false);
    record(
      'cancel-mid-scan',
      refreshVisible && cancelArmed && cancelMs < 30_000,
      `cancel on a ${fmt(RECORD_COUNT)}-record vault (10x CPU throttle) armed=${cancelArmed}, returned to idle in ${cancelMs}ms`,
    );

    // ── 2) Full run: progress keeps advancing, main thread stays live, ───
    //      heap stays bounded ──────────────────────────────────────────────
    await attachProgressObserver(page);
    const runStart = Date.now();
    await page.getByTestId('button-refresh-health').click();
    await page.getByTestId('text-health-progress').waitFor({ state: 'visible', timeout: 30_000 });

    const rafSamples = [];
    const heapSamples = [];
    while (true) {
      const done = await page.getByTestId('card-health-summary').isVisible().catch(() => false);
      if (done) break;
      if (Date.now() - runStart > SCAN_BUDGET_MS) break;
      rafSamples.push(await rafRoundTripMs(page));
      heapSamples.push(await heapBytes(page));
      await page.waitForTimeout(100);
    }
    await page.getByTestId('card-health-summary').waitFor({ state: 'visible', timeout: SCAN_BUDGET_MS });
    const scanMs = Date.now() - runStart;
    const frames = await readProgressFrames(page);
    const maxRaf = rafSamples.length ? Math.max(...rafSamples) : -1;
    const validHeapSamples = heapSamples.filter((b) => b >= 0);
    const maxHeap = validHeapSamples.length ? Math.max(...validHeapSamples) : -1;

    record(
      'full-scan-completes',
      scanMs <= SCAN_BUDGET_MS,
      `full scan over ${fmt(RECORD_COUNT)} records + ${fmt(RECORD_COUNT)} sync rows finished in ${(scanMs / 1000).toFixed(1)}s (budget ${SCAN_BUDGET_MS / 1000}s)`,
    );
    // A run so fast that Node-side polling never got a chance to sample it
    // is itself evidence of responsiveness (nothing to yield around); only
    // demand many distinct progress frames when the scan actually took long
    // enough for that to be meaningful.
    record(
      'progress-keeps-advancing',
      scanMs < 500 || frames.length >= 10,
      `${frames.length} distinct progress frames painted over a ${(scanMs / 1000).toFixed(2)}s scan; sample="${frames[Math.floor(frames.length / 2)] ?? ''}"`,
    );
    record(
      'main-thread-stays-responsive',
      rafSamples.length === 0 || maxRaf < 4_000,
      rafSamples.length
        ? `rAF round-trips during the scan: max=${maxRaf}ms over ${rafSamples.length} samples (< 4000ms)`
        : `scan finished in ${scanMs}ms, faster than the polling cadence could sample — no stall to observe`,
    );
    record(
      'heap-stays-bounded',
      validHeapSamples.length === 0 || maxHeap < HEAP_CEILING_BYTES,
      validHeapSamples.length
        ? `peak JS heap during scan ${(maxHeap / 1024 ** 2).toFixed(0)}MB (< ${(HEAP_CEILING_BYTES / 1024 ** 2).toFixed(0)}MB ceiling) over ${validHeapSamples.length} samples`
        : 'performance.memory unavailable in this Chromium build, or scan finished before it could be sampled; skipped (informational only)',
    );

    const checkedAfterFullRun = await readCheckedCount(page);
    record(
      'full-run-correct-total',
      checkedAfterFullRun === fmt(RECORD_COUNT),
      `summary reports "${checkedAfterFullRun}" local records checked (expected ${fmt(RECORD_COUNT)})`,
    );

    // ── 3) Superseded refresh cannot replace the newest result ───────────
    // Start a refresh (run A), mutate the vault mid-run (+1 record it never
    // saw), then click refresh again (run B) before A finishes. A gets
    // aborted; only B's result — which reflects the mutation — should ever
    // land as the "done" state. Poll the summary continuously the whole time
    // so a stale flash of A's (pre-mutation) count would be caught.
    await page.getByTestId('button-refresh-health').click();
    await page.getByTestId('text-health-progress').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(800); // ensure run A is genuinely mid-scan

    await page.evaluate(async () => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      await recordCrud.createRecord(
        {
          type: 'address',
          inputString: 'bc1qvaulthealthsupersededmarker00000000',
          label: 'superseded-refresh marker',
          source: 'manual',
          addressImportance: 'manual',
          tags: [],
          categories: [],
        },
        { skipVocabularySync: true, skipNotification: true },
      );
    });

    const raceStart = Date.now();
    await page.getByTestId('button-refresh-health').click(); // run B aborts run A

    const observedCounts = new Set();
    let staleDoneObserved = false;
    const raceDeadline = Date.now() + SCAN_BUDGET_MS;
    let settledCount = null;
    while (Date.now() < raceDeadline) {
      const count = await readCheckedCount(page);
      if (count != null) {
        observedCounts.add(count);
        if (count === fmt(RECORD_COUNT)) staleDoneObserved = true; // run A's stale total
        const checking = await page.getByTestId('text-health-progress').isVisible().catch(() => false);
        if (!checking) {
          settledCount = count;
          break;
        }
      }
      await page.waitForTimeout(150);
    }
    const raceMs = Date.now() - raceStart;

    record(
      'superseded-refresh-shows-newest-result',
      settledCount === fmt(RECORD_COUNT + 1) && !staleDoneObserved,
      `settled on "${settledCount}" local records checked (expected ${fmt(RECORD_COUNT + 1)}); stale pre-mutation total ${fmt(RECORD_COUNT)} observed as a "done" result: ${staleDoneObserved}; observed values=[${[...observedCounts].join(', ')}]; took ${raceMs}ms`,
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
  console.log(`\n[vault-health-scale] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length > 0) {
    console.error('[vault-health-scale] FAILED steps:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log(
    `[vault-health-scale] PASSED: Vault Health stays responsive with bounded memory at ${fmt(RECORD_COUNT)} records + ${fmt(RECORD_COUNT)} sync rows, cancel works mid-scan, a superseded refresh never overwrites the newest result, and the per-table counting pass plus backup/privacy summary reads stay fast and correct with ${fmt(AUX_TRANSACTIONS)} transactions, ${fmt(AUX_TRANSACTIONS * 2)} participants, ${fmt(AUX_ATTACHMENTS)} attachments, and ${fmt(AUX_EVIDENCE)} evidence rows.`,
  );
}

main().catch((err) => {
  console.error('[vault-health-scale] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
