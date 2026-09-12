#!/usr/bin/env node
// One-off scale benchmark for Task #2122 ("Find and fix the real bottleneck
// slowing down large wallet imports and restores"). NOT wired into the
// validation pipeline — this is a throwaway diagnostic script, run manually.
//
// Calls the REAL executeImport() (client/src/lib/wallet-import/import-manager.ts)
// end to end in a real headless Chromium against real IndexedDB, with a
// 100,000-row synthetic "new wallet" DuplicateInfo array (the shape
// checkForDuplicates() produces after scanning a large wallet file), to
// confirm the batched-write refactor produces a real, not just isolated,
// speedup for a 100k+ address wallet import.
//
// Usage: node scripts/profile-execute-import-scale.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'profile-execute-import-123';

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
    console.log(`[profile-scale] reusing dev server at ${BASE_URL}`);
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
      const importManager = await import('/src/lib/wallet-import/import-manager.ts');
      const { db } = await import('/src/lib/database.ts');

      async function clearAll() {
        await db.records.clear();
        await db.recordOrigins.clear();
      }

      function makeDuplicateInfos(n) {
        const out = [];
        for (let i = 0; i < n; i++) {
          out.push({
            parsedRecord: {
              type: 'address',
              inputString: `bc1q${String(i).padStart(12, '0')}scaleimport`,
              label: `Address ${i}`,
              source: 'walletImport-ScaleWallet_2026-08-27_000000',
            },
            existingRecord: null,
            isNew: true,
            willMerge: false,
          });
        }
        return out;
      }

      const options = {
        sourceName: 'walletImport-ScaleWallet_2026-08-27_000000',
        defaultTags: [],
        defaultCategories: [],
        walletName: 'ScaleWallet',
        owner: 'ScaleOwner',
      };

      // 100k-row fresh-wallet import through the REAL executeImport() path.
      await clearAll();
      const N = 100_000;
      const duplicateInfos = makeDuplicateInfos(N);
      const t0 = performance.now();
      const result = await importManager.executeImport(duplicateInfos, options);
      const t1 = performance.now();
      const elapsedMs = t1 - t0;

      const recordCount = await db.records.count();
      const originCount = await db.recordOrigins.count();

      await clearAll();

      return {
        N,
        elapsedMs,
        rps: N / (elapsedMs / 1000),
        newRecords: result.newRecords,
        failedRecords: result.failedRecords,
        errors: result.errors.slice(0, 5),
        recordCount,
        originCount,
      };
    });

    console.log('[profile-scale] results:', JSON.stringify(results, null, 2));
    console.log(`[profile-scale] executeImport() on ${results.N} new addresses: ${results.elapsedMs.toFixed(0)}ms, ${results.rps.toFixed(0)} rows/sec`);
    const okShape = results.newRecords === results.N && results.failedRecords === 0
      && results.recordCount === results.N && results.originCount === results.N;
    console.log(`[profile-scale] correctness check (newRecords/failedRecords/db counts all match N): ${okShape ? 'PASS' : 'FAIL'}`);
    if (!okShape) process.exitCode = 1;
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch { try { devProc.kill('SIGTERM'); } catch {} }
    }
  }
}

main().catch((err) => {
  console.error('[profile-scale] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
