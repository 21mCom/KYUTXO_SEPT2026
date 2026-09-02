#!/usr/bin/env node
// One-off profiling harness for Task #2130 ("Speed up bulk-deleting many
// records at once"). NOT wired into the validation pipeline — this is a
// throwaway diagnostic script, run manually.
//
// Confirms, in a REAL headless Chromium against real IndexedDB, that
// Dashboard.tsx's handleBulkDelete() — a `for` loop calling deleteRecord()
// once per selected record — hits the same wall Task #2122/#2129 found for
// the create/update loops, and that the chunked bulkDeleteRecordsWithArchiving()
// replacement gets the same class of speedup while still archiving every
// deleted record's attachments (never destroying files).
//
// Usage: node scripts/profile-bulk-delete-task2130.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'profile-bulk-delete-2130';

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
      const { db } = await import('/src/lib/database.ts');

      async function clearAll() {
        await db.records.clear();
        await db.attachments.clear();
        await db.trashedAttachments.clear();
      }

      // Dashboard.tsx handleBulkDelete() shape: N records selected via
      // "select all" on a loaded page, each with an attachment (so archiving
      // cost is included in both measurements, matching deleteRecord()).
      function makeRecords(n, prefix) {
        const out = [];
        for (let i = 0; i < n; i++) {
          out.push({
            type: 'address',
            inputString: `bc1q${prefix}${String(i).padStart(10, '0')}profilerow`,
            label: `Bulk delete profile row ${i}`,
            tags: [],
            categories: [],
            addressImportance: 'pending-review',
          });
        }
        return out;
      }

      const N = 3000;
      const CHUNK = 1000;

      // ---- Serial deleteRecord() loop — the ORIGINAL handleBulkDelete() shape.
      await clearAll();
      const seedIds1 = await recordCrud.bulkCreateRecords(makeRecords(N, 'serial'), { skipNotification: true, skipVocabularySync: true });
      await db.attachments.bulkAdd(seedIds1.map((recordId, i) => ({
        recordId, filename: `f${i}.txt`, mimeType: 'text/plain', size: 1, objectStoragePath: `p/${i}.txt`, createdAt: Date.now(),
      })));
      const t1a = performance.now();
      for (const id of seedIds1) {
        await recordCrud.deleteRecord(id, { skipNotification: true });
      }
      const t1b = performance.now();
      const serialMs = t1b - t1a;
      const trashCountAfterSerial = await db.trashedAttachments.count();

      // ---- Batched bulkDeleteRecordsWithArchiving() — the NEW handleBulkDelete() shape.
      await clearAll();
      const seedIds2 = await recordCrud.bulkCreateRecords(makeRecords(N, 'batched'), { skipNotification: true, skipVocabularySync: true });
      await db.attachments.bulkAdd(seedIds2.map((recordId, i) => ({
        recordId, filename: `f${i}.txt`, mimeType: 'text/plain', size: 1, objectStoragePath: `p/${i}.txt`, createdAt: Date.now(),
      })));
      const t2a = performance.now();
      for (let start = 0; start < seedIds2.length; start += CHUNK) {
        const chunk = seedIds2.slice(start, start + CHUNK);
        await recordCrud.bulkDeleteRecordsWithArchiving(chunk, { skipNotification: true });
      }
      const t2b = performance.now();
      const batchedMs = t2b - t2a;
      const trashCountAfterBatched = await db.trashedAttachments.count();

      await clearAll();

      return {
        N,
        serialMs, serialRps: N / (serialMs / 1000),
        batchedMs, batchedRps: N / (batchedMs / 1000),
        trashCountAfterSerial, trashCountAfterBatched,
      };
    });

    console.log('[profile] results:', JSON.stringify(results, null, 2));
    console.log(`\n[Dashboard.handleBulkDelete] N=${results.N}`);
    console.log(`  serial deleteRecord() loop:                    ${results.serialMs.toFixed(0)}ms  (${results.serialRps.toFixed(0)} rows/sec)`);
    console.log(`  batched bulkDeleteRecordsWithArchiving():      ${results.batchedMs.toFixed(0)}ms  (${results.batchedRps.toFixed(0)} rows/sec)`);
    console.log(`  speedup: ${(results.batchedRps / results.serialRps).toFixed(1)}x`);
    console.log(`  attachment archiving parity: serial=${results.trashCountAfterSerial} batched=${results.trashCountAfterBatched} (both should equal N=${results.N})`);

    if (results.trashCountAfterSerial !== results.N || results.trashCountAfterBatched !== results.N) {
      throw new Error('Attachment archiving parity check FAILED — one path did not archive every attachment');
    }
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
