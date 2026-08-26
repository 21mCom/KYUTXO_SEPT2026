#!/usr/bin/env node
// Real-browser regression guard for Wallet Overview per-wallet address counts
// (Task #1784).
//
// Two symptoms are reproduced end to end in a REAL headless Chromium:
//   1. Inflated counts — sync auto-creates blockchain-discovered /
//      pending-review counterparty rows stamped with the parent wallet's
//      walletName; Wallet Overview must count ONLY user-curated rows
//      (verified/manual/wallet-import/xpub-derived + legacy NULL tier).
//   2. Stuck counts — re-importing addresses (via the wallet-file import
//      merge path) must re-attribute rows that sit under a DIFFERENT wallet
//      name (discovery-stamped or curated) to the imported wallet, and the
//      ImportResult must report the re-attribution count.
//
// In the browser preview the native engine mirror is unavailable, so this
// exercises the Dexie fallback path; the engine SQL path is pinned to the
// same numbers by client/src/lib/engine/__tests__/wallet-usage-parity.test.ts.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-wallet-overview-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'wallet-overview-check-123';

const ALPHA_RECEIVE = 40; // curated manual, 30 used
const ALPHA_RECEIVE_USED = 30;
const ALPHA_CHANGE = 10; // curated xpub-derived, 4 used
const ALPHA_CHANGE_USED = 4;
const ALPHA_DISCOVERED = 2000; // blockchain-discovered stamped 'WalletAlpha'
const ALPHA_PENDING = 300; // pending-review stamped 'WalletAlpha'
const BETA_RECEIVE = 5; // curated manual, 2 used
const BETA_RECEIVE_USED = 2;
const REIMPORT_DISCOVERED = 20; // discovered rows under WalletAlpha -> reimport to WalletBeta
const REIMPORT_CURATED = 3; // curated manual rows under WalletGamma -> reimport to WalletBeta

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



/** Wait until row-wallet-<name> contains `needle` (or the row vanishes when needle is null). */
async function waitForWalletRow(page, walletName, needle, timeoutMs = 45_000) {
  const row = page.getByTestId(`row-wallet-${walletName}`);
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    if (needle === null) {
      if (!(await row.isVisible().catch(() => false))) return { ok: true, text: '(absent)' };
    } else {
      text = ((await row.textContent().catch(() => '')) ?? '').trim();
      if (text.includes(needle)) return { ok: true, text };
    }
    await page.waitForTimeout(400);
  }
  return { ok: false, text };
}

async function main() {
  const exe = resolveChromium();
  console.log(`[wallet-overview-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[wallet-overview-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[wallet-overview-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
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
      console.log(`[wallet-overview-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1600 },
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[wallet-overview-browser][page-console] ${msg.text()}`);
      }
    });

    await page.goto(`${BASE_URL}wallet-overview`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed a vault reproducing both symptoms (bulk CRUD helpers) ────────
    const seed = await page.evaluate(
      async ({ alphaReceive, alphaReceiveUsed, alphaChange, alphaChangeUsed, alphaDiscovered, alphaPending, betaReceive, betaReceiveUsed, reimportDiscovered, reimportCurated }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const now = Math.floor(Date.now() / 1000);
        const records = [];

        // WalletAlpha curated rows (the ~50 real addresses).
        for (let i = 0; i < alphaReceive; i++) {
          records.push({
            type: 'address', inputString: `bc1qwoverviewalphar${String(i).padStart(3, '0')}`,
            label: `Alpha receive ${i}`, tags: [], categories: [],
            walletName: 'WalletAlpha', addressImportance: 'manual', chainType: 'receive',
            firstSeenBlockTime: i < alphaReceiveUsed ? now - i * 60 : undefined,
          });
        }
        for (let i = 0; i < alphaChange; i++) {
          records.push({
            type: 'address', inputString: `bc1qwoverviewalphac${String(i).padStart(3, '0')}`,
            label: `Alpha change ${i}`, tags: [], categories: [],
            walletName: 'WalletAlpha', addressImportance: 'xpub-derived', chainType: 'change',
            firstSeenBlockTime: i < alphaChangeUsed ? now - i * 60 : undefined,
          });
        }
        // The inflation: thousands of auto-discovered counterparty rows
        // stamped with WalletAlpha's name by sync.
        for (let i = 0; i < alphaDiscovered; i++) {
          records.push({
            type: 'address', inputString: `bc1qwoverviewalphad${String(i).padStart(4, '0')}`,
            label: '', tags: [], categories: [],
            walletName: 'WalletAlpha', addressImportance: 'blockchain-discovered',
            discoveredInTxid: `txdisc${i}`,
          });
        }
        for (let i = 0; i < alphaPending; i++) {
          records.push({
            type: 'address', inputString: `bc1qwoverviewalphap${String(i).padStart(4, '0')}`,
            label: '', tags: [], categories: [],
            walletName: 'WalletAlpha', addressImportance: 'pending-review',
          });
        }
        // WalletBeta curated rows.
        for (let i = 0; i < betaReceive; i++) {
          records.push({
            type: 'address', inputString: `bc1qwoverviewbetar${String(i).padStart(3, '0')}`,
            label: `Beta receive ${i}`, tags: [], categories: [],
            walletName: 'WalletBeta', addressImportance: 'manual', chainType: 'receive',
            firstSeenBlockTime: i < betaReceiveUsed ? now - i * 60 : undefined,
          });
        }
        // The stuck-count setup: addresses the user is ABOUT to re-import into
        // WalletBeta already exist as discovered rows stamped 'WalletAlpha'…
        const reimportAddrs = [];
        for (let i = 0; i < reimportDiscovered; i++) {
          const addr = `bc1qwoverviewreimport${String(i).padStart(3, '0')}`;
          reimportAddrs.push(addr);
          records.push({
            type: 'address', inputString: addr,
            label: '', tags: [], categories: [],
            walletName: 'WalletAlpha', addressImportance: 'blockchain-discovered',
            discoveredInTxid: `txreimport${i}`,
          });
        }
        // …and a few curated rows left over under a different wallet entirely.
        for (let i = 0; i < reimportCurated; i++) {
          const addr = `bc1qwoverviewcurated${String(i).padStart(3, '0')}`;
          reimportAddrs.push(addr);
          records.push({
            type: 'address', inputString: addr,
            label: `Gamma addr ${i}`, tags: [], categories: [],
            walletName: 'WalletGamma', addressImportance: 'manual', chainType: 'receive',
            firstSeenBlockTime: i === 0 ? now : undefined,
          });
        }

        const CHUNK = 500;
        for (let i = 0; i < records.length; i += CHUNK) {
          await recordCrud.bulkCreateRecords(records.slice(i, i + CHUNK), { skipNotification: true });
        }
        return { recordCount: records.length, reimportAddrs };
      },
      {
        alphaReceive: ALPHA_RECEIVE, alphaReceiveUsed: ALPHA_RECEIVE_USED,
        alphaChange: ALPHA_CHANGE, alphaChangeUsed: ALPHA_CHANGE_USED,
        alphaDiscovered: ALPHA_DISCOVERED, alphaPending: ALPHA_PENDING,
        betaReceive: BETA_RECEIVE, betaReceiveUsed: BETA_RECEIVE_USED,
        reimportDiscovered: REIMPORT_DISCOVERED, reimportCurated: REIMPORT_CURATED,
      },
    );
    steps.push({
      name: 'seeded vault (curated + discovered + pending-review rows)',
      passed: seed.recordCount === ALPHA_RECEIVE + ALPHA_CHANGE + ALPHA_DISCOVERED + ALPHA_PENDING + BETA_RECEIVE + REIMPORT_DISCOVERED + REIMPORT_CURATED,
      detail: `records=${seed.recordCount}`,
    });

    // Reload so the page queries see the seeded rows from a clean mount.
    await page.goto(`${BASE_URL}wallet-overview`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    // ── Symptom 1: only curated rows count ────────────────────────────────
    const alphaRow = await waitForWalletRow(page, 'WalletAlpha', `${ALPHA_RECEIVE_USED}/${ALPHA_RECEIVE}`);
    steps.push({
      name: 'WalletAlpha receive counts only the 40 curated addresses (30 used), not the 2000+ discovered rows',
      passed: alphaRow.ok && alphaRow.text.includes(`${ALPHA_CHANGE_USED}/${ALPHA_CHANGE}`),
      detail: `row="${alphaRow.text}"`,
    });
    const betaRow = await waitForWalletRow(page, 'WalletBeta', `${BETA_RECEIVE_USED}/${BETA_RECEIVE}`);
    steps.push({
      name: 'WalletBeta shows its 5 curated receive addresses (2 used)',
      passed: betaRow.ok,
      detail: `row="${betaRow.text}"`,
    });
    const walletCount = ((await page.getByTestId('text-total-wallets').textContent().catch(() => '')) ?? '').trim();
    steps.push({
      name: 'total wallet count is 3 (Alpha, Beta, Gamma) — discovered rows create no phantom wallets',
      passed: walletCount === '3',
      detail: `text-total-wallets="${walletCount}"`,
    });

    // ── Symptom 2: re-import re-attributes existing rows to WalletBeta ────
    const importResult = await page.evaluate(
      async ({ addrs }) => {
        const im = await import('/src/lib/wallet-import/import-manager.ts');
        const parsed = addrs.map((a) => ({
          type: 'address', inputString: a, label: 'Reimported', isInputAddress: true,
        }));
        const infos = await im.analyzeRecords(parsed);
        return await im.executeImport(infos, {
          sourceName: 'wallet-overview-browser-check',
          walletName: 'WalletBeta',
          defaultTags: [],
          defaultCategories: [],
        });
      },
      { addrs: seed.reimportAddrs },
    );
    const expectedReattr = REIMPORT_DISCOVERED + REIMPORT_CURATED;
    steps.push({
      name: 'wallet-file re-import merges all pre-existing rows and counts every re-attribution',
      passed:
        importResult.updatedRecords === expectedReattr &&
        importResult.reattributedRecords === expectedReattr &&
        importResult.failedRecords === 0,
      detail: JSON.stringify(importResult),
    });

    // Refresh and confirm the moved rows now count under WalletBeta.
    await page.getByTestId('button-refresh').click();
    const betaAfter = await waitForWalletRow(
      page,
      'WalletBeta',
      `${BETA_RECEIVE_USED + REIMPORT_DISCOVERED + 1}/${BETA_RECEIVE + expectedReattr}`,
    );
    steps.push({
      name: 'after Refresh, WalletBeta totals jump to 23/28 (re-attributed rows now count there)',
      passed: betaAfter.ok,
      detail: `row="${betaAfter.text}"`,
    });
    const alphaAfter = await waitForWalletRow(page, 'WalletAlpha', `${ALPHA_RECEIVE_USED}/${ALPHA_RECEIVE}`);
    steps.push({
      name: 'WalletAlpha curated totals are unchanged by the re-import',
      passed: alphaAfter.ok && alphaAfter.text.includes(`${ALPHA_CHANGE_USED}/${ALPHA_CHANGE}`),
      detail: `row="${alphaAfter.text}"`,
    });
    const gammaGone = await waitForWalletRow(page, 'WalletGamma', null, 15_000);
    steps.push({
      name: 'WalletGamma disappears once its curated rows moved to WalletBeta',
      passed: gammaGone.ok,
      detail: `row=${gammaGone.text}`,
    });
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try { devProc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
  }

  const ok = steps.every((s) => s.passed);
  console.log(`[wallet-overview-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[wallet-overview-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[wallet-overview-browser] PASSED: Wallet Overview counts curated addresses only, and re-import re-attributes rows end to end.');
}

main().catch((err) => {
  console.error('[wallet-overview-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
