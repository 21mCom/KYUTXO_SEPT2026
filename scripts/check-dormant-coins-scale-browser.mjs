#!/usr/bin/env node
// Real-browser SCALE guard for the Dormant Coins report page.
//
// NOTE for reviewers: the page under test is client/src/pages/DormantCoins.tsx
// (routed at /dormant-coins in client/src/App.tsx); the scan engine is
// client/src/lib/dormant-coins.ts and the windowed lists are
// client/src/pages/dormant-coins/dormant-results-list.tsx backed by the
// scratch store client/src/lib/data/dormant-coins-report-store.ts.
//
// The base browser check (scripts/check-dormant-coins-browser.mjs) proves
// correctness + cancel at 4k transactions (~12k participants). This check
// proves the scan and the virtualized result lists stay RESPONSIVE on a truly
// huge vault: 35,000 old funding transactions → 105,006 participants and
// 70,001 result rows streamed to the scratch store.
//
// What it asserts:
//   1. cancel works mid-run on the huge vault (idle + interrupted notice)
//   2. during the full scan the page keeps painting: the progress line
//      advances through many distinct frames (MutationObserver) and
//      requestAnimationFrame round-trips stay bounded mid-scan
//   3. the full scan completes within a generous budget and reports the
//      expected row count
//   4. only a bounded window of virtualized rows is ever mounted, and
//      scrolling to the middle/bottom of the 70k-row list swaps the window,
//      loads real rows from IndexedDB (no permanent "Loading…"), and the main
//      thread stays responsive (rAF probe)
//
// Seed design (deterministic; expectations computed from N):
//   - one owned address record OWN (manual tier)
//   - N old funding txs (5y): funder input (fake outpoint), outputs OWN vout0
//     and unknown UP_i vout1 → N own-dormant + N paid-alongside rows
//   - one co-spend tx (6y): inputs OWN + U1 + U2 → co-spend group #1
//   - one funding tx for U1 (7y, unspent) → 1 co-spent row, ranked first
//   - expected rows: 2N + 1; groupCount: 1
//
// Everything runs offline against local IndexedDB — no network requests.
// Usage: node scripts/check-dormant-coins-scale-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks (shared port 5000 + CPU/RAM).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}dormant-coins`;
const SETUP_PASSWORD = 'dormant-scale-check-123';

const N = 35_000; // old funding txs → 3N + 6 participants (105,006), 2N + 1 rows
const EXPECTED_ROWS = 2 * N + 1;
const EXPECTED_PARTICIPANTS = 3 * N + 6;
// Generous "finishes, and in sane time" budget. The scan streams batches of
// IndexedDB reads with cooperative yields; even under validation load this
// should be minutes-away from the cap.
const SCAN_BUDGET_MS = 300_000;

const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365.25 * 24 * 60 * 60;
const OLD_5Y = Math.floor(NOW - 5 * YEAR);
const OLD_6Y = Math.floor(NOW - 6 * YEAR);
const OLD_7Y = Math.floor(NOW - 7 * YEAR);

const OWN = 'bc1qdormscaleown' + 'o'.repeat(26);
const U1 = 'bc1qdormscaleu1' + 'u'.repeat(27);
const U2 = 'bc1qdormscaleu2' + 'v'.repeat(27);
const TXC = 'ca'.repeat(32);
const TXU1 = '2d'.repeat(32);

const fmt = (n) => n.toLocaleString('en-US');

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

async function launchWithRetry(exe) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(`[dormant-scale] chromium launch attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dormant-scale] chromium: ${exe}`);

  let devProc = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[dormant-scale] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[dormant-scale] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[dormant-scale] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[dormant-scale] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[dormant-scale][page-console] ${msg.text()}`);
    });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault ──────────────────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page.getByTestId('button-run-scan').waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed the huge vault via live CRUD singletons (chunked) ────────────
    const seedStart = Date.now();
    const seeded = await page.evaluate(
      async ({ n, own, u1, u2, txc, txu1, old5y, old6y, old7y }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        await recordCrud.createRecord({
          type: 'address',
          inputString: own,
          label: 'Old savings wallet',
          addressImportance: 'manual',
        });

        const mkAddr = (p, i) => (`${p}${i}` + 'z'.repeat(42)).slice(0, 42);
        const mkTx = (i) => i.toString(16).padStart(8, '0') + 'ab'.repeat(28);
        const fakePrev = (i) => i.toString(16).padStart(8, '0') + '00'.repeat(28);

        // Chunk sized to keep each bulkAdd transaction short so the page
        // never freezes while seeding (repo browser-seed convention).
        const TX_CHUNK = 2000;
        for (let start = 0; start < n; start += TX_CHUNK) {
          const end = Math.min(start + TX_CHUNK, n);
          const txs = [];
          const parts = [];
          for (let i = start; i < end; i++) {
            const txid = mkTx(i);
            txs.push({ txid, blockHeight: 700_000 + i, blockTime: old5y + i, fee: 500, feeRate: 2, syncedAt: Date.now() });
            parts.push({ txid, role: 'input', address: mkAddr('bc1qfunder', i), amount: 60_000 + i, prevTxid: fakePrev(i), prevVout: 0 });
            parts.push({ txid, role: 'output', address: own, amount: 20_000 + i, vout: 0 });
            parts.push({ txid, role: 'output', address: mkAddr('bc1qpaidup', i), amount: 30_000 + i, vout: 1 });
          }
          await txCrud.bulkAddTransactions(txs);
          await txCrud.bulkAddParticipants(parts);
        }

        // Co-spend tx: owned + two unknown inputs.
        await txCrud.addTransaction({ txid: txc, blockHeight: 600_000, blockTime: old6y, fee: 500, feeRate: 2, syncedAt: Date.now() });
        await txCrud.bulkAddParticipants([
          { txid: txc, role: 'input', address: own, amount: 100_000, prevTxid: fakePrev(n + 1), prevVout: 0 },
          { txid: txc, role: 'input', address: u1, amount: 640_000, prevTxid: fakePrev(n + 2), prevVout: 0 },
          { txid: txc, role: 'input', address: u2, amount: 50_000, prevTxid: fakePrev(n + 3), prevVout: 0 },
          { txid: txc, role: 'output', address: mkAddr('bc1qcospenddest', 0), amount: 780_000, vout: 0 },
        ]);

        // U1's dormant output (7y — the oldest row, ranked first).
        await txCrud.addTransaction({ txid: txu1, blockHeight: 500_000, blockTime: old7y, fee: 500, feeRate: 2, syncedAt: Date.now() });
        await txCrud.bulkAddParticipants([
          { txid: txu1, role: 'input', address: mkAddr('bc1qu1funder', 0), amount: 510_000, prevTxid: fakePrev(n + 4), prevVout: 0 },
          { txid: txu1, role: 'output', address: u1, amount: 500_000, vout: 0 },
        ]);

        const { db } = await import('/src/lib/database.ts');
        return { participants: await db.transactionParticipants.count() };
      },
      { n: N, own: OWN, u1: U1, u2: U2, txc: TXC, txu1: TXU1, old5y: OLD_5Y, old6y: OLD_6Y, old7y: OLD_7Y },
    );
    record(
      'seed',
      seeded.participants === EXPECTED_PARTICIPANTS,
      `${fmt(seeded.participants)} participants seeded (expected ${fmt(EXPECTED_PARTICIPANTS)}) in ${Date.now() - seedStart}ms`,
    );

    // ── Cancel mid-run on the huge vault ──────────────────────────────────
    await page.getByTestId('button-run-scan').click();
    await page.getByTestId('text-scan-progress').waitFor({ state: 'visible', timeout: 30_000 });
    // Let it chew for a moment so the cancel lands genuinely mid-scan.
    await page.waitForTimeout(1500);
    const cancelStart = Date.now();
    await page.getByTestId('button-cancel-scan').click();
    await page.getByTestId('alert-interrupted').waitFor({ state: 'visible', timeout: 15_000 });
    const cancelMs = Date.now() - cancelStart;
    const runBtnText = await page.getByTestId('button-run-scan').textContent();
    record(
      'cancel',
      (runBtnText?.includes('Run scan') ?? false) && cancelMs < 10_000,
      `cancel mid-scan returned to idle + interrupted notice in ${cancelMs}ms`,
    );

    // ── Full run: watch progress frames + rAF responsiveness ──────────────
    // MutationObserver counts DISTINCT progress-line texts: each new frame is
    // proof the page painted (React committed) while the scan was running.
    await page.evaluate(() => {
      window.__dormantFrames = new Set();
      const attach = () => {
        const el = document.querySelector('[data-testid="text-scan-progress"]');
        if (!el) return false;
        window.__dormantFrames.add(el.textContent ?? '');
        const mo = new MutationObserver(() => {
          window.__dormantFrames.add(el.textContent ?? '');
        });
        mo.observe(el, { childList: true, characterData: true, subtree: true });
        window.__dormantObserver = mo;
        return true;
      };
      // The element only exists once the run starts; poll briefly.
      const iv = setInterval(() => {
        if (attach()) clearInterval(iv);
      }, 50);
      setTimeout(() => clearInterval(iv), 30_000);
    });

    const started = Date.now();
    await page.getByTestId('button-run-scan').click();
    await page.getByTestId('text-scan-progress').waitFor({ state: 'visible', timeout: 30_000 });

    // Sample rAF round-trips mid-scan: a frozen main thread would stall these.
    const rafSamples = [];
    while (rafSamples.length < 5) {
      const summaryVisible = await page
        .getByTestId('text-summary-rows')
        .isVisible()
        .catch(() => false);
      if (summaryVisible) break;
      const t0 = Date.now();
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      rafSamples.push(Date.now() - t0);
      await page.waitForTimeout(1000);
    }

    await page.getByTestId('text-summary-rows').waitFor({ state: 'visible', timeout: SCAN_BUDGET_MS });
    const scanMs = Date.now() - started;
    const frames = await page.evaluate(() => {
      window.__dormantObserver?.disconnect();
      return [...(window.__dormantFrames ?? [])].filter(Boolean);
    });
    const maxRaf = rafSamples.length ? Math.max(...rafSamples) : -1;
    record(
      'scan-completes',
      scanMs <= SCAN_BUDGET_MS,
      `full scan over ${fmt(EXPECTED_PARTICIPANTS)} participants finished in ${(scanMs / 1000).toFixed(1)}s (budget ${SCAN_BUDGET_MS / 1000}s)`,
    );
    record(
      'progress-frames',
      frames.length >= 10,
      `${frames.length} distinct progress frames painted (need ≥10); sample="${frames[Math.floor(frames.length / 2)] ?? ''}"`,
    );
    record(
      'raf-during-scan',
      rafSamples.length > 0 && maxRaf < 3_000,
      `rAF round-trips mid-scan: [${rafSamples.join(', ')}]ms (max ${maxRaf}ms < 3000ms)`,
    );

    const rowsText = await page.getByTestId('text-summary-rows').textContent();
    const groupsText = await page.getByTestId('text-summary-groups').textContent();
    record(
      'summary',
      rowsText === fmt(EXPECTED_ROWS) && groupsText === '1',
      `rows=${rowsText} (expected ${fmt(EXPECTED_ROWS)}) groups=${groupsText}`,
    );

    // ── Virtualized list: bounded mount + windowed scrolling ──────────────
    const listScroller = page.getByTestId('scroll-dormant-rows');
    await listScroller.waitFor({ state: 'visible', timeout: 15_000 });
    // Oldest row (U1, 7y) ranked first and hydrated from the scratch store.
    await page.getByTestId(`row-dormant-${TXU1.slice(0, 12)}-0`).waitFor({ state: 'visible', timeout: 30_000 });

    const mountedTop = await page.locator('[data-testid^="row-dormant-"]').count();
    record(
      'bounded-mount',
      mountedTop > 0 && mountedTop < 300,
      `mounted=${mountedTop} of ${fmt(EXPECTED_ROWS)} rows`,
    );

    const scrollProbe = async (label, targetFraction) => {
      const t0 = Date.now();
      await page.evaluate(
        ({ frac }) => {
          const el = document.querySelector('[data-testid="scroll-dormant-rows"]');
          el.scrollTop = (el.scrollHeight - el.clientHeight) * frac;
        },
        { frac: targetFraction },
      );
      // rAF round-trip right after the jump = main thread alive, not frozen.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const rafMs = Date.now() - t0;
      // Real rows (not the "Loading…" placeholders) must hydrate from the
      // windowed IndexedDB fetch shortly after landing.
      const deadline = Date.now() + 15_000;
      let real = 0;
      let loading = 0;
      while (Date.now() < deadline) {
        real = await page
          .locator('[data-testid^="row-dormant-"]:not([data-testid^="row-dormant-loading-"])')
          .count();
        loading = await page.locator('[data-testid^="row-dormant-loading-"]').count();
        if (real > 0 && loading === 0) break;
        await page.waitForTimeout(200);
      }
      const mounted = await page.locator('[data-testid^="row-dormant-"]').count();
      record(
        `scroll-${label}`,
        rafMs < 3_000 && real > 0 && loading === 0 && mounted < 300,
        `rAF after jump=${rafMs}ms, mounted=${mounted} (real=${real}, loading=${loading})`,
      );
      return real;
    };

    await scrollProbe('middle', 0.5);
    await scrollProbe('bottom', 1);
    // Back to top: the first (oldest) row is still there, from cache.
    await scrollProbe('top', 0);
    const backTopVisible = await page
      .getByTestId(`row-dormant-${TXU1.slice(0, 12)}-0`)
      .isVisible()
      .catch(() => false);
    record('back-to-top', backTopVisible, 'oldest row visible again after scrolling back');

    await context.close();
  } finally {
    await browser.close();
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[dormant-scale] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length > 0) {
    console.error('[dormant-scale] FAILED steps:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log(
    `[dormant-scale] PASSED: the Dormant Coins scan stays responsive at ${fmt(EXPECTED_PARTICIPANTS)} participants and the 70k-row windowed list scrolls smoothly.`,
  );
}

main().catch((err) => {
  console.error('[dormant-scale] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
