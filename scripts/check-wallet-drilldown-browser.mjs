#!/usr/bin/env node
// Real-browser regression guard for the Wallet Overview → Records drill-down
// (Task #1780).
//
// NOTE for reviewers: the drill-down lands on "/" which is the Records
// *dashboard* — client/src/pages/Dashboard.tsx — NOT client/src/pages/
// Records.tsx. The `?walletName=` consumer (URL_WALLET_FILTER_ID effect that
// installs the Wallet Name column filter and flips includeBlockchainDiscovered)
// lives in Dashboard.tsx (see the `[location]` effect near the top of the
// component) and is unit-covered by Dashboard.hiddenMatches.test.tsx.
//
// The Wallet Overview row's external-link icon navigates to
// `/?walletName=<name>` (wouter pushState). The Records dashboard must read
// that query param, apply it as a Wallet Name column filter, and auto-include
// blockchain-discovered records so the wallet's rows are visible even when
// most of them are discovery-tier. jsdom tests cover the effect logic; this
// script confirms the live wiring — a REAL client-side navigation, the
// browser-mode query-string read (the original dead-link root cause was
// wouter's browser-mode location not carrying the query string), and the
// DB-level discovered-tier reload — in headless Chromium.
//
// Flow:
//   1. Fresh vault via the setup form.
//   2. Seed (Vite dynamic import of the live CRUD singleton):
//      - "DrillWallet": 1 curated manual anchor address (Wallet Overview only
//        lists wallets with curated rows) + 3 blockchain-discovered addresses,
//        all stamped walletName=DrillWallet;
//      - "OtherWallet": 1 curated address (must NOT leak into the filtered view);
//      - 1 wallet-less address (must NOT leak either).
//   3. Reload once, open /wallet-overview, click the DrillWallet row's
//      external-link icon.
//   4. Assert the Records dashboard shows all 4 DrillWallet rows (including
//      the 3 discovered-tier ones — proving auto-include), the discovered
//      toggle is on, and neither the OtherWallet row nor the wallet-less row
//      appears (proving the Wallet Name filter applied). Never "No records
//      found".
//
// Everything runs offline against local IndexedDB — no network requests.
// Usage: node scripts/check-wallet-drilldown-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const WALLET_OVERVIEW_URL = `${BASE_URL}wallet-overview`;
const SETUP_PASSWORD = 'wallet-drilldown-check-123';

const DRILL_WALLET = 'DrillWallet';

// Every first-8-chars prefix differs (testid/text-collision hygiene).
const SEED = {
  curatedAnchor: {
    addr: 'bc1qdrila0curatedanchor0000000000000000001',
    label: 'Drill curated anchor',
  },
  discovered: [
    { addr: 'bc1qdrlb1discovered000000000000000000001', label: 'Drill discovered 1' },
    { addr: 'bc1qdrlc2discovered000000000000000000002', label: 'Drill discovered 2' },
    { addr: 'bc1qdrld3discovered000000000000000000003', label: 'Drill discovered 3' },
  ],
  otherWallet: {
    addr: 'bc1qother0walletrow0000000000000000000004',
    label: 'Other wallet row',
  },
  noWallet: {
    addr: 'bc1qnowall0etrow00000000000000000000000005',
    label: 'No wallet row',
  },
};

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
      console.log(`[wallet-drilldown-browser] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}



/** Visible Records-table row labels (trimmed). */
async function rowLabels(page) {
  return page
    .locator('[data-testid^="row-record-"] [data-testid^="text-label-"]')
    .allTextContents()
    .then((texts) => texts.map((t) => t.trim()));
}

/**
 * Poll until the visible row-label SET contains every `expected` label (by
 * prefix — the label cell can append badge text) and none of `forbidden`.
 */
async function waitForRowSet(page, expected, forbidden, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await rowLabels(page);
    const hasAll = expected.every((e) => last.some((l) => l.startsWith(e)));
    const hasNone = forbidden.every((f) => !last.some((l) => l.startsWith(f)));
    if (hasAll && hasNone && last.length === expected.length) {
      return { ok: true, last };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, last };
}

async function main() {
  const exe = resolveChromium();
  console.log(`[wallet-drilldown-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[wallet-drilldown-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[wallet-drilldown-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[wallet-drilldown-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => the "Create Vault" setup form.
    // Block the PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[wallet-drilldown-browser][page-console] ${t}`);
      }
    });

    await page.goto(WALLET_OVERVIEW_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    const created = await unlockIfNeeded(page, SETUP_PASSWORD);
    steps.push({
      name: 'setup: fresh vault created and unlocked',
      passed: created === true,
      detail: `created=${created}`,
    });

    // ── Seed the records ───────────────────────────────────────────────────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // module writes to the exact same Dexie instance the page reads.
    const seedResult = await page.evaluate(async (seed) => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const drill = 'DrillWallet';
      await recordCrud.createRecord({
        type: 'address',
        inputString: seed.curatedAnchor.addr,
        label: seed.curatedAnchor.label,
        walletName: drill,
        source: 'manual',
        addressImportance: 'manual',
      });
      for (const d of seed.discovered) {
        await recordCrud.createRecord({
          type: 'address',
          inputString: d.addr,
          label: d.label,
          walletName: drill,
          source: 'blockchain-sync',
          addressImportance: 'blockchain-discovered',
        });
      }
      await recordCrud.createRecord({
        type: 'address',
        inputString: seed.otherWallet.addr,
        label: seed.otherWallet.label,
        walletName: 'OtherWallet',
        source: 'manual',
        addressImportance: 'manual',
      });
      await recordCrud.createRecord({
        type: 'address',
        inputString: seed.noWallet.addr,
        label: seed.noWallet.label,
        source: 'manual',
        addressImportance: 'manual',
      });
      return true;
    }, SEED);
    steps.push({
      name: 'seed: DrillWallet (1 curated + 3 discovered) + OtherWallet + wallet-less rows',
      passed: seedResult === true,
      detail: 'created 6 records via live CRUD singleton',
    });

    // ── Reload once so the Wallet Overview aggregation sees the seed ──────
    await page.goto(WALLET_OVERVIEW_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD);

    const drillRow = page.getByTestId(`row-wallet-${DRILL_WALLET}`);
    await drillRow.waitFor({ state: 'visible', timeout: 45_000 });
    steps.push({
      name: 'wallet overview: DrillWallet row renders',
      passed: true,
      detail: (await drillRow.textContent()) ?? '',
    });

    // ── Click the external-link icon (real wouter pushState navigation) ───
    await page.getByTestId(`button-view-${DRILL_WALLET}`).click();

    // Client-side navigation: URL must carry the walletName query param.
    await page.waitForFunction(
      () => window.location.search.includes('walletName=DrillWallet'),
      undefined,
      { timeout: 15_000 },
    );
    const landedUrl = page.url();
    steps.push({
      name: 'drill-down: navigates to /?walletName=DrillWallet without a page load',
      passed: landedUrl.includes('/?walletName=DrillWallet'),
      detail: `url = ${landedUrl}`,
    });

    // ── Records dashboard: all 4 DrillWallet rows, nothing else ───────────
    const expected = [
      SEED.curatedAnchor.label,
      ...SEED.discovered.map((d) => d.label),
    ];
    const forbidden = [SEED.otherWallet.label, SEED.noWallet.label];
    const { ok, last } = await waitForRowSet(page, expected, forbidden);
    steps.push({
      name: 'records: exactly the 4 DrillWallet rows visible (incl. 3 discovered-tier)',
      passed: ok,
      detail: ok
        ? `rows = ${last.join(' | ')}`
        : `got [${last.join(' | ')}] (expected exactly ${expected.join(' | ')})`,
    });

    const noRecords = await page
      .getByText(/No records found/i)
      .count()
      .catch(() => 0);
    steps.push({
      name: 'records: no "No records found" dead-end',
      passed: noRecords === 0,
      detail: `"No records found" count=${noRecords}`,
    });

    // Discovered records were auto-included (blockchain toggle flipped on).
    const toggleClass =
      (await page
        .getByTestId('button-blockchain-toggle')
        .getAttribute('class')
        .catch(() => null)) ?? '';
    steps.push({
      name: 'records: blockchain-discovered toggle auto-enabled',
      passed: toggleClass.includes('text-primary'),
      detail: `toggle class = ${JSON.stringify(toggleClass)}`,
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
  console.log(`[wallet-drilldown-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[wallet-drilldown-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[wallet-drilldown-browser] PASSED: the Wallet Overview drill-down lands on the Records dashboard with the Wallet Name filter applied and discovered rows auto-included, end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[wallet-drilldown-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
