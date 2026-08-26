#!/usr/bin/env node
// Real-browser regression guard for the Network Analysis EDGE-count refusal.
//
// client/src/lib/network-analysis.ts refuses to build a graph whose dataset
// exceeds MAX_EDGES (1,000,000 unique address pairs) by throwing
// TOO_MANY_EDGES; the page surfaces the friendly message in
// [data-testid="text-error"] and returns to idle. The sibling script
// check-network-analysis-refusal-browser.mjs proves the TOO_MANY_NODES path;
// this one proves the edge guard — which is trickier because the node check
// runs FIRST, so the dataset must stay at or under 3,000 unique addresses
// while still expanding to >1,000,000 unique pairs.
//
// NOTE for reviewers: the page under test is client/src/pages/NetworkAnalysis.tsx
// (route /network-analysis); the guard lives in client/src/lib/network-analysis.ts
// (MAX_EDGES check, which fires only after the MAX_NODES check passes).
//
// Seed geometry — affine-plane lines over Z_53 x Z_53:
//   * Address pool: the 53*53 = 2,809 grid points (x, y), plus 1 owned
//     address => 2,810 unique addresses, safely under MAX_NODES (3,000).
//   * Each transaction is one "line" {(x, (m*x + c) mod 53) : x in 0..52}
//     of 53 pool addresses (plus the owned input, 54 per tx — well under the
//     100-address clique bound, so pairs ARE expanded).
//   * Two distinct lines intersect in at most one point, so their C(53,2)
//     = 1,378 pool-pair sets are fully disjoint. 730 lines (slopes 0..13,
//     intercepts 0..52, truncated) yield 730 * 1,378 = 1,005,940 unique
//     pool pairs > MAX_EDGES (1,000,000) — the edge refusal must fire.
//
// The script:
//   1. Creates a fresh vault via the setup form and dismisses the
//      legacy-migration overlay.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons) the owned
//      address plus the 730 line-transactions above.
//   3. Clicks Analyze and asserts the friendly EDGE-limit refusal appears in
//      data-testid text-error within bounded time — specifically the edge
//      message ("connected by ... edges"), not the address-count one.
//   4. Asserts the page is back to idle: Analyze visible + enabled, no graph,
//      no lingering Cancel, and a second run refuses cleanly too.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-network-analysis-edge-refusal-browser.mjs
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
const SETUP_PASSWORD = 'edge-refusal-check-123';

// Seed geometry (see header): 730 lines over Z_53^2.
const P = 53;
const LINE_COUNT = 730; // 730 * C(53,2) = 1,005,940 unique pairs > MAX_EDGES
const EXPECTED_POOL_ADDRESSES = P * P; // 2,809 (+1 owned = 2,810 < MAX_NODES)
const EXPECTED_PARTICIPANTS = LINE_COUNT * (P + 1); // owned input + 53 per tx
// Refusal must be prompt — the ~1M-pair edge map builds in seconds; nothing
// is ever laid out.
const REFUSAL_TIMEOUT_MS = 120_000;

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
        `[network-analysis-edge-refusal-browser] chromium.launch attempt ${i + 1} failed (${err?.message?.slice(0, 120)}); retrying...`,
      );
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[network-analysis-edge-refusal-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[network-analysis-edge-refusal-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[network-analysis-edge-refusal-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[network-analysis-edge-refusal-browser] dev server ready at ${BASE_URL}`);
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
        console.log(`[network-analysis-edge-refusal-browser][page-console] ${t}`);
      }
    });

    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 45_000 });

    const analyzeBtn = page.getByTestId('button-run-analysis');
    await analyzeBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed: <=3,000 addresses whose txs expand to >1,000,000 pairs ───────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // modules write to the exact same Dexie instance the page reads.
    const seedResult = await page.evaluate(
      async ({ p, lineCount }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        // Fake-but-plausible bech32 strings are fine: the graph builder
        // matches addresses by string equality.
        const owned = 'bc1qown0me00edgecapaaaaaaaaaaaaaaaaaaaaaa';
        const ownedRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: owned,
          label: 'Edge refusal check owned address',
        });

        // Grid point (x, y) -> deterministic unique address string.
        const gridAddr = (x, y) =>
          `bc1qe${String(x).padStart(2, '0')}g${String(y).padStart(2, '0')}` +
          'q'.repeat(30);

        const now = Math.floor(Date.now() / 1000);
        const txs = [];
        const participants = [];
        const poolSeen = new Set();

        // Lines over Z_p x Z_p: slope m, intercept c, truncated to lineCount.
        // Distinct lines share at most one point => pair sets are disjoint.
        let made = 0;
        outer: for (let m = 0; m < p; m++) {
          for (let c = 0; c < p; c++) {
            if (made >= lineCount) break outer;
            const txid =
              'ed9e' + String(made).padStart(4, '0') + 'cd'.repeat(28);
            txs.push({
              txid,
              blockHeight: 810_000 + made,
              blockTime: now - 7_200 - made * 60,
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
            for (let x = 0; x < p; x++) {
              const y = (m * x + c) % p;
              const addr = gridAddr(x, y);
              poolSeen.add(addr);
              participants.push({
                txid,
                role: x % 2 === 0 ? 'input' : 'output',
                address: addr,
                amount: 50_000 + x,
                vout: x + 1,
              });
            }
            made++;
          }
        }

        await txCrud.bulkAddTransactions(txs, { skipNotification: true });
        // Chunked bulk adds keep each IDB transaction reasonably sized.
        for (let i = 0; i < participants.length; i += 1000) {
          await txCrud.bulkAddParticipants(participants.slice(i, i + 1000), {
            skipNotification: true,
          });
        }
        return {
          txCount: txs.length,
          participantCount: participants.length,
          poolAddresses: poolSeen.size,
        };
      },
      { p: P, lineCount: LINE_COUNT },
    );
    steps.push({
      name: `seed: ${LINE_COUNT} line-txs over a ${EXPECTED_POOL_ADDRESSES}-address pool (nodes under MAX_NODES, pairs over MAX_EDGES)`,
      passed:
        seedResult.txCount === LINE_COUNT &&
        seedResult.participantCount === EXPECTED_PARTICIPANTS &&
        seedResult.poolAddresses <= EXPECTED_POOL_ADDRESSES,
      detail: `seeded ${seedResult.txCount} txs / ${seedResult.participantCount} participants / ${seedResult.poolAddresses} pool addresses`,
    });

    // ── Run the analysis: expect a prompt EDGE refusal, not a hang ─────────
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
    // Must be the EDGE-limit message specifically: "connected by N edges ...
    // exceeds the safe limit of 1,000,000" — not the address-count refusal,
    // and not the raw TOO_MANY_* code.
    const isEdgeMessage =
      /connected by/i.test(errorText) &&
      /edges/i.test(errorText) &&
      /exceeds the safe limit/i.test(errorText) &&
      /1,000,000/.test(errorText) &&
      /filters/i.test(errorText);
    const notNodeMessage = !/dataset contains[\s\S]*addresses/i.test(errorText);
    const noRawCode = !/TOO_MANY_(NODES|EDGES):/.test(errorText);
    steps.push({
      name: 'refusal: message is the friendly EDGE-limit text (not the address-count one, no raw code)',
      passed: isEdgeMessage && notNodeMessage && noRawCode,
      detail: `text-error: ${JSON.stringify(errorText.slice(0, 220))}`,
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
  console.log(`[network-analysis-edge-refusal-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[network-analysis-edge-refusal-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[network-analysis-edge-refusal-browser] PASSED: a >1M-edge (but under-3,000-address) wallet gets a prompt friendly edge-limit refusal and the page returns to idle in a real browser.',
  );
}

main().catch((err) => {
  console.error('[network-analysis-edge-refusal-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
