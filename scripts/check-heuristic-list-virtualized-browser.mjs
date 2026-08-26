#!/usr/bin/env node
// Real-browser regression guard for the VIRTUALIZED heuristic-address list on
// the Balance page (client/src/pages/BalanceOverview.tsx,
// VirtualizedHeuristicList inside the list-heuristic-addresses block).
//
// The "Show affected addresses" detail list under the heuristic-mode banner
// was switched from a plain DOM list (one node per address) to a
// @tanstack/react-virtual window. On large vaults the heuristic set runs into
// the thousands; if virtualization regresses (e.g. someone maps over
// `addresses` directly again, or the scroll container / measureElement wiring
// breaks) the page would mount thousands of rows and freeze. jsdom unit tests
// only cover a 2-address case and cannot exercise layout/scroll, so this must
// be proven in a real browser.
//
// What this script does:
//   1. Creates a fresh vault, then seeds via the live Vite module singletons
//      (same-origin dynamic imports => same Dexie instance):
//        - THOUSANDS of input-role participants with distinct fake addresses
//          and NO prevTxid/prevVout (bulkAddParticipants), which makes
//          buildHasPrevoutByAddress classify every one as heuristic-matched;
//        - ONE valid mainnet address (with a record, required by
//          syncSingleAddress) seeded LAST so it lands at the tail of the list;
//        - node settings pointing at the mempool-space provider.
//   2. Intercepts all https://mempool.space/api/** requests with canned
//      responses (tip height, empty tx history), so the per-row Re-sync runs
//      the REAL provider code path deterministically with no live network.
//   3. Opens /balance, expands "Show affected addresses", and asserts only a
//      small window of row-heuristic-address-* nodes is mounted even though
//      the banner reports thousands.
//   4. Steps the scroll container downward, asserting each step reveals new
//      rows promptly (responsiveness) while the mounted-row count stays small.
//   5. At the bottom, verifies the tail row (the valid address) is now
//      mounted, copies it via the per-row copy button, and clicks its per-row
//      Re-sync — then asserts every intercepted /address/... request targeted
//      exactly that address (per-row actions still hit the right row after
//      scrolling through thousands of virtualized entries).
//
// NOTE for reviewers: the list under test renders at /balance via
// client/src/pages/BalanceOverview.tsx (VirtualizedHeuristicList); rows carry
// data-testid row-heuristic-address-<address>.
//
// Usage: node scripts/check-heuristic-list-virtualized-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'heuristic-virtual-check-123';

// Thousands of fake heuristic addresses + one valid tail address. The fakes
// only need to LOOK like addresses (they are display-only rows); the tail
// address must pass validateAddress because its per-row Re-sync runs the real
// syncSingleAddress path (against intercepted network).
const FAKE_COUNT = 3000;
const TAIL_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; // valid bech32 (BIP-173 test vector)
// Mounted-row ceiling: ~280px viewport / 44px rows + overscan 20 both sides
// (~47 expected). 120 leaves headroom for measurement jitter while still
// failing loudly if all 3001 rows mount.
const MAX_MOUNTED_ROWS = 120;

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

/** Fill the setup/unlock form when it is showing; no-op otherwise. */
/** chromium.launch can hit EAGAIN under parallel-validation load; retry. */
async function launchChromiumWithRetry(exe, attempts = 3) {
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
      console.log(`[heuristic-virtual] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Count currently-mounted virtualized rows + collect their addresses. */
async function sampleMountedRows(page) {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid^="row-heuristic-address-"]'),
    );
    return {
      count: rows.length,
      addresses: rows.map((r) =>
        r.getAttribute('data-testid').replace('row-heuristic-address-', ''),
      ),
    };
  });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[heuristic-virtual] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[heuristic-virtual] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[heuristic-virtual] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[heuristic-virtual] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchChromiumWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => vault setup form on first load.
    // Block the PWA service worker so it cannot serve a stale bundle.
    const context = await browser.newContext({
      serviceWorkers: 'block',
      permissions: ['clipboard-read', 'clipboard-write'],
    });

    // ── Intercept the provider API so the per-row Re-sync runs the real code
    //    path deterministically (no live network, no rate limits). Every
    //    /address/<addr>/... URL is recorded to prove targeting. ─────────────
    const addressRequests = [];
    await context.route('https://mempool.space/**', async (route) => {
      const url = route.request().url();
      const path = new URL(url).pathname;
      const addrMatch = /\/address\/([^/]+)/.exec(path);
      if (addrMatch) addressRequests.push(decodeURIComponent(addrMatch[1]));
      if (path.endsWith('/blocks/tip/height')) {
        return route.fulfill({ status: 200, contentType: 'text/plain', body: '800000' });
      }
      if (/\/address\/[^/]+\/txs/.test(path)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      if (addrMatch) {
        // Address info (tx-count threshold check): empty history.
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            address: addrMatch[1],
            chain_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
            mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
          }),
        });
      }
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not mocked' });
    });

    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[heuristic-virtual][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault (retry the initial goto: cold Vite builds flake) ──
    let landed = false;
    for (let i = 0; i < 2 && !landed; i++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
        landed = true;
      } catch (err) {
        if (i === 1) throw err;
        console.log(`[heuristic-virtual] initial load retry after: ${err.message}`);
      }
    }
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed via the LIVE Vite module singletons ───────────────────────────
    // buildHasPrevoutByAddress scans input-role participants only, so fake
    // display-only heuristic rows need just participants (no records, no tx
    // rows). The tail address additionally needs a record because
    // syncSingleAddress refuses addresses without one. Participants insert in
    // primary-key order, and the heuristic list preserves that scan order, so
    // seeding the tail address LAST puts it at the end of the list.
    const seed = await page.evaluate(
      async ({ fakeCount, tailAddr }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const nodeCrud = await import('/src/lib/data/node-settings-crud.ts');

        const txid = 'a1b2'.repeat(16);
        const fakeAddresses = [];
        for (let i = 0; i < fakeCount; i++) {
          fakeAddresses.push(`bc1qsim${String(i).padStart(6, '0')}virtualcheckrow${String(i % 97).padStart(2, '0')}`);
        }
        // Input participants with NO prevTxid/prevVout => heuristic-matched.
        const batch = 500;
        for (let i = 0; i < fakeAddresses.length; i += batch) {
          await txCrud.bulkAddParticipants(
            fakeAddresses.slice(i, i + batch).map((address) => ({
              txid,
              role: 'input',
              address,
              amount: 1000,
            })),
            { skipNotification: true },
          );
        }
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: tailAddr,
          label: 'Virtualized heuristic tail address',
        });
        await txCrud.addParticipant({
          txid,
          role: 'input',
          address: tailAddr,
          amount: 5000,
          recordId,
        });
        await nodeCrud.putNodeSettings({
          id: 'default',
          providerType: 'mempool-space',
          useTor: false,
          requestTimeout: 30000,
          network: 'mainnet',
          allowLocalNetwork: false,
          trustedLocalHosts: [],
        });
        return { recordId, seeded: fakeAddresses.length + 1 };
      },
      { fakeCount: FAKE_COUNT, tailAddr: TAIL_ADDR },
    );
    steps.push({
      name: `seeded ${FAKE_COUNT + 1} heuristic-matched addresses + provider settings`,
      passed: seed.seeded === FAKE_COUNT + 1 && Number.isInteger(seed.recordId),
      detail: `seeded=${seed.seeded}, tail recordId=${seed.recordId}`,
    });

    // ── Balance page: navigate AFTER seeding so the mount-time count read
    //    sees the data. ──────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}balance`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    const banner = page.getByTestId('banner-heuristic-warning');
    await banner.waitFor({ state: 'visible', timeout: 60_000 });
    const bannerText = await banner.textContent();
    const expectedCount = (FAKE_COUNT + 1).toLocaleString('en-US');
    steps.push({
      name: 'banner reports the full thousands-scale count',
      passed: bannerText.includes(expectedCount),
      detail: bannerText.includes(expectedCount)
        ? `banner mentions ${expectedCount} addresses`
        : `banner text missing "${expectedCount}": ${bannerText.slice(0, 200)}`,
    });

    // ── Expand the list; only a small window of rows may mount. ────────────
    await page.getByTestId('button-toggle-heuristic-details').click();
    const scrollBox = page.getByTestId('scroll-heuristic-addresses');
    await scrollBox.waitFor({ state: 'visible', timeout: 30_000 });
    // Let the virtualizer settle (measureElement pass).
    await page.waitForTimeout(500);

    const initial = await sampleMountedRows(page);
    steps.push({
      name: `only a small row window mounts at the top (<= ${MAX_MOUNTED_ROWS} of ${FAKE_COUNT + 1})`,
      passed: initial.count > 0 && initial.count <= MAX_MOUNTED_ROWS,
      detail: `${initial.count} row-heuristic-address-* nodes in the DOM`,
    });
    steps.push({
      name: 'tail address is NOT mounted before scrolling',
      passed: !initial.addresses.includes(TAIL_ADDR),
      detail: initial.addresses.includes(TAIL_ADDR)
        ? 'tail row already in DOM at scrollTop=0 (virtualization not windowing?)'
        : 'tail row absent at top, as expected',
    });

    // ── Step-scroll downward: each step must reveal a NEW row window quickly
    //    (responsiveness) and the mounted count must stay small. ────────────
    const STEPS = 10;
    const scrollInfo = await scrollBox.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    const totalScrollable = scrollInfo.scrollHeight - scrollInfo.clientHeight;
    // Sanity: 3001 rows * ~44px ≈ 132k px of virtual height.
    steps.push({
      name: 'virtual scroll height covers all rows',
      passed: scrollInfo.scrollHeight > FAKE_COUNT * 30,
      detail: `scrollHeight=${scrollInfo.scrollHeight}px for ${FAKE_COUNT + 1} rows (clientHeight=${scrollInfo.clientHeight}px)`,
    });

    let maxMounted = initial.count;
    let slowestStepMs = 0;
    let stepsRevealingNewRows = 0;
    let prevAddresses = new Set(initial.addresses);
    for (let s = 1; s <= STEPS; s++) {
      const target = Math.round((totalScrollable * s) / STEPS);
      const t0 = Date.now();
      await scrollBox.evaluate((el, top) => { el.scrollTop = top; }, target);
      // Wait until the row window has caught up with the new offset.
      let sample = null;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        sample = await sampleMountedRows(page);
        const hasNew = sample.addresses.some((a) => !prevAddresses.has(a));
        if (hasNew && sample.count > 0) break;
        await page.waitForTimeout(50);
      }
      const elapsed = Date.now() - t0;
      slowestStepMs = Math.max(slowestStepMs, elapsed);
      maxMounted = Math.max(maxMounted, sample?.count ?? 0);
      if (sample && sample.addresses.some((a) => !prevAddresses.has(a))) {
        stepsRevealingNewRows++;
      }
      prevAddresses = new Set(sample?.addresses ?? []);
    }
    steps.push({
      name: `each of ${STEPS} scroll steps revealed new rows promptly`,
      passed: stepsRevealingNewRows === STEPS && slowestStepMs < 5_000,
      detail: `${stepsRevealingNewRows}/${STEPS} steps revealed new rows; slowest step ${slowestStepMs}ms`,
    });
    steps.push({
      name: `mounted-row count stays small while scrolling (max <= ${MAX_MOUNTED_ROWS})`,
      passed: maxMounted <= MAX_MOUNTED_ROWS,
      detail: `max mounted rows observed across all steps: ${maxMounted}`,
    });

    // ── Bottom of the list: the tail (valid) address row must be mounted.
    //    Row heights are measured lazily (measureElement), so scrollHeight
    //    keeps growing as new windows mount — converge on the true bottom by
    //    re-scrolling until scrollTop is stable at scrollHeight. ────────────
    await scrollBox.evaluate(async (el) => {
      for (let i = 0; i < 60; i++) {
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 150));
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          // Stable? Give the virtualizer one more beat and re-check.
          await new Promise((r) => setTimeout(r, 200));
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return;
        }
      }
    });
    const tailRow = page.getByTestId(`row-heuristic-address-${TAIL_ADDR}`);
    const tailVisible = await tailRow
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'scrolling to the bottom reveals the last-seeded address',
      passed: tailVisible,
      detail: tailVisible
        ? `row-heuristic-address-${TAIL_ADDR} mounted after scrolling`
        : 'tail row never mounted at the bottom of the list',
    });
    if (!tailVisible) {
      const bottom = await sampleMountedRows(page);
      for (const step of steps) {
        console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
      }
      console.log(
        `[heuristic-virtual] bottom sample: ${bottom.count} rows, last=${JSON.stringify(bottom.addresses.slice(-3))}`,
      );
      throw new Error('tail row not reachable; aborting action checks');
    }

    // ── Per-row copy still targets the right row after scrolling. ──────────
    await page.getByTestId(`button-copy-heuristic-address-${TAIL_ADDR}`).click();
    let clipboardText = null;
    try {
      clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    } catch {
      /* clipboard read can be flaky in headless; fall back to the Check icon below */
    }
    // The row also swaps its Copy icon for a Check while copiedKey matches.
    const copyConfirmed =
      clipboardText === TAIL_ADDR ||
      (await page
        .waitForFunction(
          (addr) => {
            const btn = document.querySelector(`[data-testid="button-copy-heuristic-address-${addr}"]`);
            return !!btn; // button still present; icon swap is cosmetic
          },
          TAIL_ADDR,
          { timeout: 3_000 },
        )
        .then(() => clipboardText === TAIL_ADDR)
        .catch(() => false));
    steps.push({
      name: 'per-row copy button copies the correct address',
      passed: copyConfirmed,
      detail: copyConfirmed
        ? `clipboard contains "${TAIL_ADDR}"`
        : `clipboard read gave ${JSON.stringify(clipboardText)}`,
    });

    // ── Per-row Re-sync still targets the right address after scrolling. ───
    addressRequests.length = 0;
    const resyncBtn = page.getByTestId(`button-resync-heuristic-address-${TAIL_ADDR}`);
    await resyncBtn.click();

    // The run finishes when the button re-enables (mocked network is fast).
    await page
      .waitForFunction(
        (addr) => {
          const btn = document.querySelector(`[data-testid="button-resync-heuristic-address-${addr}"]`);
          return btn && !btn.disabled;
        },
        TAIL_ADDR,
        { timeout: 60_000 },
      )
      .catch(() => {});

    const targeted = addressRequests.filter((a) => a === TAIL_ADDR);
    const strays = addressRequests.filter((a) => a !== TAIL_ADDR);
    steps.push({
      name: 'per-row Re-sync fetched exactly the clicked address',
      passed: targeted.length > 0 && strays.length === 0,
      detail:
        `provider /address requests: ${addressRequests.length} total, ` +
        `${targeted.length} for the clicked address, strays=${JSON.stringify([...new Set(strays)]).slice(0, 200)}`,
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
  console.log(`[heuristic-virtual] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[heuristic-virtual] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log(
    '[heuristic-virtual] PASSED: with thousands of heuristic addresses only a small row window mounts, scrolling stays responsive, and per-row copy/Re-sync target the correct address after scrolling.',
  );
}

main().catch((err) => {
  console.error('[heuristic-virtual] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
