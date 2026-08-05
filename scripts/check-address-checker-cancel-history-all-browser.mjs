#!/usr/bin/env node
// Task 1933 real-browser check: Cancel must stop a "Load First/Last Seen (N)"
// MULTI-address history run promptly.
//
// runHistoryForAll (client/src/pages/AddressChecker.tsx) fans per-row history
// walks through a bounded worker pool (HISTORY_CONCURRENCY = 3). Cancel there
// must BOTH abort the concurrent in-flight walks (shared AbortSignal) AND stop
// the pool from dispatching new rows, reverting every loading row to the idle
// Load button while rows that already finished keep their dates.
//
// Setup: 12 valid addresses pasted; a mock Esplora (mempool.space intercepted
// via Playwright routes) serves the fast-tier stats plus per-address paginated
// histories. The first two addresses have a tiny 10-tx history (finish fast →
// become "done" rows before Cancel); the rest have 5,000-tx histories (200
// pages, ~400 ms each — multi-minute walks if not cancelled). We click
// "Load First/Last Seen (12)", wait until the pool is mid-flight (short rows
// done, several long walks paginating), click Cancel and assert:
//   (a) page fetches stop promptly across ALL workers (count flat, far short
//       of the full walk),
//   (b) no new rows enter loading after Cancel (first-page fetch set flat),
//   (c) every loading row reverts to the idle Load button (no spinner/Retry),
//   (d) done rows keep their First/Last Seen dates,
//   (e) Load All works again afterwards.
//
// NOTE for reviewers: the consumer under test is
// client/src/pages/AddressChecker.tsx (route /address-checker):
// runHistoryForAll / loadHistoryForIndexes / handleCancelHistory; the abort
// plumbing lives in client/src/lib/providers/esplora-base.ts.
//
// Usage: node scripts/check-address-checker-cancel-history-all-browser.mjs

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
const SETUP_PASSWORD = 'addr-checker-cancel-all-123';

const N = 12; // pasted addresses
const SHORT_COUNT = 2; // first rows: tiny history, finish before Cancel
const SHORT_TXS = 10; // single page (<25) → walk ends after one fetch
const LONG_TXS = 5000; // 200 pages of 25 — multi-minute walk if not cancelled
const PAGE_SIZE = 25;
const LONG_PAGE_DELAY_MS = 400; // per-page latency so Cancel lands mid-walk
const SHORT_PAGE_DELAY_MS = 50;

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

// Deterministic fake txid encoding the global tx index n.
const txidFor = (n) => n.toString(16).padStart(8, '0').repeat(8);

function txPage(startIdx, totalTxs) {
  const txs = [];
  const end = Math.min(startIdx + PAGE_SIZE, totalTxs);
  for (let n = startIdx; n < end; n++) {
    txs.push({
      txid: txidFor(n),
      status: { confirmed: true, block_height: 900000 - n, block_time: 1700000000 - n * 600 },
      vin: [],
      vout: [],
    });
  }
  return txs;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[cancel-history-all] chromium: ${exe}`);
  const addresses = genAddresses(N);
  const isShort = (addr) => addresses.indexOf(addr) >= 0 && addresses.indexOf(addr) < SHORT_COUNT;

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[cancel-history-all] starting dev server (npm run dev) ...');
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
      console.log(`[cancel-history-all] chromium launch failed (attempt ${attempt}): ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  console.log('[cancel-history-all] chromium launched');

  const steps = [];
  const step = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // Node-side counters, bumped as intercepted requests ARRIVE (an aborted
  // in-flight request still counts, no post-cancel request can hide).
  let statsFetches = 0;
  let pageFetches = 0;
  // Addresses whose walk has STARTED (first, non-/chain/ history page seen).
  // Growth of this set after Cancel = the pool dispatched a NEW row.
  const startedWalks = new Set();

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();

    await context.route('**://mempool.space/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
      try {
        let m = path.match(/^\/api\/address\/([a-z0-9]+)$/);
        if (m && addresses.includes(m[1])) {
          statsFetches++;
          const total = isShort(m[1]) ? SHORT_TXS : LONG_TXS;
          await route.fulfill({
            status: 200,
            headers,
            body: JSON.stringify({
              chain_stats: { tx_count: total, funded_txo_sum: 100_000_000, spent_txo_sum: 40_000_000 },
              mempool_stats: { tx_count: 0 },
            }),
          });
          return;
        }
        m = path.match(/^\/api\/address\/([a-z0-9]+)\/txs(?:\/chain\/([0-9a-f]{64}))?$/);
        if (m && addresses.includes(m[1])) {
          pageFetches++;
          const addr = m[1];
          const short = isShort(addr);
          if (!m[2]) startedWalks.add(addr);
          const startIdx = m[2] ? parseInt(m[2].slice(0, 8), 16) + 1 : 0;
          await new Promise((r) => setTimeout(r, short ? SHORT_PAGE_DELAY_MS : LONG_PAGE_DELAY_MS));
          await route.fulfill({ status: 200, headers, body: JSON.stringify(txPage(startIdx, short ? SHORT_TXS : LONG_TXS)) });
          return;
        }
        await route.fulfill({ status: 404, headers, body: '"not mocked"' });
      } catch {
        // Aborted mid-fulfill (client cancelled) — expected after Cancel.
      }
    });

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
        console.log(`[cancel-history-all] initial load failed (attempt ${attempt}): ${e.message}; retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    console.log('[cancel-history-all] app loaded, creating vault');
    await pwInput.fill(SETUP_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page.getByTestId('button-dismiss-migration').click({ timeout: 5_000 }).catch(() => {});

    // Seed HTTP (mempool.space) node settings so the checker uses the Esplora
    // fetch path this check intercepts — no Electrum, no Tor.
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
        useElectrum: false,
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

    // Run the check: fast tier only (stats calls, no history pages).
    await page.getByTestId('button-run-check').click();
    const loadAllBtn = page.getByTestId('button-load-history-all');
    await loadAllBtn.waitFor({ state: 'visible', timeout: 60_000 });
    const loadAllText = (await loadAllBtn.textContent()) ?? '';
    step(`check run completes; "Load First/Last Seen (${N})" is offered`, loadAllText.includes(`(${N})`), `label="${loadAllText.trim()}" statsFetches=${statsFetches}`);
    step('fast tier fetched no history pages before Load All is clicked', pageFetches === 0, `pageFetches=${pageFetches}`);

    // ── Start the multi-address run ─────────────────────────────────────
    await loadAllBtn.click();
    const cancelBtn = page.getByTestId('button-cancel-history');
    await cancelBtn.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait until the pool is genuinely mid-flight: the short rows are done
    // (dates rendered) and long walks have fetched several pages, with more
    // rows started than a single worker could account for.
    const doneCell = (i) => page.getByTestId(`cell-firstseen-${i}`);
    const walkStart = Date.now();
    let shortDone = false;
    while (Date.now() - walkStart < 60_000) {
      const t0 = ((await doneCell(0).textContent().catch(() => '')) ?? '').trim();
      const t1 = ((await doneCell(1).textContent().catch(() => '')) ?? '').trim();
      shortDone = t0.length > 1 && t1.length > 1; // idle cells render the Load button (no date text)
      if (shortDone && pageFetches >= 8 && startedWalks.size >= 5) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    step('short rows finished (First Seen dates rendered) while long walks continue', shortDone);
    step('pool is fanning out (≥5 rows started, ≥8 page fetches before Cancel)', startedWalks.size >= 5 && pageFetches >= 8, `started=${startedWalks.size} pageFetches=${pageFetches}`);

    const loadingSpinners = await page.locator('[data-testid^="text-history-scan-"]').count();
    step('multiple rows show the in-progress scan indicator mid-run', loadingSpinners >= 2, `spinners=${loadingSpinners}`);

    const doneDatesBefore = [
      ((await doneCell(0).textContent()) ?? '').trim(),
      ((await doneCell(1).textContent()) ?? '').trim(),
    ];

    // ── Cancel mid-run ──────────────────────────────────────────────────
    const fetchesAtCancel = pageFetches;
    const startedAtCancel = startedWalks.size;
    const tCancel = Date.now();
    await cancelBtn.click();

    // Every loading row must revert to the idle Load button promptly: the
    // Load All button reappears (canLoadHistory) and no spinner remains.
    await loadAllBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const revertLatency = Date.now() - tCancel;
    step('Load All button returns after Cancel (run left the running state)', true, `${revertLatency}ms after click`);
    step('Cancel reverts promptly (< 3 s)', revertLatency < 3000, `${revertLatency}ms`);

    const spinnersAfter = await page.locator('[data-testid^="text-history-scan-"]').count();
    step('no scan-progress spinners remain after Cancel', spinnersAfter === 0, `spinners=${spinnersAfter}`);
    const retriesAfter = await page.locator('[data-testid^="button-retry-history-"]').count();
    step('no row was left in an error state (no Retry buttons)', retriesAfter === 0, `retries=${retriesAfter}`);
    const cancelStillVisible = await cancelBtn.isVisible().catch(() => false);
    step('Cancel button is gone (isHistoryRunning cleared)', !cancelStillVisible);

    // All not-done rows show the idle per-row Load button again.
    const idleLoadButtons = await page.locator('[data-testid^="button-load-history-"]:not([data-testid="button-load-history-all"])').count();
    step(`all ${N - SHORT_COUNT} cancelled rows revert to the idle Load button`, idleLoadButtons === N - SHORT_COUNT, `idle Load buttons=${idleLoadButtons}`);
    const loadAllTextAfter = ((await loadAllBtn.textContent()) ?? '').trim();
    step(`Load All count reflects only the reverted rows (${N - SHORT_COUNT})`, loadAllTextAfter.includes(`(${N - SHORT_COUNT})`), `label="${loadAllTextAfter}"`);

    // Done rows keep their dates.
    const doneDatesAfter = [
      ((await doneCell(0).textContent()) ?? '').trim(),
      ((await doneCell(1).textContent()) ?? '').trim(),
    ];
    step(
      'done rows keep their First Seen dates after Cancel',
      doneDatesAfter[0] === doneDatesBefore[0] && doneDatesAfter[1] === doneDatesBefore[1] && doneDatesAfter[0].length > 1,
      `before=${JSON.stringify(doneDatesBefore)} after=${JSON.stringify(doneDatesAfter)}`,
    );

    // Fetches must stop across ALL workers. Allow up to HISTORY_CONCURRENCY
    // requests that were already being dispatched at the click instant; after
    // a 0.5 s grace the count must stay flat for 2.5 s (≈6 page-lengths at the
    // mock's cadence, so a single surviving walker cannot hide).
    await new Promise((r) => setTimeout(r, 500));
    const fetchesAfterGrace = pageFetches;
    await new Promise((r) => setTimeout(r, 2500));
    const fetchesSettled = pageFetches;
    step(
      'page fetches stop promptly across all workers (count flat over 2.5 s)',
      fetchesSettled === fetchesAfterGrace && fetchesAfterGrace - fetchesAtCancel <= 3,
      `atCancel=${fetchesAtCancel} +0.5s=${fetchesAfterGrace} +3s=${fetchesSettled} (uncancelled ≈ ${(N - SHORT_COUNT) * (LONG_TXS / PAGE_SIZE)} pages)`,
    );
    step(
      'no NEW rows entered loading after Cancel (started-walk set flat)',
      startedWalks.size - startedAtCancel <= 1 && startedWalks.size < N,
      `startedAtCancel=${startedAtCancel} settled=${startedWalks.size} of ${N}`,
    );
    step(
      'run stopped far short of the full multi-address walk',
      fetchesSettled < 40,
      `pages fetched=${fetchesSettled}`,
    );

    // The run must be restartable: Load All again starts fresh walks.
    await loadAllBtn.click();
    const restartStart = Date.now();
    while (pageFetches <= fetchesSettled && Date.now() - restartStart < 15_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    step('Load All works again after Cancel (new walk fetches pages)', pageFetches > fetchesSettled, `pageFetches=${pageFetches}`);
    await page.getByTestId('button-cancel-history').click().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  if (failed.length) {
    console.error(`[cancel-history-all] ${failed.length}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`[cancel-history-all] all ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error('[cancel-history-all] FAILED:', e);
  process.exit(1);
});
