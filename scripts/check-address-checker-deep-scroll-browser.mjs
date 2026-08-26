#!/usr/bin/env node
// Task 1772 real-browser check: Address Checker deep-scroll accuracy with
// variable-height rows.
//
// The results table uses dynamic row measurement
// (rowVirtualizer.measureElement + data-index) so rows taller than the 53px
// estimate (wrapped badges, history-error Retry rows) no longer skew deep
// scroll offsets. This check forces ~25% of rows to be much taller than the
// estimate (extra padding on funded rows via an injected stylesheet — the
// virtualizer measures real DOM heights, so the cause of the extra height is
// irrelevant), scrolls deep, and asserts:
//   - measured tall rows actually render taller than the estimate
//   - the total scroll height reflects the measured (not estimated) sizes
//   - at max scroll the LAST row (index N-1) is rendered flush with the list
//     bottom (no phantom gap / missing rows)
//   - visible rows tile contiguously with no gaps or overlaps at deep and
//     mid-deep positions
//   - scrollTop stays stable at rest (no scrollbar jump from re-measurement)
//
// Rendering-path only: window.electronAPI is shimmed exactly like
// scripts/check-address-checker-5k-browser.mjs.
//
// Usage: node scripts/check-address-checker-deep-scroll-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import * as secp from '@bitcoinerlab/secp256k1';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const require = createRequire(import.meta.url);
const bitcoin = require('bitcoinjs-lib');

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'addr-checker-deepscroll-123';
// Small enough that the shimmed run completes quickly, large enough that the
// bottom of the list is far beyond anything initially measured.
const N = Number(process.env.N || 1500);
const ROW_ESTIMATE = 53; // must match ROW_ESTIMATE in AddressChecker.tsx
// Extra vertical padding injected on funded rows. 44px top + 44px bottom
// makes those rows ~2.5x the estimate.
const TALL_PAD = 44;

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

// Mirrors the shim's funded rule below: charCodeAt(len-2) % 4 === 0.
const isFunded = (addr) => addr.charCodeAt(addr.length - 2) % 4 === 0;

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

// Same deterministic Electrum shim as the 5k check (see that script for the
// rationale). Funded rule must stay in sync with isFunded above.
const SHIM = `
(() => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = {
    isElectron: true,
    electrumTest: async () => { await delay(30); return { success: true, serverVersion: 'shim 1.4', blockHeight: 900000, latency: 30 }; },
    electrumGetHistory: async ({ address }) => {
      await delay(25);
      const n = address.charCodeAt(address.length - 1) % 3;
      return { success: true, history: Array.from({ length: n }, (_, k) => ({ tx_hash: 'f'.repeat(63) + k, height: 800000 + k })) };
    },
    electrumBatchGetHistory: async ({ addresses }) => {
      await delay(2 * addresses.length);
      return {
        success: true,
        results: addresses.map((address) => ({
          address,
          success: true,
          history: Array.from({ length: address.charCodeAt(address.length - 1) % 3 }, (_, k) => ({ tx_hash: 'e'.repeat(63) + k, height: 800000 + k })),
        })),
      };
    },
    electrumGetUtxos: async ({ address }) => {
      await delay(12);
      const funded = address.charCodeAt(address.length - 2) % 4 === 0;
      return { success: true, utxos: funded ? [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 12345, height: 800000 }] : [] };
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

// In-page helper: inspect the virtualized table state around the current
// scroll position. Returns visible-row tiling info relative to the scroller
// viewport.
const INSPECT = `
(() => {
  const scroller = document.querySelector('.flex-1.overflow-y-auto.p-6');
  if (!scroller) return { error: 'scroller not found' };
  const rows = Array.from(document.querySelectorAll('tbody tr[data-index]'))
    .map((el) => ({
      index: Number(el.getAttribute('data-index')),
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
      height: el.getBoundingClientRect().height,
    }))
    .sort((a, b) => a.index - b.index);
  const view = scroller.getBoundingClientRect();
  // Tiling: consecutive rendered indices must butt up against each other.
  let maxGap = 0;
  let indexHoles = 0;
  for (let k = 1; k < rows.length; k++) {
    if (rows[k].index !== rows[k - 1].index + 1) { indexHoles++; continue; }
    maxGap = Math.max(maxGap, Math.abs(rows[k].top - rows[k - 1].bottom));
  }
  // Viewport coverage: the union of rendered rows must span the visible
  // window (headers/spacers above the table are outside the row range only
  // when scrolled into the list).
  const first = rows[0];
  const last = rows[rows.length - 1];
  const table = document.querySelector('tbody');
  const tableBottom = table ? table.getBoundingClientRect().bottom : NaN;
  return {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    viewTop: view.top,
    viewBottom: view.bottom,
    rowCount: rows.length,
    firstIndex: first?.index,
    lastIndex: last?.index,
    firstTop: first?.top,
    lastBottom: last?.bottom,
    tableBottom,
    maxGap,
    indexHoles,
    maxRowHeight: Math.max(...rows.map((r) => r.height)),
    minRowHeight: Math.min(...rows.map((r) => r.height)),
  };
})()
`;

async function main() {
  const exe = resolveChromium();
  console.log(`[addr-checker-deep-scroll] chromium: ${exe}, N=${N}`);
  const addresses = genAddresses(N);
  const fundedCount = addresses.filter(isFunded).length;
  console.log(`[addr-checker-deep-scroll] funded (tall) rows: ${fundedCount}/${N}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[addr-checker-deep-scroll] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
    if (!(await waitForServer(BASE_URL, 90_000))) throw new Error('Dev server not ready in 90s');
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under load.
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
      console.log(`[addr-checker-deep-scroll] chromium launch failed (attempt ${attempt}): ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }

  const steps = [];
  const step = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(SHIM);
    const page = await context.newPage();

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await waitForLoginScreenVisible(page, { timeoutMs: 45_000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`[addr-checker-deep-scroll] initial load failed (attempt ${attempt}): ${e.message}; retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // Create the vault.
    await unlockIfNeeded(page, SETUP_PASSWORD);

    // Seed Electrum node settings via the Vite-singleton CRUD module.
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

    await page.goto(BASE_URL + '#/address-checker', { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
    if (!(await page.getByTestId('textarea-address-input').isVisible().catch(() => false))) {
      await page.goto(`http://localhost:${PORT}/address-checker`, { waitUntil: 'load', timeout: 60_000 });
      await unlockIfNeeded(page, SETUP_PASSWORD);
    }

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });

    // Force funded rows well past the 53px estimate. The virtualizer measures
    // real rendered heights, so extra padding is as good as wrapped content.
    await page.addStyleTag({
      content: `tr[data-funded="true"] td { padding-top: ${TALL_PAD}px !important; padding-bottom: ${TALL_PAD}px !important; }`,
    });

    // Paste addresses and run the check to completion.
    await textarea.evaluate((el, text) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, addresses.join('\n'));
    await page.getByTestId('button-run-check').click();
    await page.getByTestId('alert-check-complete').waitFor({ state: 'visible', timeout: 180_000 });
    step('run completed', true, `${N} addresses`);

    const scrollTo = async (top) => {
      await page.evaluate((t) => {
        const scroller = document.querySelector('.flex-1.overflow-y-auto.p-6');
        scroller.scrollTop = t;
      }, top);
      // Let the virtualizer render + measure + settle (a couple of frames
      // plus any measurement-driven correction).
      await page.waitForTimeout(400);
    };
    const inspect = () => page.evaluate(INSPECT);

    // ── Tall rows actually measure taller than the estimate ─────────────
    await scrollTo(0);
    let s = await inspect();
    if (s.error) throw new Error(s.error);
    // Tall (funded) rows must render meaningfully taller than base rows —
    // this is the variable-height precondition the whole check exists for.
    step(
      'tall rows render well above the 53px estimate, alongside normal rows',
      s.maxRowHeight >= ROW_ESTIMATE + TALL_PAD && s.maxRowHeight - s.minRowHeight >= TALL_PAD,
      `minRowHeight=${s.minRowHeight?.toFixed(1)} maxRowHeight=${s.maxRowHeight?.toFixed(1)}`,
    );

    // Note: the virtualizer only measures VISITED rows — getTotalSize() keeps
    // the 53px estimate for never-rendered rows, so a global scrollHeight
    // assertion is meaningless. Offset accuracy is asserted locally instead
    // (flush bottom, contiguous tiling, exact anchor displacement below).
    await scrollTo(10 ** 9); // clamp to bottom → last rows rendered + measured
    await page.waitForTimeout(400);
    s = await inspect();

    // ── Bottom of the list: last row present and flush with list end ────
    const atBottom = s;
    step(
      'at max scroll the last row (index N-1) is rendered',
      atBottom.lastIndex === N - 1,
      `lastIndex=${atBottom.lastIndex} expected=${N - 1}`,
    );
    step(
      'last row sits flush with the table bottom (no phantom gap)',
      Math.abs(atBottom.lastBottom - atBottom.tableBottom) <= 2,
      `lastBottom=${atBottom.lastBottom?.toFixed(1)} tableBottom=${atBottom.tableBottom?.toFixed(1)}`,
    );
    step(
      'scrolled to true bottom (scrollTop + clientHeight ≈ scrollHeight)',
      Math.abs(atBottom.scrollTop + atBottom.clientHeight - atBottom.scrollHeight) <= 2,
      `scrollTop=${atBottom.scrollTop?.toFixed(1)} clientHeight=${atBottom.clientHeight} scrollHeight=${atBottom.scrollHeight}`,
    );
    step(
      'rows tile contiguously at the bottom (no gaps/overlaps/index holes)',
      atBottom.indexHoles === 0 && atBottom.maxGap <= 1.5,
      `indexHoles=${atBottom.indexHoles} maxGap=${atBottom.maxGap?.toFixed(2)}px over ${atBottom.rowCount} rows`,
    );

    // ── scrollTop stays stable at rest (no scrollbar jump) ──────────────
    const restTop = atBottom.scrollTop;
    await page.waitForTimeout(900);
    s = await inspect();
    step(
      'scrollTop stable at rest at the bottom (no re-measurement jump)',
      Math.abs(s.scrollTop - restTop) <= 1,
      `scrollTop ${restTop?.toFixed(1)} → ${s.scrollTop?.toFixed(1)}`,
    );

    // ── Exact offset accuracy through tall rows ──────────────────────────
    // Scroll up by exactly one viewport height from the bottom. Every still-
    // rendered row (overscan keeps the old window mounted) must shift down by
    // exactly that amount — if tall-row offsets were skewed, the anchor would
    // land somewhere else.
    const bottomAnchorIndex = s.firstIndex;
    const bottomAnchorTop = s.firstTop;
    const upBy = s.clientHeight;
    await scrollTo(s.scrollTop - upBy);
    const anchorAfterUp = await page.evaluate((idx) => {
      const el = document.querySelector(`tbody tr[data-index="${idx}"]`);
      return el ? el.getBoundingClientRect().top : null;
    }, bottomAnchorIndex);
    step(
      'anchor row shifts by exactly the scrolled distance (offsets accurate through tall rows)',
      anchorAfterUp !== null && Math.abs(anchorAfterUp - (bottomAnchorTop + upBy)) <= 2,
      `anchor[${bottomAnchorIndex}] top ${bottomAnchorTop?.toFixed(1)} → ${anchorAfterUp?.toFixed(1)} (expected ${(bottomAnchorTop + upBy).toFixed(1)})`,
    );

    // ── Mid-deep position: viewport fully covered, anchor row stable ────
    const midTarget = Math.floor(s.scrollHeight * 0.6);
    await scrollTo(midTarget);
    const mid = await inspect();
    step(
      'mid-deep viewport fully covered by rendered rows (no blank window)',
      mid.firstTop <= mid.viewTop + 1 && mid.lastBottom >= mid.viewBottom - 1,
      `firstTop=${mid.firstTop?.toFixed(1)} viewTop=${mid.viewTop?.toFixed(1)} lastBottom=${mid.lastBottom?.toFixed(1)} viewBottom=${mid.viewBottom?.toFixed(1)}`,
    );
    step(
      'rows tile contiguously mid-deep (no gaps/overlaps/index holes)',
      mid.indexHoles === 0 && mid.maxGap <= 1.5,
      `indexHoles=${mid.indexHoles} maxGap=${mid.maxGap?.toFixed(2)}px over ${mid.rowCount} rows`,
    );
    // Anchor stability at rest: the same first row must stay at the same
    // viewport offset with no further programmatic scrolling.
    const anchorIndex = mid.firstIndex;
    const anchorTop = mid.firstTop;
    const midRest = mid.scrollTop;
    await page.waitForTimeout(900);
    const mid2 = await inspect();
    const anchorRow = await page.evaluate((idx) => {
      const el = document.querySelector(`tbody tr[data-index="${idx}"]`);
      return el ? el.getBoundingClientRect().top : null;
    }, anchorIndex);
    step(
      'mid-deep scrollTop + anchor row stable at rest',
      Math.abs(mid2.scrollTop - midRest) <= 1 && anchorRow !== null && Math.abs(anchorRow - anchorTop) <= 1,
      `scrollTop ${midRest?.toFixed(1)} → ${mid2.scrollTop?.toFixed(1)}, anchor[${anchorIndex}] top ${anchorTop?.toFixed(1)} → ${anchorRow?.toFixed(1)}`,
    );

    // ── Upward scroll through unmeasured territory stays coherent ───────
    // Step upward from mid-deep; after each settle the viewport must be
    // covered with contiguous rows (the user-facing symptom of broken
    // dynamic measurement is blank windows / jumbled rows while scrolling
    // up through rows measured taller than estimated).
    let upFailures = 0;
    let pos = mid2.scrollTop;
    for (let k = 0; k < 5 && pos > 0; k++) {
      pos = Math.max(0, pos - 900);
      await scrollTo(pos);
      const u = await inspect();
      const covered = u.firstTop <= u.viewTop + 1 && u.lastBottom >= u.viewBottom - 1;
      if (!covered || u.indexHoles !== 0 || u.maxGap > 1.5) upFailures++;
    }
    step('upward deep-scroll keeps viewport covered and contiguous', upFailures === 0, `failures=${upFailures}/5 steps`);

    // ── Task 1786: toggling "Hide 0-transaction addresses" after a deep ──
    // scroll must not scramble cached row heights. Hiding shifts virtualizer
    // item indices; getItemKey keys measurements by ORIGINAL row index, so a
    // regression (keying by index) would reapply a tall row's cached height
    // to a different row — visible as tiling gaps/overlaps, a wrong-height
    // row, or a skewed bottom offset.
    //
    // Shim rules are independent: zero-tx rows are charCodeAt(len-1)%3===0,
    // tall (funded) rows are charCodeAt(len-2)%4===0 — so hiding removes a
    // mix of tall and short rows and every surviving index shifts.
    const expectedHidden = addresses.filter((a) => a.charCodeAt(a.length - 1) % 3 === 0).length;
    const shownAfterHide = N - expectedHidden;

    // Park mid-deep (~40% of the ORIGINAL scroll height) so plenty of rows
    // above/below are measured, and the position stays valid after ~1/3 of
    // rows are removed (no scrollTop clamping to muddy the stability assert).
    let full = await inspect();
    await scrollTo(Math.floor(full.scrollHeight * 0.4));
    const preToggle = await inspect();

    // Toggle via a direct DOM click: Playwright's locator click would first
    // scroll the checkbox (near the page top) into view, destroying the deep
    // scroll position this assertion is about.
    const toggleHideZeroTx = () =>
      page.evaluate(() => document.querySelector('[data-testid="checkbox-hide-zero-tx"]').click());
    await toggleHideZeroTx();
    await page.getByTestId('text-hidden-count').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(500);

    const hiddenText = await page.getByTestId('text-hidden-count').textContent();
    step(
      'hide toggle removed exactly the 0-tx rows',
      hiddenText !== null && hiddenText.replace(/[^0-9]/g, '') === String(expectedHidden),
      `hidden-count="${hiddenText?.trim()}" expected=${expectedHidden}`,
    );

    const afterHide = await inspect();
    // Tolerance: removing rows above the viewport triggers a small (~few px)
    // measurement-driven correction; a key-scramble regression skews offsets
    // by whole row heights (50-120px+), far outside this bound.
    step(
      'scrollTop stable across hide toggle (no scrollbar jump)',
      Math.abs(afterHide.scrollTop - preToggle.scrollTop) <= 8,
      `scrollTop ${preToggle.scrollTop?.toFixed(1)} → ${afterHide.scrollTop?.toFixed(1)}`,
    );
    step(
      'rows tile contiguously after hiding (no gaps/overlaps/index holes)',
      afterHide.indexHoles === 0 && afterHide.maxGap <= 1.5,
      `indexHoles=${afterHide.indexHoles} maxGap=${afterHide.maxGap?.toFixed(2)}px over ${afterHide.rowCount} rows`,
    );
    step(
      'viewport fully covered after hiding (no blank window)',
      afterHide.firstTop <= afterHide.viewTop + 1 && afterHide.lastBottom >= afterHide.viewBottom - 1,
      `firstTop=${afterHide.firstTop?.toFixed(1)} viewTop=${afterHide.viewTop?.toFixed(1)} lastBottom=${afterHide.lastBottom?.toFixed(1)} viewBottom=${afterHide.viewBottom?.toFixed(1)}`,
    );

    // Per-row height/identity check: after the index shift, every rendered
    // row's DOM height must match ITS OWN identity (tall iff funded) — and
    // since tiling is contiguous (asserted above), the virtualizer's cached
    // sizes agree with those correct DOM heights. A key-by-index regression
    // would instead misplace offsets and break the tiling/flush asserts.
    const heightCheck = await page.evaluate(({ pad, est }) => {
      const rows = Array.from(document.querySelectorAll('tbody tr[data-index]'));
      let tallOk = 0, shortOk = 0, mismatches = [];
      for (const el of rows) {
        const h = el.getBoundingClientRect().height;
        const funded = el.getAttribute('data-funded') === 'true';
        if (funded) {
          if (h >= est + pad) tallOk++;
          else mismatches.push({ funded, h });
        } else {
          if (h < est + pad) shortOk++;
          else mismatches.push({ funded, h });
        }
      }
      return { total: rows.length, tallOk, shortOk, mismatches: mismatches.slice(0, 5) };
    }, { pad: TALL_PAD, est: ROW_ESTIMATE });
    step(
      'after hiding, every rendered row height matches its own identity (tall iff funded)',
      heightCheck.mismatches.length === 0 && heightCheck.total > 0,
      `rows=${heightCheck.total} tallOk=${heightCheck.tallOk} shortOk=${heightCheck.shortOk} mismatches=${JSON.stringify(heightCheck.mismatches)}`,
    );

    // Bottom of the filtered list: last displayed row flush with list end.
    await scrollTo(10 ** 9);
    await page.waitForTimeout(400);
    const hiddenBottom = await inspect();
    step(
      'at max scroll (hidden) the last displayed row is rendered',
      hiddenBottom.lastIndex === shownAfterHide - 1,
      `lastIndex=${hiddenBottom.lastIndex} expected=${shownAfterHide - 1}`,
    );
    step(
      'last row flush with table bottom after hiding (no phantom gap)',
      Math.abs(hiddenBottom.lastBottom - hiddenBottom.tableBottom) <= 2,
      `lastBottom=${hiddenBottom.lastBottom?.toFixed(1)} tableBottom=${hiddenBottom.tableBottom?.toFixed(1)}`,
    );
    step(
      'rows tile contiguously at the filtered bottom',
      hiddenBottom.indexHoles === 0 && hiddenBottom.maxGap <= 1.5,
      `indexHoles=${hiddenBottom.indexHoles} maxGap=${hiddenBottom.maxGap?.toFixed(2)}px over ${hiddenBottom.rowCount} rows`,
    );
    const hiddenRestTop = hiddenBottom.scrollTop;
    await page.waitForTimeout(900);
    const hiddenRest = await inspect();
    step(
      'scrollTop stable at rest at the filtered bottom',
      Math.abs(hiddenRest.scrollTop - hiddenRestTop) <= 1,
      `scrollTop ${hiddenRestTop?.toFixed(1)} → ${hiddenRest.scrollTop?.toFixed(1)}`,
    );

    // ── Toggle back off: indices shift again, full list must re-tile ────
    await toggleHideZeroTx();
    await page.waitForTimeout(500);
    const afterUnhide = await inspect();
    step(
      'rows tile contiguously after unhiding',
      afterUnhide.indexHoles === 0 && afterUnhide.maxGap <= 1.5,
      `indexHoles=${afterUnhide.indexHoles} maxGap=${afterUnhide.maxGap?.toFixed(2)}px over ${afterUnhide.rowCount} rows`,
    );
    step(
      'viewport fully covered after unhiding',
      afterUnhide.firstTop <= afterUnhide.viewTop + 1 && afterUnhide.lastBottom >= afterUnhide.viewBottom - 1,
      `firstTop=${afterUnhide.firstTop?.toFixed(1)} viewTop=${afterUnhide.viewTop?.toFixed(1)} lastBottom=${afterUnhide.lastBottom?.toFixed(1)} viewBottom=${afterUnhide.viewBottom?.toFixed(1)}`,
    );
    await scrollTo(10 ** 9);
    await page.waitForTimeout(400);
    const fullBottom = await inspect();
    step(
      'after unhiding, max scroll renders the true last row (index N-1) flush with the bottom',
      fullBottom.lastIndex === N - 1 && Math.abs(fullBottom.lastBottom - fullBottom.tableBottom) <= 2,
      `lastIndex=${fullBottom.lastIndex} expected=${N - 1} lastBottom=${fullBottom.lastBottom?.toFixed(1)} tableBottom=${fullBottom.tableBottom?.toFixed(1)}`,
    );
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  if (failed.length) {
    console.error(`[addr-checker-deep-scroll] ${failed.length}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`[addr-checker-deep-scroll] all ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error('[addr-checker-deep-scroll] FAILED:', e);
  process.exit(1);
});
