#!/usr/bin/env node
// One-off real-browser verification for Task #2143 ("Speed up bulk-deleting
// many records on the Records page too"). NOT wired into the validation
// pipeline — throwaway diagnostic script, run manually.
//
// Exercises the ACTUAL Records.tsx UI path: seed records with attachments,
// reload so the page's data load picks them up, check "select all" in
// RecordTable, click the bulk-delete button + confirm, then assert every
// record and its attachment row are gone while the attachment metadata was
// archived (never destroyed) — the same contract deleteRecord() has, now
// exercised through the batched bulkDeleteRecordsWithArchiving() path that
// Task #2130 already added for Dashboard.tsx.
//
// NOTE: Records.tsx paginates at PAGE_SIZE=50 and its "select all" checkbox
// only selects the rows loaded for the CURRENT page, so N here is kept below
// that cap (unlike Dashboard.tsx, which shows every filtered record
// unpaginated and can select many thousands at once).
//
// Usage: node scripts/check-records-bulk-delete-task2143.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/records`;
const SETUP_PASSWORD = 'check-bulk-delete-2143';

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
  if (await isServerUp(`http://localhost:${PORT}/`)) {
    console.log(`[check] reusing dev server at http://localhost:${PORT}/`);
  } else {
    devProc = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
    startedServer = true;
    if (!(await waitForServer(`http://localhost:${PORT}/`, 90_000))) throw new Error('dev server did not start');
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[page-console] ${msg.text()}`);
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    // Records.tsx paginates at PAGE_SIZE=50; the page's "select all" only
    // ever selects the current page's rows, so N is kept comfortably under
    // that cap.
    const N = 40;
    const seedResult = await page.evaluate(async (n) => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const { db } = await import('/src/lib/database.ts');
      await db.records.clear();
      await db.attachments.clear();
      await db.trashedAttachments.clear();

      const rows = [];
      for (let i = 0; i < n; i++) {
        rows.push({
          type: 'address',
          inputString: `bc1qcheck2143${String(i).padStart(6, '0')}`,
          label: `Records bulk delete check row ${i}`,
          tags: [],
          categories: [],
          addressImportance: 'manual',
        });
      }
      const ids = await recordCrud.bulkCreateRecords(rows, { skipNotification: true, skipVocabularySync: true });
      await db.attachments.bulkAdd(ids.map((recordId, i) => ({
        recordId, filename: `f${i}.txt`, mimeType: 'text/plain', size: 1, objectStoragePath: `p2143/${i}.txt`, createdAt: Date.now(),
      })));
      return { count: ids.length };
    }, N);

    if (seedResult.count !== N) throw new Error(`Seed failed: expected ${N} records, got ${seedResult.count}`);
    console.log(`[check] seeded ${seedResult.count} records with attachments`);

    // Reload so Records.tsx's own data load picks up the seeded rows.
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    await page.waitForSelector('[data-testid="checkbox-select-all"]', { timeout: 20_000 });
    await page.click('[data-testid="checkbox-select-all"]');

    await page.waitForSelector('[data-testid="button-bulk-delete"]', { timeout: 10_000 });
    await page.click('[data-testid="button-bulk-delete"]');

    await page.waitForSelector('[data-testid="button-confirm-bulk-delete"]', { timeout: 10_000 });
    await page.click('[data-testid="button-confirm-bulk-delete"]');

    // Wait for the toast confirming the deletion completed.
    await page.waitForFunction(
      () => document.body.innerText.includes('Records deleted') || document.body.innerText.includes('Partial deletion'),
      undefined,
      { timeout: 20_000 },
    );
    const toastText = await page.evaluate(() => document.body.innerText.includes('Partial deletion') ? 'partial' : 'success');
    if (toastText !== 'success') throw new Error('Bulk delete reported a partial failure');

    const finalState = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      return {
        recordCount: await db.records.count(),
        attachmentCount: await db.attachments.count(),
        trashedCount: await db.trashedAttachments.count(),
      };
    });

    console.log('[check] final state:', JSON.stringify(finalState));

    if (finalState.recordCount !== 0) throw new Error(`Expected 0 records left, got ${finalState.recordCount}`);
    if (finalState.attachmentCount !== 0) throw new Error(`Expected 0 attachment rows left, got ${finalState.attachmentCount}`);
    if (finalState.trashedCount !== N) throw new Error(`Expected ${N} archived attachments, got ${finalState.trashedCount}`);
    if (pageErrors.length > 0) throw new Error(`Uncaught page errors: ${pageErrors.join(' | ')}`);

    // Cleanup.
    await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      await db.trashedAttachments.clear();
    });

    console.log('[check] PASS: Records page bulk delete via UI archived attachments and removed all selected records via the batched path.');

    // ---- Throughput re-measurement (direct crud calls, same functions the
    // UI path above now calls) — confirms the Records.tsx fix gets the same
    // class of speedup Task #2130 measured for Dashboard.tsx, since both
    // pages now drive the identical bulkDeleteRecordsWithArchiving() helper.
    const perf = await page.evaluate(async () => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const { db } = await import('/src/lib/database.ts');

      async function clearAll() {
        await db.records.clear();
        await db.attachments.clear();
        await db.trashedAttachments.clear();
      }

      function makeRecords(n, prefix) {
        const out = [];
        for (let i = 0; i < n; i++) {
          out.push({
            type: 'address',
            inputString: `bc1q${prefix}${String(i).padStart(10, '0')}2143row`,
            label: `Records bulk delete profile row ${i}`,
            tags: [],
            categories: [],
            addressImportance: 'pending-review',
          });
        }
        return out;
      }

      const N = 3000;
      const CHUNK = 1000;

      // ---- OLD Records.tsx handleBulkDelete() shape: serial deleteRecord() loop.
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

      // ---- NEW Records.tsx handleBulkDelete() shape: chunked bulkDeleteRecordsWithArchiving().
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

    console.log(`\n[Records.handleBulkDelete] N=${perf.N}`);
    console.log(`  serial deleteRecord() loop (OLD):              ${perf.serialMs.toFixed(0)}ms  (${perf.serialRps.toFixed(0)} rows/sec)`);
    console.log(`  batched bulkDeleteRecordsWithArchiving() (NEW): ${perf.batchedMs.toFixed(0)}ms  (${perf.batchedRps.toFixed(0)} rows/sec)`);
    console.log(`  speedup: ${(perf.batchedRps / perf.serialRps).toFixed(1)}x`);
    console.log(`  attachment archiving parity: serial=${perf.trashCountAfterSerial} batched=${perf.trashCountAfterBatched} (both should equal N=${perf.N})`);

    if (perf.trashCountAfterSerial !== perf.N || perf.trashCountAfterBatched !== perf.N) {
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
  console.error('[check] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
