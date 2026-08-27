#!/usr/bin/env node
// One-off profiling harness for Task #2129 ("Speed up other bulk record
// edits that still save one row at a time"). NOT wired into the validation
// pipeline — this is a throwaway diagnostic script, run manually.
//
// Confirms, in a REAL headless Chromium against real IndexedDB, that the two
// serial-loop-per-record call sites this task fixed hit the same wall Task
// #2122 found (and get the same class of speedup from batching):
//
//   1. VaultManagement.tsx saveVaultNotes() — a `for` loop calling
//      updateRecord() once per address record in a vault, now converted to
//      chunked bulkUpdateRecords().
//   2. Dashboard.tsx createAddressRecordsFromTx() — a `for` loop calling
//      createRecord() once per input/output address of an imported
//      transaction (a consolidation tx can have hundreds/thousands), now
//      converted to chunked bulkCreateRecords() + bulkAddRecordOrigins().
//
// Usage: node scripts/profile-bulk-record-edits-task2129.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'profile-bulk-edits-2129';

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

      async function clearAll() {
        await db.records.clear();
        await db.recordOrigins.clear();
      }

      // ---------------------------------------------------------------
      // Flow 1: VaultManagement.tsx saveVaultNotes() shape — N existing
      // vault address records, each getting its `vault.vaultNotes` field
      // rewritten.
      // ---------------------------------------------------------------
      function makeVaultRecords(n) {
        const out = [];
        for (let i = 0; i < n; i++) {
          out.push({
            type: 'address',
            inputString: `bc1qvault${String(i).padStart(10, '0')}profilerow`,
            label: `Vault addr ${i}`,
            tags: [],
            categories: [],
            addressImportance: 'xpub-derived',
            vault: {
              isVaultXpub: true,
              vaultName: 'ProfileVault',
              m: 2,
              n: 3,
              vaultNotes: JSON.stringify({ scriptType: 'p2wsh' }),
            },
          });
        }
        return out;
      }

      const N1 = 5000;

      // Serial updateRecord() loop — the ORIGINAL saveVaultNotes() shape.
      await clearAll();
      const seedIds1 = await recordCrud.bulkCreateRecords(makeVaultRecords(N1), { skipNotification: true, skipVocabularySync: true });
      const seeded1 = await db.records.bulkGet(seedIds1);
      const t1a = performance.now();
      for (const record of seeded1) {
        const existingParsed = JSON.parse(record.vault.vaultNotes);
        await recordCrud.updateRecord(record.id, {
          vault: { ...record.vault, vaultNotes: JSON.stringify({ ...existingParsed, userNotes: 'Updated notes' }) },
        }, { skipNotification: true, skipVocabularySync: true });
      }
      const t1b = performance.now();
      const vaultSerialMs = t1b - t1a;

      // Batched bulkUpdateRecords() — the NEW saveVaultNotes() shape.
      await clearAll();
      const seedIds2 = await recordCrud.bulkCreateRecords(makeVaultRecords(N1), { skipNotification: true, skipVocabularySync: true });
      const seeded2 = await db.records.bulkGet(seedIds2);
      const t2a = performance.now();
      const CHUNK = 1000;
      for (let start = 0; start < seeded2.length; start += CHUNK) {
        const chunk = seeded2.slice(start, start + CHUNK);
        const updates = chunk.map((record) => {
          const existingParsed = JSON.parse(record.vault.vaultNotes);
          return {
            id: record.id,
            changes: { vault: { ...record.vault, vaultNotes: JSON.stringify({ ...existingParsed, userNotes: 'Updated notes' }) } },
          };
        });
        await recordCrud.bulkUpdateRecords(updates, { skipNotification: true, skipVocabularySync: true });
      }
      const t2b = performance.now();
      const vaultBatchedMs = t2b - t2a;

      // ---------------------------------------------------------------
      // Flow 2: Dashboard.tsx createAddressRecordsFromTx() shape — N new
      // input/output address records from one imported transaction.
      // ---------------------------------------------------------------
      function makeTxAddrData(n) {
        const out = [];
        for (let i = 0; i < n; i++) {
          out.push({
            type: 'address',
            inputString: `bc1qtx${String(i).padStart(11, '0')}profilerow`,
            label: `TX Input 1/1/2026`,
            notes: `Input address from transaction deadbeef...`,
            tags: [],
            categories: [],
            owner: 'Pending Review',
            walletName: '',
            source: `tx-import:deadbeefcafe`,
            addressImportance: 'pending-review',
            syncDepth: 0,
            maxSyncedDepth: -1,
          });
        }
        return out;
      }

      // Serial createRecord() loop — the ORIGINAL createAddressRecordsFromTx() shape.
      await clearAll();
      const N2 = 3000;
      const recs3 = makeTxAddrData(N2);
      const t3a = performance.now();
      for (let i = 0; i < N2; i++) {
        const recordId = await recordCrud.createRecord(recs3[i], { skipNotification: true, skipVocabularySync: true });
        await originsCrud.addRecordOrigin(
          { recordId, originType: 'bulk-import', source: recs3[i].source, label: recs3[i].label, notes: recs3[i].notes, owner: recs3[i].owner, walletName: recs3[i].walletName, tags: recs3[i].tags, categories: recs3[i].categories },
          { skipNotification: true },
        );
      }
      const t3b = performance.now();
      const txSerialMs = t3b - t3a;

      // Batched bulkCreateRecords() + bulkAddRecordOrigins() — the NEW
      // createAddressRecordsFromTx() shape.
      await clearAll();
      const recs4 = makeTxAddrData(N2);
      const t4a = performance.now();
      for (let start = 0; start < recs4.length; start += CHUNK) {
        const chunk = recs4.slice(start, start + CHUNK);
        const ids = await recordCrud.bulkCreateRecords(chunk, { skipNotification: true, skipVocabularySync: true });
        const originRows = ids.map((recordId, j) => ({
          recordId, originType: 'bulk-import', source: chunk[j].source, label: chunk[j].label, notes: chunk[j].notes, owner: chunk[j].owner, walletName: chunk[j].walletName, tags: chunk[j].tags, categories: chunk[j].categories,
        }));
        await originsCrud.bulkAddRecordOrigins(originRows, { skipNotification: true });
      }
      const t4b = performance.now();
      const txBatchedMs = t4b - t4a;

      await clearAll();

      return {
        N1, vaultSerialMs, vaultSerialRps: N1 / (vaultSerialMs / 1000),
        vaultBatchedMs, vaultBatchedRps: N1 / (vaultBatchedMs / 1000),
        N2, txSerialMs, txSerialRps: N2 / (txSerialMs / 1000),
        txBatchedMs, txBatchedRps: N2 / (txBatchedMs / 1000),
      };
    });

    console.log('[profile] results:', JSON.stringify(results, null, 2));
    console.log(`\n[VaultManagement.saveVaultNotes] N=${results.N1}`);
    console.log(`  serial updateRecord() loop:        ${results.vaultSerialMs.toFixed(0)}ms  (${results.vaultSerialRps.toFixed(0)} rows/sec)`);
    console.log(`  batched bulkUpdateRecords():        ${results.vaultBatchedMs.toFixed(0)}ms  (${results.vaultBatchedRps.toFixed(0)} rows/sec)`);
    console.log(`  speedup: ${(results.vaultBatchedRps / results.vaultSerialRps).toFixed(1)}x`);

    console.log(`\n[Dashboard.createAddressRecordsFromTx] N=${results.N2}`);
    console.log(`  serial createRecord() loop:                          ${results.txSerialMs.toFixed(0)}ms  (${results.txSerialRps.toFixed(0)} rows/sec)`);
    console.log(`  batched bulkCreateRecords()+bulkAddRecordOrigins():  ${results.txBatchedMs.toFixed(0)}ms  (${results.txBatchedRps.toFixed(0)} rows/sec)`);
    console.log(`  speedup: ${(results.txBatchedRps / results.txSerialRps).toFixed(1)}x`);
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
