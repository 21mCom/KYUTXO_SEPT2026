#!/usr/bin/env node
// Task 1934 real-browser check: the Address Checker's Cancel button must also
// abort an in-flight First/Last Seen history walk on the ELECTRUM path.
//
// The Esplora path is covered by check-address-checker-cancel-history-browser.mjs
// (rateLimitedFetch aborts the in-flight HTTP request). Electrum-backed history
// loads take a different path: ElectrumProvider.getAddressHistoryDates →
// getAddressTransactions, which fans out electrumGetTransaction IPC calls in
// batches of TX_FETCH_CONCURRENCY (5). IPC calls themselves cannot be aborted,
// so the documented cancel contract is: the AbortSignal is checked BETWEEN
// batches — after Cancel, at most the in-flight batch completes and no further
// batch is dispatched, and the row reverts to the idle Load button.
//
// A browser tab cannot open raw TCP, so window.electronAPI is shimmed with a
// deterministic Electrum mock: a 400-tx history whose per-tx fetches take
// ~250 ms each (batches of 5 ⇒ ~20 s uncancelled walk). We start the on-demand
// history load, wait until several tx fetches happened, click Cancel and
// assert (a) tx fetches stop promptly — flat after at most one more in-flight
// batch — and (b) the row reverts to the idle Load button (not stuck on the
// spinner, not an error Retry), and (c) Load works again afterwards.
//
// NOTE for reviewers: the consumer under test is
// client/src/pages/AddressChecker.tsx (route /address-checker,
// handleCancelHistory / historyAbortRef); the abort plumbing under test lives
// in client/src/lib/providers/electrum.ts (getAddressTransactions signal
// checks at lines ~180 and ~213).
//
// Usage: node scripts/check-address-checker-electrum-cancel-history-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'addr-checker-electrum-cancel-123';
// Valid mainnet P2WPKH address (BIP-173 test vector) — the row under test.
const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const TX_COUNT = 400; // 80 batches of 5 — a ~20 s walk if not cancelled
const TX_DELAY_MS = 250; // per-tx IPC latency so Cancel lands mid-walk
const BATCH_SIZE = 5; // must match ElectrumProvider.TX_FETCH_CONCURRENCY

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

// window.electronAPI shim installed before every page load. Models a pooled
// Electrum socket: the address history returns TX_COUNT entries in one call,
// each verbose tx fetch takes TX_DELAY_MS. Every electrumGetTransaction call
// bumps window.__txFetches so the Node side can watch the walk's progress.
// Unknown methods resolve to a generic failure so unrelated Electron-only
// probes stay non-fatal.
const SHIM = `
(() => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const TX_COUNT = ${TX_COUNT};
  const TX_DELAY_MS = ${TX_DELAY_MS};
  const txidFor = (n) => n.toString(16).padStart(8, '0').repeat(8);
  const historyFor = () =>
    Array.from({ length: TX_COUNT }, (_, n) => ({ tx_hash: txidFor(n), height: 800000 + n }));
  window.__txFetches = 0;
  const base = {
    isElectron: true,
    electrumTest: async () => { await delay(30); return { success: true, serverVersion: 'shim 1.4', blockHeight: 900000, latency: 30 }; },
    electrumGetHistory: async () => {
      await delay(40);
      return { success: true, history: historyFor() };
    },
    electrumBatchGetHistory: async ({ addresses }) => {
      await delay(20);
      return { success: true, results: addresses.map((address) => ({ address, success: true, history: historyFor() })) };
    },
    electrumGetUtxos: async () => {
      await delay(20);
      return { success: true, utxos: [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 12345, height: 800000 }] };
    },
    electrumBatchGetUtxos: async ({ addresses }) => {
      await delay(20);
      return { success: true, results: addresses.map((address) => ({ address, success: true, utxos: [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 12345, height: 800000 }] })) };
    },
    electrumGetTransaction: async ({ txid }) => {
      window.__txFetches++;
      await delay(TX_DELAY_MS);
      const n = parseInt(txid.slice(0, 8), 16);
      return {
        success: true,
        transaction: {
          txid,
          version: 2,
          locktime: 0,
          size: 200,
          vsize: 150,
          time: 1700000000 - n * 600,
          blocktime: 1700000000 - n * 600,
          confirmations: 1000 + n,
          vin: [{ txid: 'b'.repeat(64), vout: 0, sequence: 0xfffffffd }],
          vout: [{ value: 0.001, n: 0, scriptPubKey: { address: '${ADDRESS}', type: 'v0_p2wpkh' } }],
        },
      };
    },
  };
  window.electronAPI = new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== 'string') return undefined;
      return async () => ({ success: false, error: 'not implemented in shim' });
    },
  });
})();
`;

async function main() {
  const exe = resolveChromium();
  console.log(`[electrum-cancel-history] chromium: ${exe}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[electrum-cancel-history] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
    if (!(await waitForServer(BASE_URL, 90_000))) throw new Error('Dev server not ready in 90s');
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel load.
  let browser = null;
  for (let attempt = 1; attempt <= 3 && !browser; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`[electrum-cancel-history] chromium launch failed (attempt ${attempt}): ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  console.log('[electrum-cancel-history] chromium launched');

  const steps = [];
  const step = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(SHIM);
    const page = await context.newPage();
    const txFetches = () => page.evaluate(() => window.__txFetches || 0);

    // Retry the initial load + first selector: single-shot waits flake under
    // parallel validation.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await waitForLoginScreenVisible(page, { timeoutMs: 45_000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`[electrum-cancel-history] initial load failed (attempt ${attempt}): ${e.message}; retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    console.log('[electrum-cancel-history] app loaded, creating vault');
    await unlockIfNeeded(page, SETUP_PASSWORD);

    // Seed Electrum node settings so the checker takes the Electrum IPC path
    // this check shims — no HTTP provider involved.
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const nodeCrud = await import('/src/lib/data/node-settings-crud.ts');
      await nodeCrud.putNodeSettings({
        id: 'default',
        providerType: 'mempool-space',
        useTor: false,
        requestTimeout: 30000,
        network: 'mainnet',
        allowLocalNetwork: false,
        trustedLocalHosts: [],
        useElectrum: true,
        electrumHost: 'shim.local',
        electrumPort: 50001,
        electrumSSL: false,
      });
    });

    await page.goto(`http://localhost:${PORT}/address-checker`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD);

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });
    await textarea.fill(ADDRESS);

    // Run the check: fast tier only (batched history length + UTXOs — no
    // per-tx fetches yet).
    await page.getByTestId('button-run-check').click();
    const loadBtn = page.getByTestId(`button-load-history-${ADDRESS}`);
    await loadBtn.waitFor({ state: 'visible', timeout: 30_000 });
    step('check run completes; First Seen cell shows the idle Load button', true);
    const fetchesBeforeLoad = await txFetches();
    step('fast tier fetched no per-tx data before Load is clicked', fetchesBeforeLoad === 0, `txFetches=${fetchesBeforeLoad}`);

    // Start the long on-demand history walk (per-tx Electrum IPC fetches).
    await loadBtn.click();
    const cancelBtn = page.getByTestId('button-cancel-history');
    await cancelBtn.waitFor({ state: 'visible', timeout: 10_000 });

    // Let the walk get well underway: wait until several tx fetches happened.
    const walkStart = Date.now();
    let fetched = 0;
    while ((fetched = await txFetches()) < BATCH_SIZE * 2 && Date.now() - walkStart < 30_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    step('history walk is fetching transactions (≥2 batches before Cancel)', fetched >= BATCH_SIZE * 2, `txFetches=${fetched}`);
    const spinnerVisible = await page.getByTestId(`text-history-scan-${ADDRESS}`).isVisible().catch(() => false);
    step('row shows the in-progress scan indicator mid-walk', spinnerVisible);

    // ── Cancel mid-walk ──────────────────────────────────────────────────
    const fetchesAtCancel = await txFetches();
    const tCancel = Date.now();
    await cancelBtn.click();

    // Row must revert to the idle Load button promptly — not stuck loading.
    await loadBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const revertLatency = Date.now() - tCancel;
    step('First Seen cell reverts to the Load button after Cancel', true, `${revertLatency}ms after click`);
    step('Cancel reverts promptly (< 3 s)', revertLatency < 3000, `${revertLatency}ms`);

    const retryVisible = await page.getByTestId(`button-retry-history-${ADDRESS}`).isVisible().catch(() => false);
    step('row is idle, not an error (no Retry button)', !retryVisible);
    const scanStillVisible = await page.getByTestId(`text-history-scan-${ADDRESS}`).isVisible().catch(() => false);
    step('scan-progress spinner is gone after Cancel', !scanStillVisible);
    const cancelStillVisible = await cancelBtn.isVisible().catch(() => false);
    step('history controls left the running state (Cancel button gone)', !cancelStillVisible);

    // No FURTHER tx fetches after the in-flight batch settles. IPC calls
    // cannot be aborted, so allow the batch that was already dispatched at the
    // instant of the click (≤ BATCH_SIZE fetches); then the count must be flat
    // for a window several batches long (2.5 s ≈ 10 batches at the mock's
    // cadence, so a continued walk cannot hide).
    await new Promise((r) => setTimeout(r, 600));
    const fetchesAfterGrace = await txFetches();
    await new Promise((r) => setTimeout(r, 2500));
    const fetchesSettled = await txFetches();
    step(
      'no further tx fetches after Cancel (count flat over 2.5 s window)',
      fetchesSettled === fetchesAfterGrace && fetchesAfterGrace - fetchesAtCancel <= BATCH_SIZE,
      `atCancel=${fetchesAtCancel} +0.6s=${fetchesAfterGrace} +3.1s=${fetchesSettled} (uncancelled walk = ${TX_COUNT} fetches)`,
    );
    step(
      'walk stopped far short of the full history (abort between batches, not end-of-walk)',
      fetchesSettled < TX_COUNT / 4,
      `tx fetched=${fetchesSettled} of ${TX_COUNT}`,
    );

    // The row must be re-loadable: clicking Load again starts a fresh walk.
    await loadBtn.click();
    const restartStart = Date.now();
    let fetchesAfterRestart = fetchesSettled;
    while ((fetchesAfterRestart = await txFetches()) <= fetchesSettled && Date.now() - restartStart < 15_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    step('Load works again after Cancel (new walk fetches transactions)', fetchesAfterRestart > fetchesSettled, `txFetches=${fetchesAfterRestart}`);
    await page.getByTestId('button-cancel-history').click().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  if (failed.length) {
    console.error(`[electrum-cancel-history] ${failed.length}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`[electrum-cancel-history] all ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error('[electrum-cancel-history] FAILED:', e);
  process.exit(1);
});
