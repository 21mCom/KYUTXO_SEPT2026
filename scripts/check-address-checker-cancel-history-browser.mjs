#!/usr/bin/env node
// Task 1905 real-browser check: the Address Checker's Cancel button must
// actually stop a long in-flight First/Last Seen history walk.
//
// The Cancel wiring threads an AbortSignal from AddressChecker
// (handleCancelHistory / historyAbortRef) through
// getAddressHistoryDates -> rateLimitedFetch, so clicking Cancel mid-walk
// aborts the current page fetch and stops further pagination promptly.
// Unit tests cover the provider-level abort; this check pins the end-to-end
// browser wiring: a mock Esplora (mempool.space intercepted via Playwright
// routes) serves a 5,000-tx history (200 pages, ~400 ms each). We start the
// on-demand history load for one address, wait a few pages, click Cancel and
// assert (a) page fetches stop promptly — nowhere near the 200-page total —
// and (b) the row's First Seen cell reverts to the idle Load button (not
// stuck on the spinner, not an error Retry).
//
// NOTE for reviewers: the consumer under test is
// client/src/pages/AddressChecker.tsx (route /address-checker); the abort
// plumbing lives in client/src/lib/providers/esplora-base.ts.
//
// Usage: node scripts/check-address-checker-cancel-history-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'addr-checker-cancel-history-123';
// Valid mainnet P2WPKH address (BIP-173 test vector) — the row under test.
const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const TX_COUNT = 5000; // 200 pages of 25 — a multi-minute walk if not cancelled
const PAGE_SIZE = 25;
const PAGE_DELAY_MS = 400; // per-page latency so Cancel lands mid-walk

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

// Deterministic fake txid for global tx index n.
const txidFor = (n) => n.toString(16).padStart(8, '0').repeat(8);

function txPage(startIdx) {
  const txs = [];
  const end = Math.min(startIdx + PAGE_SIZE, TX_COUNT);
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
  console.log(`[cancel-history] chromium: ${exe}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[cancel-history] starting dev server (npm run dev) ...');
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
      console.log(`[cancel-history] chromium launch failed (attempt ${attempt}): ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  console.log('[cancel-history] chromium launched');

  const steps = [];
  const step = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // Node-side counters, bumped as intercepted requests ARRIVE (so an aborted
  // in-flight request still counts, but no post-cancel request can hide).
  let statsFetches = 0;
  let pageFetches = 0;

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();

    // Intercept the mock Esplora provider. GET requests are CORS-simple; the
    // fulfilled responses add allow-origin so the page's fetch() can read them.
    await context.route('**://mempool.space/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
      try {
        if (path === `/api/address/${ADDRESS}`) {
          statsFetches++;
          await route.fulfill({
            status: 200,
            headers,
            body: JSON.stringify({
              chain_stats: { tx_count: TX_COUNT, funded_txo_sum: 100_000_000, spent_txo_sum: 40_000_000 },
              mempool_stats: { tx_count: 0 },
            }),
          });
          return;
        }
        if (path === `/api/address/${ADDRESS}/txs` || path.startsWith(`/api/address/${ADDRESS}/txs/chain/`)) {
          pageFetches++;
          const mine = pageFetches;
          let startIdx = 0;
          const m = path.match(/\/txs\/chain\/([0-9a-f]{64})$/);
          if (m) startIdx = parseInt(m[1].slice(0, 8), 16) + 1;
          await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
          await route.fulfill({ status: 200, headers, body: JSON.stringify(txPage(startIdx)) });
          if (mine <= 3) console.log(`[cancel-history] served history page #${mine} (start=${startIdx})`);
          return;
        }
        await route.fulfill({ status: 404, headers, body: '"not mocked"' });
      } catch {
        // Aborted mid-fulfill (client cancelled) — expected after Cancel.
      }
    });

    // Retry the initial load + first selector: single-shot waits flake under
    // parallel validation.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await waitForLoginScreenVisible(page, { timeoutMs: 45_000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`[cancel-history] initial load failed (attempt ${attempt}): ${e.message}; retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    console.log('[cancel-history] app loaded, creating vault');
    await unlockIfNeeded(page, SETUP_PASSWORD);

    // Seed HTTP (mempool.space) node settings so the checker uses the
    // Esplora fetch path this check intercepts — no Electrum, no Tor.
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
    await unlockIfNeeded(page, SETUP_PASSWORD);

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });
    await textarea.fill(ADDRESS);

    // Run the check: fast tier only (one stats call, no history pages).
    await page.getByTestId('button-run-check').click();
    const loadBtn = page.getByTestId(`button-load-history-${ADDRESS}`);
    await loadBtn.waitFor({ state: 'visible', timeout: 30_000 });
    step('check run completes; First Seen cell shows the idle Load button', true, `statsFetches=${statsFetches}`);
    step('fast tier fetched no history pages before Load is clicked', pageFetches === 0, `pageFetches=${pageFetches}`);

    // Start the long on-demand history walk.
    await loadBtn.click();
    const cancelBtn = page.getByTestId('button-cancel-history');
    await cancelBtn.waitFor({ state: 'visible', timeout: 10_000 });

    // Let the walk get well underway: wait until several pages were fetched.
    const walkStart = Date.now();
    while (pageFetches < 3 && Date.now() - walkStart < 30_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    step('history walk is paginating (≥3 page fetches before Cancel)', pageFetches >= 3, `pageFetches=${pageFetches}`);
    const spinnerVisible = await page.getByTestId(`text-history-scan-${ADDRESS}`).isVisible().catch(() => false);
    step('row shows the in-progress scan indicator mid-walk', spinnerVisible);

    // ── Cancel mid-walk ──────────────────────────────────────────────────
    const fetchesAtCancel = pageFetches;
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

    // No FURTHER page fetches after Cancel settles. Allow at most one page
    // that was already being dispatched at the instant of the click; then the
    // count must be flat for a window several pages long (2.5 s ≈ 6 pages at
    // the mock's cadence, so continued pagination cannot hide).
    await new Promise((r) => setTimeout(r, 500));
    const fetchesAfterGrace = pageFetches;
    await new Promise((r) => setTimeout(r, 2500));
    const fetchesSettled = pageFetches;
    step(
      'no further page fetches after Cancel (count flat over 2.5 s window)',
      fetchesSettled === fetchesAfterGrace && fetchesAfterGrace - fetchesAtCancel <= 1,
      `atCancel=${fetchesAtCancel} +0.5s=${fetchesAfterGrace} +3s=${fetchesSettled} (uncancelled walk = ${TX_COUNT / PAGE_SIZE} pages)`,
    );
    step(
      'walk stopped far short of the full history (abort was prompt, not end-of-walk)',
      fetchesSettled < 15,
      `pages fetched=${fetchesSettled} of ${TX_COUNT / PAGE_SIZE}`,
    );

    // The row must be re-loadable: clicking Load again starts a fresh walk.
    await loadBtn.click();
    const restartStart = Date.now();
    while (pageFetches <= fetchesSettled && Date.now() - restartStart < 15_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    step('Load works again after Cancel (new walk fetches pages)', pageFetches > fetchesSettled, `pageFetches=${pageFetches}`);
    await page.getByTestId('button-cancel-history').click().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  if (failed.length) {
    console.error(`[cancel-history] ${failed.length}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`[cancel-history] all ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error('[cancel-history] FAILED:', e);
  process.exit(1);
});
