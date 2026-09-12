#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds LIVE balance check's
// node-outage safety behavior.
//
// NOTE for reviewers: the consumer page is client/src/pages/ProofOfFundsDeclaration.tsx
// (route /proof-of-funds); the behavior under test lives in
// client/src/pages/proof-of-funds/use-balance-check.ts and the banner renders in
// client/src/pages/proof-of-funds/address-balance-cards.tsx.
//
// The jsdom suite (ProofOfFundsDeclaration.nodeUnreachable.test.tsx) proves the
// same contract with a mocked provider factory, but jsdom never runs the real
// Vite bundle, the real `createProviderFromSettings` → Esplora `fetch` path, or
// real DOM timing. This script drives the actual page in headless Chromium with
// Playwright network interception simulating an unreachable node (aborted
// connections → the browser's genuine "Failed to fetch") and asserts:
//
//   CASE 1 — node down from the start (first-address fast fail):
//     - the "Node unreachable" provider banner + "Check Node Connection
//       settings" link appear
//     - only the FIRST address was attempted (later ones skipped)
//     - no row is left stuck "Checking" and the check is no longer running
//
//   CASE 2 — node drops mid-check (short-circuit after consecutive failures):
//     - first address succeeds, then every request is aborted
//     - the same banner appears and the check stops after
//       1 + NODE_UNREACHABLE_CONSECUTIVE_LIMIT (=3) attempts instead of
//       grinding through all six addresses
//     - no row is left stuck "Checking"
//
//   CASE 3 — isolated single blip does NOT short-circuit:
//     - one aborted request sandwiched between successes
//     - all addresses attempted, per-row Error surfaces, NO banner
//
//   CASE 4 — node accepts the connection but never responds (silent hang):
//     - the first /address/ request is stalled indefinitely (never fulfilled)
//     - the NODE_PROBE_TIMEOUT_MS (5s) probe cap on the FIRST address must
//       abort the hung fetch and surface the same "Node unreachable" banner
//       within ~NODE_PROBE_TIMEOUT_MS — NOT hang for the full request timeout
//     - only the first address is attempted, rows reset, Cancel button gone
//
// The network is fully stubbed (Playwright `route`); nothing leaves the machine.
//
// Usage: node scripts/check-pof-node-unreachable-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PROOF_URL = `${BASE_URL}proof-of-funds`;
const SETUP_PASSWORD = 'pof-node-outage-check-123';

// Mirrors NODE_UNREACHABLE_CONSECUTIVE_LIMIT in client/src/lib/blockchain-api.ts.
const CONSECUTIVE_LIMIT = 3;
// Mirrors NODE_PROBE_TIMEOUT_MS in client/src/lib/blockchain-api.ts.
const PROBE_TIMEOUT_MS = 5000;
// Generous slack for headless-Chromium scheduling + React render latency; still
// far below the full per-request timeout a hung fetch would otherwise take.
const PROBE_SLACK_MS = 7000;

// Valid mainnet addresses (same fixtures as the jsdom suite).
const ADDR_A = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const ADDR_B = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const ADDR_C = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const ADDR_D = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ADDR_E = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const ADDR_F = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Default provider is mempool.space (Esplora) on mainnet.
const ESPLORA_HOST_GLOB = 'https://mempool.space/api/**';

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

/** Esplora address-stats JSON body for a given confirmed balance. */
function esploraAddressBody(address, balanceSats) {
  const funded = Math.max(0, balanceSats);
  return JSON.stringify({
    address,
    chain_stats: {
      funded_txo_count: funded > 0 ? 1 : 0,
      funded_txo_sum: funded,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: funded > 0 ? 1 : 0,
    },
    mempool_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    },
  });
}

/** Retry chromium.launch — EAGAIN under parallel validation load. */
async function launchWithRetry(exe, attempts = 3) {
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
      console.log(`[pof-node-unreachable] chromium launch attempt ${i + 1} failed; retrying...`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[pof-node-unreachable] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[pof-node-unreachable] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[pof-node-unreachable] starting dev server (npm run dev) ...`);
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
    console.log(`[pof-node-unreachable] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error') && !t.includes('Failed to fetch')) {
        console.log(`[pof-node-unreachable][page-console] ${t}`);
      }
    });

    // ── Stub the live Esplora provider. `mode` decides per-address behavior:
    //   'fail-all'  : abort every /address/ request (node down from the start)
    //   'fail-after': fulfill ADDR_A, abort everything else (node drops mid-check)
    //   'blip'      : abort only ADDR_B, fulfill the rest (isolated transient)
    //   'stall'     : never respond to /address/ requests at all — the
    //                 connection is accepted but the response never arrives
    //                 (silent-hang outage shape); the page's own probe cap must
    //                 abort the fetch.
    // Aborted routes surface in the page as the browser's real "Failed to
    // fetch" TypeError — exactly what a dead node produces.
    let mode = 'fail-all';
    let addressAttempts = [];
    const stalledRoutes = [];
    await context.route(ESPLORA_HOST_GLOB, async (route) => {
      const url = route.request().url();
      if (url.includes('/blocks/tip/height')) {
        await route.fulfill({ status: 200, contentType: 'text/plain', body: '840000' });
        return;
      }
      const m = url.match(/\/address\/([^/?]+)/);
      if (m) {
        const address = m[1];
        addressAttempts.push(address);
        if (mode === 'stall') {
          // Hold the request open forever: never fulfill, never abort. The
          // page's AbortController (probe cap) is the only thing that can end
          // it. Keep a handle so cleanup can abort any still-pending routes.
          stalledRoutes.push(route);
          return;
        }
        const shouldFail =
          mode === 'fail-all' ||
          (mode === 'fail-after' && address !== ADDR_A) ||
          (mode === 'blip' && address === ADDR_B);
        if (shouldFail) {
          await route.abort('connectionrefused');
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: esploraAddressBody(address, 5000),
          });
        }
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    // Retry the initial goto + first selector: single-shot waits flake under
    // parallel validation load.
    let navigated = false;
    for (let i = 0; i < 3 && !navigated; i++) {
      try {
        await page.goto(PROOF_URL, { waitUntil: 'load', timeout: 60_000 });
        await waitForLoginScreenVisible(page, { timeoutMs: 45_000 });
        navigated = true;
      } catch (err) {
        console.log(`[pof-node-unreachable] initial load attempt ${i + 1} failed: ${err.message}`);
        if (i === 2) throw err;
      }
    }

    // ── Create the vault ────────────────────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD);

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });

    const bodyText = async () => (await page.locator('body').innerText());

    async function runLiveCheck(addresses) {
      await textarea.fill(addresses.join('\n'));
      await page.getByTestId('button-source-live').click();
      await page.getByTestId('button-check-balances').click();
    }

    async function resetIfPossible() {
      const resetBtn = page.getByTestId('button-reset');
      if (await resetBtn.isVisible().catch(() => false)) {
        await resetBtn.click();
        await textarea.waitFor({ state: 'visible', timeout: 10_000 });
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // CASE 1 — node down from the start: fast fail on the FIRST address
    // ════════════════════════════════════════════════════════════════════════
    mode = 'fail-all';
    addressAttempts = [];
    await runLiveCheck([ADDR_A, ADDR_B, ADDR_C]);

    const settingsLink = page.getByTestId('link-node-settings');
    await settingsLink.waitFor({ state: 'visible', timeout: 30_000 });
    const case1Text = await bodyText();
    steps.push({
      name: 'case1: "Node unreachable" banner + settings link appear',
      passed: /node unreachable/i.test(case1Text),
      detail: 'link-node-settings visible; banner text checked',
    });
    steps.push({
      name: 'case1: settings link points at node settings',
      passed:
        (await settingsLink.getAttribute('href')) === '/node-settings' &&
        /check node connection settings/i.test(case1Text),
      detail: `href=${await settingsLink.getAttribute('href')}`,
    });
    // Give any (incorrect) continued grinding a moment to show up.
    await page.waitForTimeout(1500);
    steps.push({
      name: 'case1: only the first address was attempted',
      passed: addressAttempts.length === 1 && addressAttempts[0] === ADDR_A,
      detail: `attempts=${JSON.stringify(addressAttempts)} (expected only ${ADDR_A})`,
    });
    {
      const text = await bodyText();
      const stillChecking = /Checking\b/.test(
        (await page.locator('[data-testid^="row-address-"]').allTextContents()).join(' '),
      );
      const cancelGone = !(await page
        .getByTestId('button-cancel-check')
        .isVisible()
        .catch(() => false));
      steps.push({
        name: 'case1: no row stuck on "Checking" and check is not running',
        passed: !stillChecking && cancelGone,
        detail: `stillChecking=${stillChecking} cancelVisible=${!cancelGone}`,
      });
      void text;
    }

    // ════════════════════════════════════════════════════════════════════════
    // CASE 2 — node drops mid-check: short-circuit after consecutive failures
    // ════════════════════════════════════════════════════════════════════════
    await resetIfPossible();
    mode = 'fail-after';
    addressAttempts = [];
    await runLiveCheck([ADDR_A, ADDR_B, ADDR_C, ADDR_D, ADDR_E, ADDR_F]);

    await settingsLink.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'case2: "Node unreachable" banner appears after mid-check outage',
      passed: /node unreachable/i.test(await bodyText()),
      detail: 'link-node-settings visible after mid-check drop',
    });
    // Let any wrongly-continued requests land before counting.
    await page.waitForTimeout(1500);
    steps.push({
      name: `case2: stopped after 1 success + ${CONSECUTIVE_LIMIT} consecutive failures (not all 6)`,
      passed:
        addressAttempts.length === 1 + CONSECUTIVE_LIMIT && addressAttempts.length < 6,
      detail: `attempts=${addressAttempts.length} (${JSON.stringify(addressAttempts)}), expected ${1 + CONSECUTIVE_LIMIT}`,
    });
    {
      const rowsText = (
        await page.locator('[data-testid^="row-address-"]').allTextContents()
      ).join(' ');
      const cancelGone = !(await page
        .getByTestId('button-cancel-check')
        .isVisible()
        .catch(() => false));
      steps.push({
        name: 'case2: rows reset (none stuck on "Checking"), check not running',
        passed: !/Checking\b/.test(rowsText) && cancelGone,
        detail: `rows="${rowsText.slice(0, 200)}" cancelVisible=${!cancelGone}`,
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // CASE 3 — isolated single blip must NOT short-circuit
    // ════════════════════════════════════════════════════════════════════════
    await resetIfPossible();
    mode = 'blip';
    addressAttempts = [];
    await runLiveCheck([ADDR_A, ADDR_B, ADDR_C]);

    // The check completes normally: Reset button reappears when done.
    await page.getByTestId('button-reset').waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'case3: all addresses attempted despite the isolated blip',
      passed: addressAttempts.length === 3,
      detail: `attempts=${addressAttempts.length} (${JSON.stringify(addressAttempts)})`,
    });
    {
      const rowsText = (
        await page.locator('[data-testid^="row-address-"]').allTextContents()
      ).join(' ');
      const bannerVisible = await settingsLink.isVisible().catch(() => false);
      steps.push({
        name: 'case3: per-row Error surfaced, NO whole-check banner',
        passed: /Error/.test(rowsText) && !bannerVisible,
        detail: `rows="${rowsText.slice(0, 200)}" bannerVisible=${bannerVisible}`,
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // CASE 4 — silently hanging node: connection accepted, response never
    // arrives. The FIRST-address probe cap (NODE_PROBE_TIMEOUT_MS) must abort
    // the hung fetch and surface the banner fast — not freeze for the full
    // per-request timeout.
    // ════════════════════════════════════════════════════════════════════════
    await resetIfPossible();
    mode = 'stall';
    addressAttempts = [];
    const stallStart = Date.now();
    await runLiveCheck([ADDR_A, ADDR_B, ADDR_C]);

    // The banner must appear within ~NODE_PROBE_TIMEOUT_MS. The waitFor
    // timeout itself is the hard gate: PROBE_TIMEOUT_MS + slack is still far
    // below the full request timeout a hung fetch would otherwise consume.
    let stallBannerElapsedMs = null;
    let stallBannerErr = null;
    try {
      await settingsLink.waitFor({
        state: 'visible',
        timeout: PROBE_TIMEOUT_MS + PROBE_SLACK_MS,
      });
      stallBannerElapsedMs = Date.now() - stallStart;
    } catch (err) {
      stallBannerErr = err;
    }
    const case4Text = stallBannerErr ? '' : await bodyText();
    steps.push({
      name: `case4: banner + settings link appear within ~${PROBE_TIMEOUT_MS}ms probe cap on a silently hanging node`,
      passed:
        stallBannerElapsedMs !== null &&
        /node unreachable/i.test(case4Text) &&
        /check node connection settings/i.test(case4Text),
      detail: stallBannerErr
        ? `banner did NOT appear within ${PROBE_TIMEOUT_MS + PROBE_SLACK_MS}ms: ${stallBannerErr.message}`
        : `elapsed=${stallBannerElapsedMs}ms (cap ${PROBE_TIMEOUT_MS}ms + slack ${PROBE_SLACK_MS}ms)`,
    });
    steps.push({
      name: 'case4: probe-cap fail is fast (elapsed >= probe cap, < cap + slack)',
      passed:
        stallBannerElapsedMs !== null &&
        stallBannerElapsedMs >= PROBE_TIMEOUT_MS - 250 &&
        stallBannerElapsedMs < PROBE_TIMEOUT_MS + PROBE_SLACK_MS,
      detail: `elapsed=${stallBannerElapsedMs}ms`,
    });
    // Give any (incorrect) continued grinding a moment to show up.
    await page.waitForTimeout(1500);
    steps.push({
      name: 'case4: only the first address was attempted (later ones skipped)',
      passed: addressAttempts.length === 1 && addressAttempts[0] === ADDR_A,
      detail: `attempts=${JSON.stringify(addressAttempts)} (expected only ${ADDR_A})`,
    });
    {
      const rowsText = (
        await page.locator('[data-testid^="row-address-"]').allTextContents()
      ).join(' ');
      const cancelGone = !(await page
        .getByTestId('button-cancel-check')
        .isVisible()
        .catch(() => false));
      steps.push({
        name: 'case4: rows reset (none stuck on "Checking"), Cancel button gone',
        passed: !/Checking\b/.test(rowsText) && cancelGone,
        detail: `rows="${rowsText.slice(0, 200)}" cancelVisible=${!cancelGone}`,
      });
    }
    // Release any still-held stalled routes so shutdown doesn't hang.
    for (const r of stalledRoutes) {
      await r.abort('timedout').catch(() => {});
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
  console.log(`[pof-node-unreachable] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[pof-node-unreachable] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log(
    '[pof-node-unreachable] PASSED: node-outage fast-fail, mid-check short-circuit, isolated-blip, and silent-hang probe-cap behavior all hold in a real browser.',
  );
}

main().catch((err) => {
  console.error('[pof-node-unreachable] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
