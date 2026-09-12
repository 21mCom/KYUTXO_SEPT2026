#!/usr/bin/env node
// Real-browser regression guard for the Network Analysis hard refusal path.
//
// client/src/lib/network-analysis.ts refuses to build a graph whose dataset
// exceeds MAX_NODES (3,000 addresses) or MAX_EDGES (1,000,000 edges) by
// throwing TOO_MANY_NODES / TOO_MANY_EDGES; the page surfaces the friendly
// message in [data-testid="text-error"] and returns to idle. That guard was
// previously proven only in jsdom — this script proves it in a real browser:
// an over-limit wallet must get a prompt, clear refusal instead of a frozen
// tab, and the Analyze button must be usable again afterwards.
//
// NOTE for reviewers: the page under test is client/src/pages/NetworkAnalysis.tsx
// (route /network-analysis); the refusal guard lives in
// client/src/lib/network-analysis.ts (MAX_NODES check after edge-map build).
//
// The script:
//   1. Creates a fresh vault via the setup form and dismisses the
//      legacy-migration overlay.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons) one owned
//      address plus 35 consolidation-style transactions with 100 unique
//      addresses each => ~3,466 unique addresses > MAX_NODES (3,000), while
//      staying under the clique bound and MAX_EDGES so the node guard is the
//      one that fires.
//   3. Clicks Analyze and asserts the refusal text (data-testid text-error)
//      appears within a bounded time, mentioning the limit and suggesting
//      filters — the page never hangs on the layout phase.
//   4. Asserts the page is back to idle: Analyze button visible + enabled, no
//      graph rendered, and a second click starts a fresh run (error clears).
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-network-analysis-refusal-browser.mjs
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
const SETUP_PASSWORD = 'refusal-check-123';

// Seed geometry — see client/src/lib/network-analysis.ts constants.
// 35 txs * 99 fresh addresses + 1 owned = 3,466 unique addresses > MAX_NODES
// (3,000). Each tx stays at the 100-address clique bound so edges are still
// expanded (35 * 4,950 = 173,250 edges, under MAX_EDGES) — the node-count
// refusal is the guard that must fire.
const TX_COUNT = 35;
const TX_ADDRS = 100;
const EXPECTED_NODES = TX_COUNT * (TX_ADDRS - 1) + 1;
// Refusal must be prompt — well under the minutes-long budget a completing
// dense run gets, since nothing is laid out.
const REFUSAL_TIMEOUT_MS = 90_000;

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
        `[network-analysis-refusal-browser] chromium.launch attempt ${i + 1} failed (${err?.message?.slice(0, 120)}); retrying...`,
      );
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[network-analysis-refusal-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[network-analysis-refusal-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[network-analysis-refusal-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[network-analysis-refusal-browser] dev server ready at ${BASE_URL}`);
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
        console.log(`[network-analysis-refusal-browser][page-console] ${t}`);
      }
    });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 45_000 });

    const analyzeBtn = page.getByTestId('button-run-analysis');
    await analyzeBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed: one owned address + enough txs to exceed MAX_NODES ───────────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // modules write to the exact same Dexie instance the page reads.
    const seedResult = await page.evaluate(
      async ({ txCount, txAddrs }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        // Fake-but-plausible bech32 strings are fine: the graph builder
        // matches addresses by string equality. Keep every first-8-chars
        // prefix distinct.
        const owned = 'bc1qown0me00aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const ownedRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: owned,
          label: 'Refusal check owned address',
        });

        const mkAddr = (tx, i) =>
          `bc1qr${String(tx).padStart(2, '0')}x${String(i).padStart(4, '0')}` +
          'q'.repeat(28);

        const now = Math.floor(Date.now() / 1000);
        const txs = [];
        const participants = [];

        for (let t = 0; t < txCount; t++) {
          const txid = 'a1'.repeat(2) + String(t).padStart(2, '0') + 'ab'.repeat(29);
          txs.push({
            txid,
            blockHeight: 800_000 + t,
            blockTime: now - 7_200 - t * 600,
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
          for (let i = 1; i < txAddrs; i++) {
            participants.push({
              txid,
              role: i % 2 === 0 ? 'input' : 'output',
              address: mkAddr(t, i),
              amount: 50_000 + i,
              vout: i,
            });
          }
        }

        await txCrud.bulkAddTransactions(txs, { skipNotification: true });
        // Chunked bulk adds keep each IDB transaction reasonably sized.
        for (let i = 0; i < participants.length; i += 500) {
          await txCrud.bulkAddParticipants(participants.slice(i, i + 500), {
            skipNotification: true,
          });
        }
        return { txCount: txs.length, participantCount: participants.length };
      },
      { txCount: TX_COUNT, txAddrs: TX_ADDRS },
    );
    steps.push({
      name: `seed: over-limit wallet written to vault (${EXPECTED_NODES.toLocaleString('en-US')} unique addresses > MAX_NODES)`,
      passed:
        seedResult.txCount === TX_COUNT &&
        seedResult.participantCount === TX_COUNT * TX_ADDRS,
      detail: `seeded ${seedResult.txCount} txs / ${seedResult.participantCount} participants`,
    });

    // ── Run the analysis: expect a prompt refusal, not a hang ──────────────
    const runStart = Date.now();
    await analyzeBtn.click();

    const errorLocator = page.getByTestId('text-error');
    let refused = true;
    try {
      await errorLocator.waitFor({ state: 'visible', timeout: REFUSAL_TIMEOUT_MS });
    } catch {
      refused = false;
    }
    const elapsedMs = Date.now() - runStart;
    steps.push({
      name: 'refusal: text-error appears within the bounded time (no frozen page)',
      passed: refused,
      detail: refused
        ? `refusal surfaced after ${(elapsedMs / 1000).toFixed(1)}s`
        : `text-error never appeared within ${(REFUSAL_TIMEOUT_MS / 1000).toFixed(0)}s`,
    });
    if (!refused) {
      const progress = await page
        .getByTestId('text-progress')
        .textContent()
        .catch(() => null);
      throw new Error(
        `Refusal never surfaced — last progress: ${JSON.stringify(progress)}`,
      );
    }

    const errorText = ((await errorLocator.textContent().catch(() => null)) ?? '').trim();
    const friendly =
      /exceeds the safe limit/i.test(errorText) &&
      /filters/i.test(errorText) &&
      /3,000|1,000,000/.test(errorText) &&
      // Must be the friendly third segment, not the raw TOO_MANY_* code.
      !/TOO_MANY_(NODES|EDGES):/.test(errorText);
    steps.push({
      name: 'refusal: message is the friendly limit text suggesting filters (no raw error code)',
      passed: friendly,
      detail: `text-error: ${JSON.stringify(errorText.slice(0, 200))}`,
    });

    // ── Page returns to idle: Analyze usable again, no graph, no spinner ───
    const backToIdle = await analyzeBtn
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const analyzeEnabled = backToIdle && (await analyzeBtn.isEnabled().catch(() => false));
    const graphVisible = await page
      .locator('[data-testid="svg-network-graph"]')
      .isVisible()
      .catch(() => false);
    const cancelStillShown = await page
      .getByTestId('button-cancel-analysis')
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'idle: Analyze button back and enabled, no graph rendered, no lingering Cancel',
      passed: backToIdle && analyzeEnabled && !graphVisible && !cancelStillShown,
      detail: `analyzeBack=${backToIdle} enabled=${analyzeEnabled} graphVisible=${graphVisible} cancelVisible=${cancelStillShown}`,
    });

    // ── Second click works: error clears and a fresh run refuses again ─────
    await analyzeBtn.click();
    const rerunRefused = await errorLocator
      .waitFor({ state: 'visible', timeout: REFUSAL_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    const rerunIdle = await analyzeBtn
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'rerun: Analyze is genuinely usable again — a second run refuses cleanly too',
      passed: rerunRefused && rerunIdle,
      detail: `rerunRefused=${rerunRefused} rerunIdle=${rerunIdle}`,
    });
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
  console.log(`[network-analysis-refusal-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[network-analysis-refusal-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[network-analysis-refusal-browser] PASSED: an over-limit wallet gets a prompt friendly refusal and the page returns to idle in a real browser.',
  );
}

main().catch((err) => {
  console.error('[network-analysis-refusal-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
