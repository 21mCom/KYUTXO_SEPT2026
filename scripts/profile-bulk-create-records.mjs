#!/usr/bin/env node
// One-off profiling harness for Task #2122 ("Find and fix the real bottleneck
// slowing down large wallet imports and restores"). NOT wired into the
// validation pipeline — this is a throwaway diagnostic script, run manually.
//
// Measures, in a REAL headless Chromium against real IndexedDB:
//   1. bulkCreateRecords() throughput (the path backup restore uses).
//   2. The serial createRecord()+createRecordOrigin() throughput that the
//      wallet-import loop (import-manager.ts executeImport / BulkImport.tsx)
//      actually uses today.
//   3. The same workload run through a batched helper (bulkCreateRecords +
//      bulkAddRecordOrigins) to quantify the achievable speedup.
//
// Usage: node scripts/profile-bulk-create-records.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'profile-bulk-create-123';

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return execSync('which chromium', { encoding: 'utf8' }).trim();
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
  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[profile] reusing dev server at ${BASE_URL}`);
  } else {
    devProc = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) throw new Error('dev server did not start');
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[page-console] ${msg.text()}`);
    });

    await page.goto(`${BASE_URL}`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    const results = await page.evaluate(async () => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const originsCrud = await import('/src/lib/data/record-origins-crud.ts');
      const { db } = await import('/src/lib/database.ts');

      function makeRecords(n, prefix) {
        const out = [];
        for (let i = 0; i < n; i++) {
          out.push({
            type: 'address',
            inputString: `bc1q${prefix}${String(i).padStart(10, '0')}profilerow`,
            label: `Row ${i}`,
            tags: [],
            categories: [],
            source: `walletImport-ProfileWallet_2026-08-27_000000`,
            walletName: 'ProfileWallet',
            owner: 'ProfileOwner',
          });
        }
        return out;
      }

      async function clearAll() {
        await db.records.clear();
        await db.recordOrigins.clear();
      }

      // ---- 1) bulkCreateRecords in isolation (records only) ----
      await clearAll();
      const N1 = 20000;
      const recs1 = makeRecords(N1, 'bulk');
      const t1a = performance.now();
      await recordCrud.bulkCreateRecords(recs1, { skipNotification: true, skipVocabularySync: true });
      const t1b = performance.now();
      const bulkCreateRecordsMs = t1b - t1a;

      // ---- 2) raw Dexie bulkAdd baseline (no wrapper JS at all) ----
      await clearAll();
      const now = Date.now();
      const rawRows = recs1.map((r, i) => ({
        ...r,
        inputStringLower: r.inputString.toLowerCase(),
        addressImportance: 'wallet-import',
        createdAt: now,
        updatedAt: now,
      }));
      const t2a = performance.now();
      await db.transaction('rw', db.records, async () => {
        await db.records.bulkAdd(rawRows, { allKeys: true });
      });
      const t2b = performance.now();
      const rawBulkAddMs = t2b - t2a;

      // ---- 3) serial createRecord() + createRecordOrigin() (today's real
      //         wallet-import loop shape), smaller N since it is much slower ----
      await clearAll();
      const N3 = 3000;
      const recs3 = makeRecords(N3, 'serial');
      const t3a = performance.now();
      for (let i = 0; i < N3; i++) {
        const recordId = await recordCrud.createRecord(recs3[i], { skipNotification: true, skipVocabularySync: true });
        await originsCrud.addRecordOrigin(
          { recordId, originType: 'wallet-sync', source: recs3[i].source, label: recs3[i].label },
          { skipNotification: true },
        );
      }
      const t3b = performance.now();
      const serialMs = t3b - t3a;

      // ---- 4) same N3 workload via batched bulkCreateRecords + bulkAddRecordOrigins ----
      await clearAll();
      const recs4 = makeRecords(N3, 'batched');
      const t4a = performance.now();
      const ids4 = await recordCrud.bulkCreateRecords(recs4, { skipNotification: true, skipVocabularySync: true });
      const originRows4 = ids4.map((recordId, i) => ({
        recordId, originType: 'wallet-sync', source: recs4[i].source, label: recs4[i].label,
      }));
      await originsCrud.bulkAddRecordOrigins(originRows4, { skipNotification: true });
      const t4b = performance.now();
      const batchedMs = t4b - t4a;

      await clearAll();

      return {
        N1, bulkCreateRecordsMs, bulkCreateRecordsRps: N1 / (bulkCreateRecordsMs / 1000),
        rawBulkAddMs, rawBulkAddRps: N1 / (rawBulkAddMs / 1000),
        N3, serialMs, serialRps: N3 / (serialMs / 1000),
        batchedMs, batchedRps: N3 / (batchedMs / 1000),
      };
    });

    console.log('[profile] results:', JSON.stringify(results, null, 2));
    console.log(`[profile] bulkCreateRecords (records only): ${results.bulkCreateRecordsRps.toFixed(0)} rows/sec`);
    console.log(`[profile] raw Dexie bulkAdd baseline:        ${results.rawBulkAddRps.toFixed(0)} rows/sec`);
    console.log(`[profile] overhead of bulkCreateRecords vs raw bulkAdd: ${(results.bulkCreateRecordsMs - results.rawBulkAddMs).toFixed(0)}ms for ${results.N1} rows (${(((results.bulkCreateRecordsMs - results.rawBulkAddMs) / results.rawBulkAddMs) * 100).toFixed(1)}% over raw)`);
    console.log(`[profile] serial createRecord+createRecordOrigin (today's import-loop shape): ${results.serialRps.toFixed(0)} rows/sec`);
    console.log(`[profile] batched bulkCreateRecords+bulkAddRecordOrigins (same workload):      ${results.batchedRps.toFixed(0)} rows/sec`);
    console.log(`[profile] speedup from batching the import loop: ${(results.batchedRps / results.serialRps).toFixed(1)}x`);
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch { try { devProc.kill('SIGTERM'); } catch {} }
    }
  }
}

main().catch((err) => {
  console.error('[profile] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
