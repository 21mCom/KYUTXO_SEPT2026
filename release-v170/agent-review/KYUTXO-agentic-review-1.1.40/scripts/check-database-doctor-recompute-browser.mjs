#!/usr/bin/env node
// Real-browser scale guard for Database Doctor "recompute selected"
// (task: "Confirm a huge Database Doctor 'recompute selected' actually
// finishes fast in a real browser").
//
// Filtered recomputes covering >= FILTERED_SCAN_VAULT_FRACTION (50%) of the
// vault's addresses AND >= FILTERED_SCAN_MIN_REQUESTED (1000) rows reuse the
// streaming whole-vault scan in `recomputeAddressStats` instead of per-batch
// anyOf lookups. Node/fake-indexeddb tests pin correctness and the read path;
// the actual speed win (minutes -> seconds) only shows against REAL browser
// IndexedDB at scale. This script:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. bulk-seeds 20,000 address records, each owning one confirmed output
//      (20k participant rows across 200 shared transactions)
//   3. runs recomputeAddressStats({ recordIds }) over the FIRST 15,000 records
//      (75% of the vault — over both scan gates) and measures wall time
//   4. asserts the recompute:
//      - completes within a bounded time budget (scan path = seconds; the old
//        per-batch anyOf path at this scale runs far past the budget)
//      - reports updated === 15,000
//      - wrote stats for EXACTLY the requested subset (the other 5,000
//        records keep statsComputedAt unset)
//      - computed correct balances (spot-checked sample rows)
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-database-doctor-recompute-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dbdoctor-recompute-check-123';

const TOTAL_ADDRESSES = 20_000;
const REQUESTED = 15_000; // 75% of the vault: over both filtered-scan gates
const TXS = 200; // shared transactions, 100 outputs each
const OUTPUTS_PER_TX = TOTAL_ADDRESSES / TXS;
const BASE_SATS = 10_000;
// The streaming-scan path finishes this in a few seconds on dev hardware; the
// pre-fix per-batch anyOf path at this scale takes minutes. Budget is generous
// for parallel-validation load while still failing a per-batch regression.
const RECOMPUTE_BUDGET_MS = 60_000;

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

async function main() {
  const exe = resolveChromium();
  console.log(`[dbdoctor-recompute-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dbdoctor-recompute-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dbdoctor-recompute-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[dbdoctor-recompute-browser] dev server ready at ${BASE_URL}`);
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
        `[dbdoctor-recompute-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
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
        console.log(`[dbdoctor-recompute-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { label: 'dbdoctor-recompute-browser' });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed 20k addresses + 20k output participants via bulk CRUD helpers ──
    const seedStart = Date.now();
    const seed = await page.evaluate(
      async ({ total, txs, outputsPerTx, baseSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        const addrOf = (i) => `bc1qdbdoctorrecompute${String(i).padStart(6, '0')}xcheck`;
        const txidOf = (t) =>
          `ddc7${String(t).padStart(6, '0')}`.padEnd(64, 'f');

        // Address records, in chunks.
        const ids = [];
        const CHUNK = 2_000;
        for (let i = 0; i < total; i += CHUNK) {
          const rows = [];
          for (let j = i; j < Math.min(i + CHUNK, total); j++) {
            rows.push({
              type: 'address',
              inputString: addrOf(j),
              label: `DD recompute ${j}`,
            });
          }
          const chunkIds = await recordCrud.bulkCreateRecords(rows, {
            skipVocabularySync: true,
            skipNotification: true,
          });
          ids.push(...chunkIds);
        }

        // Shared confirmed transactions + one output participant per address.
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

        return { count: ids.length, firstId: ids[0], lastId: ids[ids.length - 1] };
      },
      { total: TOTAL_ADDRESSES, txs: TXS, outputsPerTx: OUTPUTS_PER_TX, baseSats: BASE_SATS },
    );
    steps.push({
      name: `seeded ${TOTAL_ADDRESSES} address records + ${TOTAL_ADDRESSES} output participants`,
      passed: seed.count === TOTAL_ADDRESSES,
      detail: `count=${seed.count} ids=${seed.firstId}..${seed.lastId} in ${Date.now() - seedStart}ms`,
    });

    // ── Filtered "recompute selected" over 75% of the vault ─────────────────
    const run = await page.evaluate(
      async ({ requested }) => {
        const { db } = await import('/src/lib/database.ts');
        const stats = await import('/src/lib/data/address-stats.ts');

        // The first `requested` address record ids (Database Doctor passes an
        // explicit recordIds selection just like this).
        const recs = await db.records
          .where('type')
          .equals('address')
          .limit(requested)
          .primaryKeys();
        const recordIds = recs.slice(0, requested).map(Number);

        let progressCalls = 0;
        let lastProgress = null;
        const t0 = performance.now();
        const result = await stats.recomputeAddressStats({
          recordIds,
          origin: 'user',
          onProgress: (p) => {
            progressCalls++;
            lastProgress = p;
          },
        });
        const elapsedMs = Math.round(performance.now() - t0);

        // Writes must cover exactly the requested subset: count how many
        // address records now carry a computed-stats timestamp.
        const stamped = await db.records
          .where('type')
          .equals('address')
          .filter((r) => r.statsComputedAt != null)
          .count();

        // Spot-check balances on a few requested rows (amount = baseSats+i by
        // seeding construction; balance must equal the single unspent output).
        const sampleIds = [recordIds[0], recordIds[Math.floor(recordIds.length / 2)], recordIds[recordIds.length - 1]];
        const samples = [];
        for (const id of sampleIds) {
          const r = await db.records.get(id);
          samples.push({
            id,
            cachedBalanceSats: r?.cachedBalanceSats,
            cachedUtxoCount: r?.cachedUtxoCount,
            cachedTxCount: r?.cachedTxCount,
            statsComputedAt: r?.statsComputedAt ?? null,
            inputString: r?.inputString,
          });
        }

        // An unrequested record must remain untouched.
        const allIds = await db.records.where('type').equals('address').primaryKeys();
        const requestedSet = new Set(recordIds);
        const unrequestedId = allIds.map(Number).find((id) => !requestedSet.has(id));
        const untouched = unrequestedId != null ? await db.records.get(unrequestedId) : null;

        return {
          requested: recordIds.length,
          updated: result.updated,
          cancelled: result.cancelled,
          elapsedMs,
          progressCalls,
          lastProgress,
          stamped,
          samples,
          untouchedStatsComputedAt: untouched?.statsComputedAt ?? null,
          untouchedId: unrequestedId ?? null,
        };
      },
      { requested: REQUESTED },
    );

    console.log(`[dbdoctor-recompute-browser] recompute result: ${JSON.stringify({ ...run, samples: undefined })}`);

    steps.push({
      name: `filtered recompute over ${REQUESTED}/${TOTAL_ADDRESSES} finishes within ${RECOMPUTE_BUDGET_MS / 1000}s`,
      passed: !run.cancelled && run.elapsedMs <= RECOMPUTE_BUDGET_MS,
      detail: `elapsed=${run.elapsedMs}ms budget=${RECOMPUTE_BUDGET_MS}ms cancelled=${run.cancelled}`,
    });
    steps.push({
      name: 'recompute updated exactly the requested rows',
      passed: run.updated === REQUESTED && run.requested === REQUESTED,
      detail: `updated=${run.updated} requested=${run.requested}`,
    });
    steps.push({
      name: 'stats were written ONLY for the requested subset',
      passed: run.stamped === REQUESTED && run.untouchedStatsComputedAt === null,
      detail: `stamped=${run.stamped} (expected ${REQUESTED}); unrequested record #${run.untouchedId} statsComputedAt=${run.untouchedStatsComputedAt}`,
    });
    const samplesOk = run.samples.every((s) => {
      const idx = Number(String(s.inputString || '').match(/(\d{6})/)?.[1] ?? NaN);
      return (
        s.statsComputedAt != null &&
        s.cachedUtxoCount === 1 &&
        s.cachedTxCount === 1 &&
        Number.isFinite(idx) &&
        s.cachedBalanceSats === BASE_SATS + idx
      );
    });
    steps.push({
      name: 'spot-checked requested rows carry correct computed balances',
      passed: samplesOk,
      detail: JSON.stringify(run.samples),
    });
    steps.push({
      name: 'progress was reported during the recompute',
      passed: run.progressCalls > 1 && run.lastProgress?.processed === REQUESTED && run.lastProgress?.total === REQUESTED,
      detail: `progressCalls=${run.progressCalls} lastProgress=${JSON.stringify(run.lastProgress)}`,
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

  console.log(`[dbdoctor-recompute-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dbdoctor-recompute-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dbdoctor-recompute-browser] PASSED: a 15k/20k filtered recompute completes fast in a real browser and writes only the requested subset.',
  );
}

main().catch((err) => {
  console.error('[dbdoctor-recompute-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
