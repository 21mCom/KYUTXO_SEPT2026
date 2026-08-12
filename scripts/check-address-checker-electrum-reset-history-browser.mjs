#!/usr/bin/env node
// Task 1993 real-browser check: Reset clicked mid-run during a
// "Load First/Last Seen (N)" multi-address history run over the ELECTRUM
// transport must stop the walk, clear the table/textarea, and leave no ghost
// workers writing rows back.
//
// The Esplora (mempool.space HTTP) Reset path is covered by
// check-address-checker-reset-history-browser.mjs. Electrum-backed history
// loads take a different cancel path: ElectrumProvider.getAddressHistoryDates
// → getAddressTransactions fans out electrumGetTransaction IPC calls in
// batches of TX_FETCH_CONCURRENCY (5); IPC calls cannot be aborted, so the
// documented contract is that the AbortSignal is checked BETWEEN batches.
// handleReset (client/src/pages/AddressChecker.tsx) sets historyCancelledRef,
// aborts historyAbortRef and bumps historyRunIdRef before wiping rows and
// pastedText — a regression there could clear the table while background
// pool workers keep fetching txs and write rows/errors/toasts back.
//
// A browser tab cannot open raw TCP, so window.electronAPI is shimmed with a
// deterministic Electrum mock (pattern from
// check-address-checker-electrum-cancel-history-browser.mjs): the first two
// addresses have a tiny 10-tx history (their walks finish before Reset), the
// rest have 400-tx histories whose per-tx fetches take ~250 ms each — with
// HISTORY_CONCURRENCY=3 pool workers a multi-minute run if not cancelled. We
// click "Load First/Last Seen (N)", wait until the pool is mid-flight, click
// Reset and assert:
//   (a) the table and textarea clear immediately,
//   (b) tx fetches stop promptly across ALL workers — flat after at most the
//       in-flight batches (≤ HISTORY_CONCURRENCY × BATCH_SIZE fetches),
//   (c) no late worker writes rows back (table stays empty over a settle
//       window ≈10 batch-lengths), no spinners/Retry buttons, no new toast,
//   (d) a fresh check + Load All works again afterwards.
//
// NOTE for reviewers: the consumer under test is
// client/src/pages/AddressChecker.tsx (route /address-checker): handleReset /
// loadHistoryForIndexes / runHistoryForAll; the abort plumbing under test
// lives in client/src/lib/providers/electrum.ts (getAddressTransactions
// signal checks between TX_FETCH_CONCURRENCY batches).
//
// Usage: node scripts/check-address-checker-electrum-reset-history-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import * as secp from '@bitcoinerlab/secp256k1';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const require = createRequire(import.meta.url);
const bitcoin = require('bitcoinjs-lib');

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'addr-checker-electrum-reset-123';

const N = 8; // pasted addresses
const SHORT_COUNT = 2; // first rows: tiny history, finish before Reset
const SHORT_TXS = 10;
const LONG_TXS = 400; // 80 batches of 5 per address — minutes if not cancelled
const TX_DELAY_MS = 250; // per-tx IPC latency so Reset lands mid-walk
const BATCH_SIZE = 5; // must match ElectrumProvider.TX_FETCH_CONCURRENCY
const POOL = 3; // must match AddressChecker HISTORY_CONCURRENCY

function genAddresses(n) {
  bitcoin.initEccLib(secp);
  const out = [];
  for (let i = 0; i < n; i++) {
    let pub;
    do {
      const priv = crypto.randomBytes(32);
      pub = secp.isPrivate(priv) ? Buffer.from(secp.pointFromScalar(priv, true)) : null;
    } while (!pub);
    out.push(bitcoin.payments.p2wpkh({ pubkey: pub, network: bitcoin.networks.bitcoin }).address);
  }
  return out;
}

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

// window.electronAPI shim installed before every page load. Each address's
// history is disjoint (txids encode a global index: addrIdx * 100000 + n) so
// the provider's transaction cache can never satisfy one walk from another.
// Every electrumGetTransaction call bumps window.__txFetches; every history
// lookup records the address in window.__walkStarts so the Node side can
// watch the pool's progress. Unknown methods resolve to a generic failure so
// unrelated Electron-only probes stay non-fatal.
function buildShim(addresses) {
  return `
(() => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const ADDRESSES = ${JSON.stringify(addresses)};
  const SHORT_COUNT = ${SHORT_COUNT};
  const SHORT_TXS = ${SHORT_TXS};
  const LONG_TXS = ${LONG_TXS};
  const TX_DELAY_MS = ${TX_DELAY_MS};
  const txidFor = (g) => g.toString(16).padStart(8, '0').repeat(8);
  const historyFor = (address) => {
    const idx = ADDRESSES.indexOf(address);
    if (idx < 0) return [];
    const count = idx < SHORT_COUNT ? SHORT_TXS : LONG_TXS;
    return Array.from({ length: count }, (_, n) => ({ tx_hash: txidFor(idx * 100000 + n), height: 800000 + n }));
  };
  window.__txFetches = 0;
  window.__walkStarts = [];
  const base = {
    isElectron: true,
    electrumTest: async () => { await delay(30); return { success: true, serverVersion: 'shim 1.4', blockHeight: 900000, latency: 30 }; },
    electrumGetHistory: async ({ address }) => {
      window.__walkStarts.push(address);
      await delay(40);
      return { success: true, history: historyFor(address) };
    },
    electrumBatchGetHistory: async ({ addresses }) => {
      await delay(20);
      return { success: true, results: addresses.map((address) => ({ address, success: true, history: historyFor(address) })) };
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
      const g = parseInt(txid.slice(0, 8), 16);
      const idx = Math.floor(g / 100000);
      const n = g % 100000;
      const addr = ADDRESSES[idx] || ADDRESSES[0];
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
          vout: [{ value: 0.001, n: 0, scriptPubKey: { address: addr, type: 'v0_p2wpkh' } }],
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
}

async function main() {
  const exe = resolveChromium();
  console.log(`[electrum-reset-history] chromium: ${exe}`);
  const addresses = genAddresses(N);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[electrum-reset-history] starting dev server (npm run dev) ...');
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
      console.log(`[electrum-reset-history] chromium launch failed (attempt ${attempt}): ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  console.log('[electrum-reset-history] chromium launched');

  const steps = [];
  const step = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(buildShim(addresses));
    const page = await context.newPage();
    const txFetches = () => page.evaluate(() => window.__txFetches || 0);
    const walkStarts = () => page.evaluate(() => Array.from(new Set(window.__walkStarts || [])).length);

    // Retry the initial load + first selector: single-shot waits flake under
    // parallel validation.
    const pwInput = page.getByTestId('input-password');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await pwInput.waitFor({ state: 'visible', timeout: 45_000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`[electrum-reset-history] initial load failed (attempt ${attempt}): ${e.message}; retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    console.log('[electrum-reset-history] app loaded, creating vault');
    await pwInput.fill(SETUP_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page.getByTestId('button-dismiss-migration').click({ timeout: 5_000 }).catch(() => {});

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
    await page.getByTestId('button-dismiss-migration').click({ timeout: 3_000 }).catch(() => {});
    const unlockPw = page.getByTestId('input-password');
    if (await unlockPw.isVisible().catch(() => false)) {
      await unlockPw.fill(SETUP_PASSWORD);
      await page.getByTestId('button-submit').click();
      await page.getByTestId('button-dismiss-migration').click({ timeout: 5_000 }).catch(() => {});
    }

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });
    await textarea.fill(addresses.join('\n'));

    // Run the check: fast tier only (batched history lengths + UTXOs — no
    // per-tx fetches yet).
    await page.getByTestId('button-run-check').click();
    const loadAllBtn = page.getByTestId('button-load-history-all');
    await loadAllBtn.waitFor({ state: 'visible', timeout: 60_000 });
    const loadAllText = (await loadAllBtn.textContent()) ?? '';
    step(`check run completes; "Load First/Last Seen (${N})" is offered`, loadAllText.includes(`(${N})`), `label="${loadAllText.trim()}"`);
    const fetchesBeforeLoad = await txFetches();
    step('fast tier fetched no per-tx data before Load All', fetchesBeforeLoad === 0, `txFetches=${fetchesBeforeLoad}`);

    // ── Start the multi-address Electrum run ────────────────────────────
    await loadAllBtn.click();
    const cancelBtn = page.getByTestId('button-cancel-history');
    await cancelBtn.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait until the pool is genuinely mid-flight: the short rows are done
    // (dates rendered) and several walks have started fetching txs.
    const doneCell = (i) => page.getByTestId(`cell-firstseen-${i}`);
    const walkStart = Date.now();
    let shortDone = false;
    let fetched = 0;
    let started = 0;
    while (Date.now() - walkStart < 60_000) {
      const t0 = ((await doneCell(0).textContent().catch(() => '')) ?? '').trim();
      const t1 = ((await doneCell(1).textContent().catch(() => '')) ?? '').trim();
      shortDone = t0.length > 1 && t1.length > 1; // idle cells render the Load button (no date text)
      fetched = await txFetches();
      started = await walkStarts();
      if (shortDone && fetched >= BATCH_SIZE * POOL * 2 && started >= SHORT_COUNT + POOL) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    step(
      'short rows finished while long walks continue (pool mid-flight)',
      shortDone && fetched >= BATCH_SIZE * POOL * 2 && started >= SHORT_COUNT + POOL,
      `started=${started} txFetches=${fetched}`,
    );
    const loadingSpinners = await page.locator('[data-testid^="text-history-scan-"]').count();
    step('multiple rows show the in-progress scan indicator mid-run', loadingSpinners >= 2, `spinners=${loadingSpinners}`);

    // Baseline of toasts already on screen (setup toasts may linger).
    const toastLoc = page.locator('li[role="status"], [data-testid^="toast"]');
    const toastsBefore = await toastLoc.count();

    // ── Reset mid-run ───────────────────────────────────────────────────
    const fetchesAtReset = await txFetches();
    const startedAtReset = await walkStarts();
    const tReset = Date.now();
    await page.getByTestId('button-reset-check').click();

    // Table and textarea must clear immediately.
    const tableRowsAfter = await page.locator('[data-testid^="cell-firstseen-"]').count();
    const resetLatency = Date.now() - tReset;
    step('result table clears immediately after Reset', tableRowsAfter === 0, `rows=${tableRowsAfter} (${resetLatency}ms after click)`);
    const textareaValue = await textarea.inputValue();
    step('textarea clears after Reset', textareaValue === '', `len=${textareaValue.length}`);
    const cancelStillVisible = await cancelBtn.isVisible().catch(() => false);
    step('Cancel button is gone (isHistoryRunning cleared)', !cancelStillVisible);

    // Tx fetches must stop across ALL pool workers. IPC calls cannot be
    // aborted, so allow the batches already dispatched at the click instant
    // (≤ POOL × BATCH_SIZE fetches); after a 0.6 s grace the count must stay
    // flat for 2.5 s (≈10 batch-lengths at the mock's cadence, so a single
    // surviving walker cannot hide).
    await new Promise((r) => setTimeout(r, 600));
    const fetchesAfterGrace = await txFetches();
    await new Promise((r) => setTimeout(r, 2500));
    const fetchesSettled = await txFetches();
    step(
      'tx fetches stop promptly across all workers (count flat over 2.5 s)',
      fetchesSettled === fetchesAfterGrace && fetchesAfterGrace - fetchesAtReset <= POOL * BATCH_SIZE,
      `atReset=${fetchesAtReset} +0.6s=${fetchesAfterGrace} +3.1s=${fetchesSettled} (uncancelled ≈ ${(N - SHORT_COUNT) * LONG_TXS + SHORT_COUNT * SHORT_TXS} fetches)`,
    );
    const startedSettled = await walkStarts();
    step(
      'no NEW walks started after Reset (started-walk set flat)',
      startedSettled - startedAtReset <= 1 && startedSettled < N,
      `atReset=${startedAtReset} settled=${startedSettled} of ${N}`,
    );

    // No late worker writes rows back: after the settle window the table is
    // still empty, no spinners, no Retry buttons, no new toast.
    const rowsSettled = await page.locator('[data-testid^="cell-firstseen-"]').count();
    step('no late worker re-populated the table (still empty after settle)', rowsSettled === 0, `rows=${rowsSettled}`);
    const spinnersSettled = await page.locator('[data-testid^="text-history-scan-"]').count();
    step('no scan-progress spinners after settle', spinnersSettled === 0, `spinners=${spinnersSettled}`);
    const retriesSettled = await page.locator('[data-testid^="button-retry-history-"]').count();
    step('no row error states after settle (no Retry buttons)', retriesSettled === 0, `retries=${retriesSettled}`);
    const textareaSettled = await textarea.inputValue();
    step('textarea stays empty after settle', textareaSettled === '', `len=${textareaSettled.length}`);
    const toastsAfter = await toastLoc.count();
    step('no new toast appeared after Reset', toastsAfter <= toastsBefore, `before=${toastsBefore} after=${toastsAfter}`);
    const loadAllGone = !(await loadAllBtn.isVisible().catch(() => false));
    step('Load All button is gone after Reset (results wiped)', loadAllGone);

    // ── The page must be reusable: run a fresh check + Load All again ───
    await textarea.fill(addresses.slice(0, 3).join('\n'));
    await page.getByTestId('button-run-check').click();
    const loadAllBtn2 = page.getByTestId('button-load-history-all');
    await loadAllBtn2.waitFor({ state: 'visible', timeout: 60_000 });
    step('a fresh check runs after Reset (Load All offered again)', true);
    const fetchesBeforeRerun = await txFetches();
    await loadAllBtn2.click();
    const rerunStart = Date.now();
    let fetchesAfterRerun = fetchesBeforeRerun;
    while ((fetchesAfterRerun = await txFetches()) <= fetchesBeforeRerun && Date.now() - rerunStart < 15_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    step('Load All works again after Reset (new walk fetches transactions)', fetchesAfterRerun > fetchesBeforeRerun, `txFetches=${fetchesAfterRerun}`);
    await page.getByTestId('button-cancel-history').click().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  if (failed.length) {
    console.error(`[electrum-reset-history] ${failed.length}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`[electrum-reset-history] all ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error('[electrum-reset-history] FAILED:', e);
  process.exit(1);
});
