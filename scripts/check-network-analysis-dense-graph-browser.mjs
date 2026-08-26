#!/usr/bin/env node
// Real-browser regression guard for Network Analysis dense-graph guards.
//
// Task #2033 added node-level protection against dense-graph hangs:
// per-transaction clique bound (MAX_TX_CLIQUE_ADDRESSES), a hard
// TOO_MANY_EDGES guard, deterministic weight-based pruning to
// MAX_LAYOUT_EDGES, and a Cancel control during the "Laying out graph..."
// phase. The jsdom unit tests cannot prove the real-browser outcome that
// motivated the change: a wallet whose transactions would previously freeze
// the page now completes with the pruning disclosure notices.
//
// NOTE for reviewers: the page under test is client/src/pages/NetworkAnalysis.tsx
// (route /network-analysis); the guards live in client/src/lib/network-analysis.ts.
//
// This script drives the actual page in headless Chromium:
//   1. Creates a fresh vault via the setup form and dismisses the
//      legacy-migration overlay.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons) one owned
//      address plus:
//        - 11 dense consolidation-style transactions with 100 unique
//          addresses each (at the clique bound, so each expands to 4,950
//          pairwise edges => 54,450 full-graph edges > MAX_LAYOUT_EDGES of
//          50,000, triggering weight-based layout pruning), and
//        - 1 oversized consolidation with 120 addresses (> the 100-address
//          clique bound, so its pair expansion is skipped and disclosed), and
//        - 2 normal small transactions.
//   3. Clicks Analyze (default "My Addresses Only" filter finds the owned
//      record, then loads every participant of its transactions) and asserts
//      the run COMPLETES: the graph SVG renders and both disclosure notices
//      (data-testid notice-hidden-edges / notice-skipped-cliques) appear —
//      the page never sits on "Laying out graph..." indefinitely.
//   4. Asserts the stats disclose exactly 50,000 shown connections and 1
//      skipped oversized transaction.
//   5. Asserts the Cancel button is present during the layout phase and that
//      clicking it returns the page to idle (Analyze button back, spinner
//      gone) with the frozen graph still visible.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-network-analysis-dense-graph-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}network-analysis`;
const SETUP_PASSWORD = 'dense-graph-check-123';

// Seed geometry — see client/src/lib/network-analysis.ts constants.
const DENSE_TX_COUNT = 11; // 11 * C(100,2) = 54,450 edges > MAX_LAYOUT_EDGES (50,000)
const DENSE_TX_ADDRS = 100; // exactly MAX_TX_CLIQUE_ADDRESSES => still expanded
const OVERSIZED_TX_ADDRS = 120; // > MAX_TX_CLIQUE_ADDRESSES => clique skipped
const EXPECTED_SHOWN_EDGES = 50_000;

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

async function launchWithRetry(exe, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(
        `[network-analysis-dense-browser] chromium.launch attempt ${i + 1} failed (${err?.message?.slice(0, 120)}); retrying...`,
      );
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[network-analysis-dense-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[network-analysis-dense-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[network-analysis-dense-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[network-analysis-dense-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => the "Create Vault" setup form.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[network-analysis-dense-browser][page-console] ${t}`);
      }
    });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 45_000 });

    const analyzeBtn = page.getByTestId('button-run-analysis');
    await analyzeBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed: one owned address + dense/oversized/normal transactions ──────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // modules write to the exact same Dexie instance the page reads.
    const seedResult = await page.evaluate(
      async ({ denseTxCount, denseTxAddrs, oversizedTxAddrs }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        // Fake-but-plausible bech32 strings are fine: the graph builder
        // matches addresses by string equality. Keep every first-8-chars
        // prefix distinct (node testids use id.slice(0,8)).
        const owned = 'bc1qown0me00aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const ownedRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: owned,
          label: 'Dense-graph check owned address',
        });

        const mkAddr = (tx, i) =>
          `bc1qd${String(tx).padStart(2, '0')}x${String(i).padStart(4, '0')}` +
          'q'.repeat(28);

        const now = Math.floor(Date.now() / 1000);
        const txs = [];
        const participants = [];

        const addTxWithAddrs = (txid, addrCount, txIndex) => {
          txs.push({
            txid,
            blockHeight: 800_000 + txIndex,
            blockTime: now - 7_200 - txIndex * 600,
            fee: 10_000,
            feeRate: 8,
            syncedAt: Date.now(),
          });
          // Owned address spends into every seeded tx so the default
          // "My Addresses Only" filter discovers all of them.
          participants.push({
            txid,
            role: 'input',
            address: owned,
            amount: 5_000_000,
            vout: 0,
            recordId: ownedRecordId,
          });
          for (let i = 1; i < addrCount; i++) {
            participants.push({
              txid,
              role: i % 2 === 0 ? 'input' : 'output',
              address: mkAddr(txIndex, i),
              amount: 50_000 + i,
              vout: i,
            });
          }
        };

        let txIndex = 0;
        // Dense consolidation-style txs, each exactly at the clique bound.
        for (let t = 0; t < denseTxCount; t++) {
          addTxWithAddrs('d1'.repeat(2) + String(t).padStart(2, '0') + 'ab'.repeat(29), denseTxAddrs, txIndex++);
        }
        // One oversized consolidation (> clique bound) => skipped clique.
        addTxWithAddrs('e2'.repeat(2) + '99' + 'cd'.repeat(29), oversizedTxAddrs, txIndex++);
        // Two normal small txs.
        addTxWithAddrs('f3'.repeat(2) + '01' + 'ef'.repeat(29), 3, txIndex++);
        addTxWithAddrs('f3'.repeat(2) + '02' + '0a'.repeat(29), 4, txIndex++);

        await txCrud.bulkAddTransactions(txs, { skipNotification: true });
        // Chunked bulk adds keep each IDB transaction reasonably sized.
        for (let i = 0; i < participants.length; i += 500) {
          await txCrud.bulkAddParticipants(participants.slice(i, i + 500), {
            skipNotification: true,
          });
        }
        return { txCount: txs.length, participantCount: participants.length };
      },
      {
        denseTxCount: DENSE_TX_COUNT,
        denseTxAddrs: DENSE_TX_ADDRS,
        oversizedTxAddrs: OVERSIZED_TX_ADDRS,
      },
    );
    steps.push({
      name: 'seed: dense wallet written to vault',
      passed:
        seedResult.txCount === DENSE_TX_COUNT + 3 &&
        seedResult.participantCount ===
          DENSE_TX_COUNT * DENSE_TX_ADDRS + OVERSIZED_TX_ADDRS + 3 + 4,
      detail: `seeded ${seedResult.txCount} txs / ${seedResult.participantCount} participants`,
    });

    // ── Run the analysis ────────────────────────────────────────────────────
    const runStart = Date.now();
    await analyzeBtn.click();

    // Cancel button replaces Analyze for the whole analyzing+layout phase.
    const cancelBtn = page.getByTestId('button-cancel-analysis');
    const cancelSeenDuringAnalyze = await cancelBtn
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'analyze: Cancel control appears once the run starts',
      passed: cancelSeenDuringAnalyze,
      detail: cancelSeenDuringAnalyze
        ? 'button-cancel-analysis visible after clicking Analyze'
        : 'button-cancel-analysis never appeared',
    });

    // COMPLETION: the graph SVG + both disclosure notices must appear. This is
    // the core regression: previously this dataset would hang the tab instead.
    const svg = page.locator('[data-testid="svg-network-graph"]');
    const hiddenNotice = page.locator('[data-testid="notice-hidden-edges"]');
    const skippedNotice = page.locator('[data-testid="notice-skipped-cliques"]');

    let completed = true;
    try {
      await svg.waitFor({ state: 'visible', timeout: 180_000 });
      await hiddenNotice.waitFor({ state: 'visible', timeout: 60_000 });
      await skippedNotice.waitFor({ state: 'visible', timeout: 30_000 });
    } catch {
      completed = false;
    }
    const elapsedMs = Date.now() - runStart;
    steps.push({
      name: 'complete: graph renders with both pruning/skipped-clique notices (no indefinite hang)',
      passed: completed,
      detail: completed
        ? `graph + notice-hidden-edges + notice-skipped-cliques visible after ${(elapsedMs / 1000).toFixed(1)}s`
        : `graph/notices did not appear within the time budget (${(elapsedMs / 1000).toFixed(1)}s elapsed)`,
    });
    if (!completed) {
      const progress = await page
        .getByTestId('text-progress')
        .textContent()
        .catch(() => null);
      throw new Error(
        `Analysis never completed — last progress: ${JSON.stringify(progress)}`,
      );
    }

    // ── Stats disclose the pruning precisely ───────────────────────────────
    {
      const shownEdges = (await page
        .getByTestId('text-stat-shown-edges')
        .textContent()
        .catch(() => null))?.trim();
      const skipped = (await page
        .getByTestId('text-stat-skipped-cliques')
        .textContent()
        .catch(() => null))?.trim();
      const totalEdges = (await page
        .getByTestId('text-stat-edges')
        .textContent()
        .catch(() => null))?.trim();
      const shownOk = shownEdges === EXPECTED_SHOWN_EDGES.toLocaleString('en-US');
      const skippedOk = skipped === '1';
      const totalNum = Number((totalEdges || '').replace(/,/g, ''));
      const totalOk = totalNum > EXPECTED_SHOWN_EDGES;
      steps.push({
        name: 'stats: shown connections capped at 50,000; 1 oversized tx skipped; full edge count above the cap',
        passed: shownOk && skippedOk && totalOk,
        detail: `shown=${shownEdges} skipped=${skipped} totalEdges=${totalEdges}`,
      });
      const hiddenText = (await hiddenNotice.textContent().catch(() => null)) ?? '';
      const skippedText = (await skippedNotice.textContent().catch(() => null)) ?? '';
      steps.push({
        name: 'notices: disclosure text names the pruning and the skipped consolidation',
        passed:
          /strongest/i.test(hiddenText) &&
          /hidden from the layout/i.test(hiddenText) &&
          /not expanded into pairwise/i.test(skippedText),
        detail: `hidden-notice ${hiddenText.length} chars, skipped-notice ${skippedText.length} chars`,
      });
    }

    // ── Cancel during the layout phase returns the page to idle ────────────
    {
      const layoutIndicator = page.getByText('Laying out graph...', { exact: false });
      let layoutVisible = await layoutIndicator.isVisible().catch(() => false);
      let cancelVisible = await cancelBtn.isVisible().catch(() => false);

      if (!layoutVisible || !cancelVisible) {
        // The simulation finished before we sampled it (fast machine). Re-run
        // the analysis once and catch the layout phase this time.
        console.log(
          '[network-analysis-dense-browser] layout already finished; re-running to catch the layout phase',
        );
        await page.getByTestId('button-run-analysis').click();
        await svg.waitFor({ state: 'visible', timeout: 180_000 });
        layoutVisible = await layoutIndicator
          .waitFor({ state: 'visible', timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        cancelVisible = await cancelBtn.isVisible().catch(() => false);
      }
      steps.push({
        name: 'layout: "Laying out graph..." indicator and Cancel button present during layout',
        passed: layoutVisible && cancelVisible,
        detail: `layoutIndicator=${layoutVisible} cancelButton=${cancelVisible}`,
      });

      // dispatchEvent avoids coordinate-click races while 50k SVG lines are
      // re-rendering under the pointer.
      await cancelBtn.dispatchEvent('click');

      const backToIdle = await page
        .getByTestId('button-run-analysis')
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      const layoutGone = await layoutIndicator
        .waitFor({ state: 'hidden', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      const graphStillThere = await svg.isVisible().catch(() => false);
      steps.push({
        name: 'cancel: clicking Cancel during layout returns to idle with the frozen graph visible',
        passed: backToIdle && layoutGone && graphStillThere,
        detail: `analyzeButtonBack=${backToIdle} layoutIndicatorGone=${layoutGone} graphStillVisible=${graphStillThere}`,
      });
    }
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }

  const ok = steps.every((s) => s.passed);
  console.log(`[network-analysis-dense-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[network-analysis-dense-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[network-analysis-dense-browser] PASSED: dense wallet analysis completes in a real browser with pruning/skipped-clique disclosure and a working layout Cancel.',
  );
}

main().catch((err) => {
  console.error('[network-analysis-dense-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
