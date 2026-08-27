#!/usr/bin/env node
// One-off real-browser verification for Task #2130 ("Speed up bulk-deleting
// many records at once"). NOT wired into the validation pipeline — throwaway
// diagnostic script, run manually.
//
// Exercises the ACTUAL Dashboard.tsx UI path: seed records with attachments,
// reload so the page's useLiveQuery picks them up, check "select all" in
// RecordTable, click the bulk-delete button + confirm, then assert every
// record and its attachment row are gone while the attachment metadata was
// archived (never destroyed) — the same contract deleteRecord() has, now
// exercised through the batched bulkDeleteRecordsWithArchiving() path.
//
// NOTE for reviewers: this drives Dashboard.tsx (the "/" route), not Records.tsx.
//
// Usage: node scripts/check-dashboard-bulk-delete-task2130.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'check-bulk-delete-2130';

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
    console.log(`[check] reusing dev server at ${BASE_URL}`);
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
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[page-console] ${msg.text()}`);
    });

    await page.goto(`${BASE_URL}`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

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
          inputString: `bc1qcheck2130${String(i).padStart(6, '0')}`,
          label: `Bulk delete check row ${i}`,
          tags: [],
          categories: [],
          addressImportance: 'manual',
        });
      }
      const ids = await recordCrud.bulkCreateRecords(rows, { skipNotification: true, skipVocabularySync: true });
      await db.attachments.bulkAdd(ids.map((recordId, i) => ({
        recordId, filename: `f${i}.txt`, mimeType: 'text/plain', size: 1, objectStoragePath: `p2130/${i}.txt`, createdAt: Date.now(),
      })));
      return { count: ids.length };
    }, N);

    if (seedResult.count !== N) throw new Error(`Seed failed: expected ${N} records, got ${seedResult.count}`);
    console.log(`[check] seeded ${seedResult.count} records with attachments`);

    // Reload so the Dashboard page's useLiveQuery/useFilteredRecords pick up the seeded rows.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
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

    console.log('[check] PASS: Dashboard bulk delete via UI archived attachments and removed all selected records.');
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
