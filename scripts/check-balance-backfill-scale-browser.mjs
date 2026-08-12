#!/usr/bin/env node
// Real-browser AT-SCALE speed guard for the Balance page's one-time
// address-stats backfill (task: "Confirm the Balance page's one-time backfill
// stays fast in a real browser at huge scale").
//
// The full-vault recompute in `recomputeAddressStats` now precomputes every
// address's stats with a set-oriented streaming scan
// (`computeStatsForAllAddressesByScan`: one pass over transactionParticipants
// + one over blockchainTransactions) instead of per-batch `anyOf(addresses)`
// lookups (`computeStatsForAddresses` per 100-address batch). That cut the
// 30k-address backfill from ~47s to ~14s in a real browser — but nothing
// automated pinned the speedup: the legacy-upgrade scale gate only requires
// ADVANCING progress, so a regression back to the per-batch path would still
// pass while first-paint of totals quietly returns to minutes.
//
// NOTE for reviewers: the "/balance" route renders
// client/src/pages/BalanceOverview.tsx; its first-visit formula-upgrade
// backfill (balanceFormulaVersion unset -> < 2) calls
// `recomputeAddressStats({ batchSize: 100, ... })` with no id/address filter,
// which is exactly the full-vault fast path measured here.
//
// This script:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. bulk-seeds 20,000 address records, each owning one confirmed output
//      (20k participant rows across 200 shared transactions)
//   3. installs an IDBIndex read counter on the `transactionParticipants`
//      table's `address` index — the per-batch fallback path
//      (`computeStatsForAddresses`) reads that index at least once per
//      100-address batch (>= 200 reads at this scale), while the streaming
//      scan never touches it (it pages the primary key). A positive-control
//      probe (running `computeStatsForAddresses` directly on 3 sample
//      batches) proves the counter fires before it is trusted.
//   4. times the real full-vault `recomputeAddressStats({})` and asserts it
//      BOTH finishes inside an absolute budget AND performed (near-)zero
//      address-index reads — a regression that drops the precomputed-stats
//      wiring in recomputeAddressStats immediately shows >= 200 reads
//   5. drives the actual /balance page UI: the one-time backfill progress
//      appears, completes, and the totals card renders within a bounded budget
//      with a non-zero total
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-balance-backfill-scale-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'balance-backfill-scale-123';

const TOTAL_ADDRESSES = Number(process.env.KYUTXO_SCALE_ADDRESSES || 20_000);
const TXS = 200; // shared transactions, TOTAL/TXS outputs each
const OUTPUTS_PER_TX = TOTAL_ADDRESSES / TXS;
const BASE_SATS = 10_000;
// Batch shape of the Balance page's backfill call (batchSize: 100).
const SAMPLE_BATCHES = 3;
const SAMPLE_BATCH_SIZE = 100;

// The streaming-scan path finishes the 20k full recompute in a few seconds on
// dev hardware (~14s at 30k on the original report). The old per-batch path at
// this scale runs well past a minute. Budget is generous for parallel
// validation load while still failing a per-batch regression outright.
const FULL_RECOMPUTE_BUDGET_MS = 60_000;
// Fast-path gate: the streaming scan performs ZERO reads on the participants
// `address` index; the per-batch fallback performs >= TOTAL/100 (200 here).
// Allow a small slack for unrelated background queries on the app page.
const ADDR_INDEX_READS_MAX = 20;
// UI journey: backfill progress appears, then totals render.
const UI_READY_BUDGET_MS = 180_000;

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
    .waitFor({ state: 'visible', timeout: 15_000 })
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
  console.log('[balance-backfill-scale] legacy-migration overlay detected; waiting it out ...');
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
  console.log(`[balance-backfill-scale] chromium: ${exe}`);
  console.log(`[balance-backfill-scale] scale: ${TOTAL_ADDRESSES} addresses / ${TXS} txs`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[balance-backfill-scale] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[balance-backfill-scale] starting dev server (npm run dev) ...`);
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
    console.log(`[balance-backfill-scale] dev server ready at ${BASE_URL}`);
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
        `[balance-backfill-scale] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
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
        console.log(`[balance-backfill-scale][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed 20k addresses + 20k output participants via bulk CRUD helpers ──
    const seedStart = Date.now();
    const seed = await page.evaluate(
      async ({ total, txs, outputsPerTx, baseSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        const addrOf = (i) => `bc1qbalancebackfill${String(i).padStart(6, '0')}xcheck`;
        const txidOf = (t) => `bbf7${String(t).padStart(6, '0')}`.padEnd(64, 'e');

        const ids = [];
        const CHUNK = 2_000;
        for (let i = 0; i < total; i += CHUNK) {
          const rows = [];
          for (let j = i; j < Math.min(i + CHUNK, total); j++) {
            rows.push({
              type: 'address',
              inputString: addrOf(j),
              label: `Balance backfill ${j}`,
            });
          }
          const chunkIds = await recordCrud.bulkCreateRecords(rows, {
            skipVocabularySync: true,
            skipNotification: true,
          });
          ids.push(...chunkIds);
        }

        const now = Math.floor(Date.now() / 1000);
        const txRows = [];
        for (let t = 0; t < txs; t++) {
          txRows.push({
            txid: txidOf(t),
            blockHeight: 800_000 + t,
            blockTime: now - (txs - t) * 600,
            fee: 100,
            feeRate: 1,
            syncedAt: Date.now(),
          });
        }
        await txCrud.bulkAddTransactions(txRows);

        const partRows = [];
        for (let i = 0; i < total; i++) {
          partRows.push({
            txid: txidOf(Math.floor(i / outputsPerTx)),
            role: 'output',
            address: addrOf(i),
            amount: baseSats + i,
            vout: i % outputsPerTx,
            recordId: ids[i],
          });
        }
        for (let i = 0; i < partRows.length; i += 5_000) {
          await txCrud.bulkAddParticipants(partRows.slice(i, i + 5_000));
        }

        return { count: ids.length };
      },
      { total: TOTAL_ADDRESSES, txs: TXS, outputsPerTx: OUTPUTS_PER_TX, baseSats: BASE_SATS },
    );
    steps.push({
      name: `seeded ${TOTAL_ADDRESSES} address records + ${TOTAL_ADDRESSES} output participants`,
      passed: seed.count === TOTAL_ADDRESSES,
      detail: `count=${seed.count} in ${Date.now() - seedStart}ms`,
    });

    // ── Baseline: old per-batch pace, then the timed full-vault recompute ───
    const run = await page.evaluate(
      async ({ total, sampleBatches, sampleBatchSize }) => {
        const { db } = await import('/src/lib/database.ts');
        const stats = await import('/src/lib/data/address-stats.ts');

        // Count reads on the transactionParticipants `address` index. The
        // per-batch fallback (`computeStatsForAddresses`'s
        // where('address').anyOf(...)) hits this index once per batch; the
        // streaming scan pages the primary key and never touches it.
        const counters = { addrIndexReads: 0 };
        const proto = IDBIndex.prototype;
        for (const m of ['openCursor', 'openKeyCursor', 'getAll', 'getAllKeys', 'count']) {
          const orig = proto[m];
          proto[m] = function (...args) {
            try {
              if (this.objectStore?.name === 'transactionParticipants' && this.name === 'address') {
                counters.addrIndexReads++;
              }
            } catch {}
            return orig.apply(this, args);
          };
        }

        // Positive control: run the per-batch computation directly on sample
        // batches (the exact query shape the fallback would issue) and prove
        // the counter fires — otherwise a broken probe would greenlight
        // anything.
        const sampleAddrs = (
          await db.records
            .where('type')
            .equals('address')
            .limit(sampleBatches * sampleBatchSize)
            .toArray()
        ).map((r) => r.inputString);
        let sampleStatsCount = 0;
        for (let b = 0; b < sampleBatches; b++) {
          const slice = sampleAddrs.slice(b * sampleBatchSize, (b + 1) * sampleBatchSize);
          const m = await stats.computeStatsForAddresses(slice);
          sampleStatsCount += m.size;
        }
        const sampledAddresses = sampleAddrs.length;
        const probeAddrIndexReads = counters.addrIndexReads;
        counters.addrIndexReads = 0;

        // The real full-vault backfill call (same shape as BalanceOverview's
        // formula-upgrade backfill: no id/address filter, batchSize 100).
        let progressCalls = 0;
        let lastProgress = null;
        const t0 = performance.now();
        const result = await stats.recomputeAddressStats({
          origin: 'user',
          skipNotification: true,
          batchSize: 100,
          onProgress: (p) => {
            progressCalls++;
            lastProgress = p;
          },
        });
        const elapsedMs = Math.round(performance.now() - t0);
        const fullRunAddrIndexReads = counters.addrIndexReads;

        // Sanity: stats really landed (spot-check first/middle/last records).
        const allIds = await db.records.where('type').equals('address').primaryKeys();
        const pick = [allIds[0], allIds[Math.floor(allIds.length / 2)], allIds[allIds.length - 1]];
        const samples = [];
        for (const id of pick) {
          const r = await db.records.get(id);
          samples.push({
            id,
            cachedBalanceSats: r?.cachedBalanceSats,
            cachedUtxoCount: r?.cachedUtxoCount,
            statsComputedAt: r?.statsComputedAt ?? null,
            inputString: r?.inputString,
          });
        }

        // Reset the timestamp-free state the UI phase needs? No — leave the
        // stats in place; the UI backfill still runs (balanceFormulaVersion is
        // unset) and simply rewrites them via the same fast path.
        return {
          sampledAddresses,
          sampleStatsCount,
          probeAddrIndexReads,
          fullRunAddrIndexReads,
          elapsedMs,
          updated: result.updated,
          cancelled: result.cancelled,
          progressCalls,
          lastProgress,
          samples,
        };
      },
      { total: TOTAL_ADDRESSES, sampleBatches: SAMPLE_BATCHES, sampleBatchSize: SAMPLE_BATCH_SIZE },
    );

    console.log(
      `[balance-backfill-scale] probe: ${run.probeAddrIndexReads} address-index reads over ${run.sampledAddresses} sampled addrs; ` +
        `full-vault recompute: ${run.elapsedMs}ms, ${run.fullRunAddrIndexReads} address-index reads (updated=${run.updated}, progressCalls=${run.progressCalls})`,
    );

    steps.push({
      name: 'positive control: per-batch path fires the address-index read counter',
      passed:
        run.sampleStatsCount === run.sampledAddresses &&
        run.sampledAddresses === SAMPLE_BATCHES * SAMPLE_BATCH_SIZE &&
        run.probeAddrIndexReads >= SAMPLE_BATCHES,
      detail: `sampled=${run.sampledAddresses} statsReturned=${run.sampleStatsCount} probeReads=${run.probeAddrIndexReads} (expected >= ${SAMPLE_BATCHES})`,
    });
    steps.push({
      name: `full-vault backfill recompute (${TOTAL_ADDRESSES} addresses) finishes within ${FULL_RECOMPUTE_BUDGET_MS / 1000}s`,
      passed: !run.cancelled && run.updated === TOTAL_ADDRESSES && run.elapsedMs <= FULL_RECOMPUTE_BUDGET_MS,
      detail: `elapsed=${run.elapsedMs}ms budget=${FULL_RECOMPUTE_BUDGET_MS}ms updated=${run.updated} cancelled=${run.cancelled}`,
    });

    steps.push({
      name: `fast path taken: full recompute performed (near-)zero address-index reads (< ${ADDR_INDEX_READS_MAX}; per-batch fallback would need >= ${TOTAL_ADDRESSES / 100})`,
      passed: run.fullRunAddrIndexReads < ADDR_INDEX_READS_MAX,
      detail: `fullRunAddrIndexReads=${run.fullRunAddrIndexReads} (allowance ${ADDR_INDEX_READS_MAX}; regression signature >= ${TOTAL_ADDRESSES / 100})`,
    });
    steps.push({
      name: 'progress ticked throughout and stats landed on spot-checked rows',
      passed:
        run.progressCalls > 2 &&
        run.lastProgress?.processed === TOTAL_ADDRESSES &&
        run.samples.every((s) => {
          const idx = Number(String(s.inputString || '').match(/(\d{6})/)?.[1] ?? NaN);
          return s.statsComputedAt != null && s.cachedUtxoCount === 1 && Number.isFinite(idx) && s.cachedBalanceSats === BASE_SATS + idx;
        }),
      detail: `progressCalls=${run.progressCalls} lastProgress=${JSON.stringify(run.lastProgress)} samples=${JSON.stringify(run.samples)}`,
    });

    // ── UI phase: /balance first visit runs the one-time backfill live ──────
    // balanceFormulaVersion is still unset, so BalanceOverview enters the
    // "backfilling" phase (progress-backfill + text-backfill-progress) before
    // aggregating and rendering card-total-balance.
    const uiStart = Date.now();
    await page.goto(`${BASE_URL}balance`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const backfillSeen = await page
      .waitForSelector('[data-testid="text-backfill-progress"]', { state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'Balance page entered the one-time backfill phase with visible progress',
      passed: backfillSeen,
      detail: backfillSeen
        ? `backfill progress visible ${Date.now() - uiStart}ms after navigation`
        : 'text-backfill-progress never appeared (backfill phase skipped or UI regressed)',
    });

    const totalsCard = page.getByTestId('card-total-balance');
    const uiReady = await totalsCard
      .waitFor({ state: 'visible', timeout: UI_READY_BUDGET_MS })
      .then(() => true)
      .catch(() => false);
    const uiMs = Date.now() - uiStart;
    steps.push({
      name: `Balance totals rendered within ${UI_READY_BUDGET_MS / 1000}s of first visit (backfill + aggregation)`,
      passed: uiReady && uiMs <= UI_READY_BUDGET_MS,
      detail: uiReady ? `card-total-balance visible after ${uiMs}ms` : `totals card never appeared (waited ${uiMs}ms)`,
    });

    if (uiReady) {
      const totalText = ((await totalsCard.textContent()) ?? '').trim();
      // Sum of baseSats+i over 20k outputs is well above zero; any non-zero
      // BTC figure proves the aggregation saw the backfilled stats.
      const nonZero = /[1-9]/.test(totalText.replace(/[^0-9.]/g, ''));
      steps.push({
        name: 'rendered total is non-zero (aggregation consumed the backfilled stats)',
        passed: nonZero,
        detail: `card text: "${totalText.slice(0, 120)}"`,
      });
    }
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

  console.log(`[balance-backfill-scale] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[balance-backfill-scale] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[balance-backfill-scale] PASSED: the one-time Balance backfill takes the streaming fast path at 20k addresses and the page renders totals within budget.',
  );
}

main().catch((err) => {
  console.error('[balance-backfill-scale] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
