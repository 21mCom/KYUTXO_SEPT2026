#!/usr/bin/env node
// Real-browser regression guard for the VIRTUALIZED expanded wallet-group
// address list on the Balance page (client/src/pages/BalanceOverview.tsx,
// GroupAddressRows — the second @tanstack/react-virtual list on that page,
// distinct from the heuristic-banner list covered by
// scripts/check-heuristic-list-virtualized-browser.mjs).
//
// When a wallet group is expanded, GroupAddressRows renders every cached
// address row for the group. On large wallets that set runs into the
// thousands; if virtualization regresses (someone maps over `rows` directly,
// or the scroll container / measureElement wiring breaks) the page would
// mount thousands of DOM nodes and freeze. jsdom unit tests only exercise
// tiny row counts and cannot prove layout/scroll behavior, so this must be
// verified in a real browser.
//
// What this script does:
//   1. Creates a fresh vault, then seeds via the live Vite module singletons
//      (same-origin dynamic imports => same Dexie instance): THOUSANDS of
//      curated address records (addressImportance 'manual') that all share
//      one walletName and carry cached per-address stats
//      (cachedBalanceSats/cachedUtxoCount/statsComputedAt), which is exactly
//      what makes them appear inside the expanded group.
//   2. Opens /balance, waits for the group card, expands it, and asserts only
//      a small window of row-address-* nodes is mounted even though the group
//      reports thousands of addresses.
//   3. Step-scrolls the group's scroll container downward, asserting each
//      step reveals new rows promptly while the mounted count stays bounded.
//   4. Converges on the true bottom of the list (row heights are measured
//      lazily) and verifies the lowest-balance tail row — a valid mainnet
//      address seeded with the smallest sats value, so the sats-descending
//      sort pins it to the very end — is mounted; then clicks its per-row
//      copy button and asserts the clipboard holds exactly that address
//      (per-row actions still target the right row after deep scrolling).
//   5. Per-row Resolve targeting: the tail row AND its immediate neighbor
//      (second-lowest balance, rendered directly above it) are each seeded
//      with ONE resolvable pending spend — a blank-address input participant
//      whose (prevTxid, prevVout) maps to a locally-known output owned by that
//      row's record. Both rows therefore show the yellow "N pending" badge and
//      "Resolve" button. Clicking the deep-scrolled tail row's Resolve runs
//      handleResolveAddress -> resolvePrevouts({ restrictToRecordIds:
//      new Set([recordId]) }), which is LOCAL-only (never hits the network),
//      so targeting is proven via database effects instead of intercepted
//      provider requests: exactly the tail's blank input must gain
//      address/recordId, while the adjacent neighbor's must stay blank. A
//      virtualization/keying regression (off-by-one row index, stale key)
//      would resolve the neighbor instead and fail both assertions.
//
// NOTE for reviewers: the list under test renders at /balance via
// client/src/pages/BalanceOverview.tsx (GroupAddressRows); rows carry
// data-testid row-address-<address> and the scroll container carries
// data-testid scroll-group-address-rows.
//
// Usage: node scripts/check-group-address-rows-virtualized-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'group-rows-virtual-check-123';

const WALLET_NAME = 'VirtualCheckWallet';
// Thousands of fake curated addresses + one valid tail address. The fakes only
// need to LOOK like addresses (display-only rows); the tail address is a real
// bech32 string so the copied clipboard value is a plausible address.
const FAKE_COUNT = 3000;
const TAIL_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; // valid bech32 (BIP-173 test vector)
// Rendered directly ABOVE the tail row (second-lowest balance). Gets its own
// pending spend so a Resolve keying/off-by-one regression has a concrete wrong
// target to hit — and we can assert it was NOT touched.
const NEIGHBOR_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // valid bech32 (BIP-173 test vector)
// Mounted-row ceiling: ~384px viewport (max-h-96) / ~34px rows + overscan 12
// both sides (~36 expected). 120 leaves headroom for measurement jitter while
// still failing loudly if all 3001 rows mount.
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
async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await dismissMigrationOverlayIfPresent(page);
    return false;
  }
  await pwInput.fill(SETUP_PASSWORD);
  const confirmInput = page.getByTestId('input-confirm-password');
  if (await confirmInput.isVisible().catch(() => false)) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
  return true;
}

/**
 * The legacy-migration overlay (z-index 9999) can appear right after unlock
 * and intercepts all pointer events while visible. Wait it out / dismiss it.
 */
async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[group-rows-virtual] legacy-migration overlay detected; waiting it out ...');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await overlay.isVisible().catch(() => false))) return;
    const dismiss = page.getByTestId('button-dismiss-migration');
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  throw new Error('legacy-migration overlay did not clear within 60s');
}

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
      console.log(`[group-rows-virtual] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Count currently-mounted group-address rows + collect their addresses. */
async function sampleMountedRows(page) {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid^="row-address-"]'),
    );
    return {
      count: rows.length,
      addresses: rows.map((r) =>
        r.getAttribute('data-testid').replace('row-address-', ''),
      ),
    };
  });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[group-rows-virtual] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[group-rows-virtual] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[group-rows-virtual] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    console.log(`[group-rows-virtual] dev server ready at ${BASE_URL}`);
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
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[group-rows-virtual][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault (retry the initial goto: cold Vite builds flake) ──
    let landed = false;
    for (let i = 0; i < 2 && !landed; i++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await unlockIfNeeded(page);
        landed = true;
      } catch (err) {
        if (i === 1) throw err;
        console.log(`[group-rows-virtual] initial load retry after: ${err.message}`);
      }
    }
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed via the LIVE Vite module singletons ───────────────────────────
    // A record appears in an expanded group when it is a curated address
    // (isUserCuratedImportance) with cachedUtxoCount > 0 and the group's
    // walletName. buildFullRecord spreads the input, so the cached stats
    // fields pass straight through bulkCreateRecords. Rows are sorted by
    // sats DESC when the group is expanded, so the tail address gets the
    // SMALLEST balance to pin it to the very bottom of the list.
    const seed = await page.evaluate(
      async ({ fakeCount, tailAddr, neighborAddr, walletName }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const settingsCrud = await import('/src/lib/data/settings-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        // Mark the balance formula as current, or the page's one-time
        // formula-upgrade recompute would run recomputeAddressStats and wipe
        // the seeded cached stats (no real tx data backs them).
        await settingsCrud.updateSettings('default', { balanceFormulaVersion: 2 }, { skipNotification: true });
        const now = Date.now();
        const mk = (inputString, sats) => ({
          type: 'address',
          inputString,
          walletName,
          addressImportance: 'manual',
          cachedBalanceSats: sats,
          cachedUtxoCount: 1,
          cachedTxCount: 1,
          cachedLastActivityTime: now,
          statsComputedAt: now,
        });
        const records = [];
        for (let i = 0; i < fakeCount; i++) {
          // Unique fake bech32-looking strings; sats strictly descending with
          // index so the on-page sort order is deterministic.
          records.push(
            mk(
              `bc1qsim${String(i).padStart(6, '0')}groupvirtualrow${String(i % 97).padStart(2, '0')}`,
              1_000_000 + (fakeCount - i) * 10,
            ),
          );
        }
        records.push(mk(neighborAddr, 2)); // second-lowest => second-to-last row
        records.push(mk(tailAddr, 1)); // lowest balance => last row after sort
        const batch = 500;
        let created = 0;
        for (let i = 0; i < records.length; i += batch) {
          const ids = await recordCrud.bulkCreateRecords(records.slice(i, i + batch), {
            skipVocabularySync: true,
            skipNotification: true,
          });
          created += ids.length;
        }

        // Look up the two real record ids (bulkCreateRecords returns ids in
        // insert order, but resolving by inputString is unambiguous).
        const [tailRecord] = await recordCrud.getRecordsByInputString(tailAddr);
        const [neighborRecord] = await recordCrud.getRecordsByInputString(neighborAddr);
        const tailId = tailRecord?.id ?? null;
        const neighborId = neighborRecord?.id ?? null;

        // One resolvable pending spend for EACH of the two bottom rows:
        //  - an OUTPUT participant on a source tx, owned by the row's record;
        //  - a blank-address INPUT participant on a spend tx whose
        //    prevTxid/prevVout point at that output.
        // getUnresolvedSpendBreakdown maps each blank input to its source
        // record, which is what puts the "1 pending" badge + Resolve button on
        // both rows. resolvePrevouts (restricted) attributes the input by
        // filling in address/amount/recordId from the locally-known output.
        const srcTailTxid = 'f1'.repeat(32);
        const spendTailTxid = 'f2'.repeat(32);
        const srcNeighborTxid = 'f3'.repeat(32);
        const spendNeighborTxid = 'f4'.repeat(32);
        await txCrud.bulkAddParticipants(
          [
            { txid: srcTailTxid, role: 'output', vout: 0, address: tailAddr, amount: 5000, recordId: tailId ?? undefined },
            { txid: spendTailTxid, role: 'input', address: '', amount: 0, prevTxid: srcTailTxid, prevVout: 0 },
            { txid: srcNeighborTxid, role: 'output', vout: 0, address: neighborAddr, amount: 7000, recordId: neighborId ?? undefined },
            { txid: spendNeighborTxid, role: 'input', address: '', amount: 0, prevTxid: srcNeighborTxid, prevVout: 0 },
          ],
          { skipNotification: true },
        );
        return { created, tailId, neighborId, spendTailTxid, spendNeighborTxid };
      },
      { fakeCount: FAKE_COUNT, tailAddr: TAIL_ADDR, neighborAddr: NEIGHBOR_ADDR, walletName: WALLET_NAME },
    );
    steps.push({
      name: `seeded ${FAKE_COUNT + 2} curated address records + 2 pending spends (tail & neighbor)`,
      passed:
        seed.created === FAKE_COUNT + 2 &&
        Number.isInteger(seed.tailId) &&
        Number.isInteger(seed.neighborId),
      detail: `created=${seed.created}, tailId=${seed.tailId}, neighborId=${seed.neighborId}`,
    });

    // ── Balance page: navigate AFTER seeding so the aggregation sees the
    //    data, then wait for the group card (phase "ready"). ────────────────
    await page.goto(`${BASE_URL}balance`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const groupCard = page.getByTestId(`card-group-${WALLET_NAME}`);
    await groupCard.waitFor({ state: 'visible', timeout: 120_000 });
    const groupText = await groupCard.textContent();
    const expectedCount = `${(FAKE_COUNT + 2).toLocaleString('en-US')} addr`;
    const plainCount = `${FAKE_COUNT + 2} addr`;
    steps.push({
      name: 'group card reports the full thousands-scale address count',
      passed: groupText.includes(expectedCount) || groupText.includes(plainCount),
      detail: `group card text: ${groupText.slice(0, 200)}`,
    });

    // ── Expand the group; only a small window of rows may mount. ───────────
    await page.getByTestId(`button-expand-${WALLET_NAME}`).click();
    const scrollBox = page.getByTestId('scroll-group-address-rows');
    await scrollBox.waitFor({ state: 'visible', timeout: 60_000 });
    // Let the row load + virtualizer measureElement pass settle.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="row-address-"]').length > 0, undefined,
      { timeout: 60_000 },
    );
    await page.waitForTimeout(500);

    const initial = await sampleMountedRows(page);
    steps.push({
      name: `only a small row window mounts at the top (<= ${MAX_MOUNTED_ROWS} of ${FAKE_COUNT + 2})`,
      passed: initial.count > 0 && initial.count <= MAX_MOUNTED_ROWS,
      detail: `${initial.count} row-address-* nodes in the DOM`,
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
    // Sanity: 3001 rows * ~34px ≈ 102k px of virtual height.
    steps.push({
      name: 'virtual scroll height covers all rows',
      passed: scrollInfo.scrollHeight > FAKE_COUNT * 25,
      detail: `scrollHeight=${scrollInfo.scrollHeight}px for ${FAKE_COUNT + 2} rows (clientHeight=${scrollInfo.clientHeight}px)`,
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

    // ── Bottom of the list: the tail (lowest-balance) row must be mounted.
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
    const tailRow = page.getByTestId(`row-address-${TAIL_ADDR}`);
    const tailVisible = await tailRow
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'scrolling to the bottom reveals the lowest-balance tail address',
      passed: tailVisible,
      detail: tailVisible
        ? `row-address-${TAIL_ADDR} mounted after scrolling`
        : 'tail row never mounted at the bottom of the list',
    });
    if (!tailVisible) {
      const bottom = await sampleMountedRows(page);
      for (const step of steps) {
        console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
      }
      console.log(
        `[group-rows-virtual] bottom sample: ${bottom.count} rows, last=${JSON.stringify(bottom.addresses.slice(-3))}`,
      );
      throw new Error('tail row not reachable; aborting copy check');
    }

    // ── Per-row copy still targets the right row after deep scrolling. ─────
    await page.getByTestId(`button-copy-${TAIL_ADDR}`).click();
    let clipboardText = null;
    const clipDeadline = Date.now() + 5_000;
    while (Date.now() < clipDeadline) {
      try {
        clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      } catch {
        clipboardText = null;
      }
      if (clipboardText === TAIL_ADDR) break;
      await page.waitForTimeout(200);
    }
    steps.push({
      name: 'per-row copy button copies the correct address after deep scrolling',
      passed: clipboardText === TAIL_ADDR,
      detail:
        clipboardText === TAIL_ADDR
          ? `clipboard contains "${TAIL_ADDR}"`
          : `clipboard read gave ${JSON.stringify(clipboardText)}`,
    });

    // ── Per-row Resolve still targets the right record after deep scrolling.
    //    Both bottom rows carry a pending badge + Resolve button; clicking the
    //    tail's must resolve ONLY the tail's blank input. The restricted
    //    resolve is local-only (no network), so the proof is the database
    //    effect, not intercepted provider requests. ───────────────────────────
    const tailResolveBtn = page.getByTestId(`button-resolve-address-${TAIL_ADDR}`);
    const neighborBadge = page.getByTestId(`badge-address-unresolved-${NEIGHBOR_ADDR}`);
    const badgesReady =
      (await tailResolveBtn.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false)) &&
      (await neighborBadge.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false));
    steps.push({
      name: 'tail Resolve button and neighbor pending badge are both mounted at the bottom',
      passed: badgesReady,
      detail: badgesReady
        ? 'both bottom rows show their pending-spend UI'
        : 'pending badge / Resolve button never appeared on the bottom rows',
    });
    if (!badgesReady) throw new Error('pending-spend UI missing; aborting resolve check');

    // ── Capture pre-resolve UI state so the post-resolve assertions have a
    //    concrete baseline: the group card must show "2 pending" (one spend per
    //    bottom row) and we record the group balance text to prove it drops. ──
    const groupPendingBadge = page.getByTestId(`badge-unresolved-${WALLET_NAME}`);
    const groupBadgeBefore = ((await groupPendingBadge.textContent().catch(() => '')) ?? '').trim();
    const groupBalanceBefore = ((await page
      .getByTestId(`text-group-balance-${WALLET_NAME}`)
      .textContent()
      .catch(() => '')) ?? '').trim();
    steps.push({
      name: 'group card shows "2 pending" before the resolve',
      passed: groupBadgeBefore.includes('2 pending') && groupBalanceBefore.length > 0,
      detail: `group badge before: "${groupBadgeBefore}", group balance before: "${groupBalanceBefore}"`,
    });

    await tailResolveBtn.click();

    // Wait for the tail's blank input to be attributed, then read both spend
    // inputs back out of Dexie via the live module singletons.
    const resolveResult = await page.evaluate(
      async ({ spendTailTxid, spendNeighborTxid, tailAddr }) => {
        const { db } = await import('/src/lib/database.ts');
        const readInput = async (txid) => {
          const rows = await db.transactionParticipants.where('txid').equals(txid).toArray();
          const input = rows.find((p) => p.role === 'input');
          return input
            ? { address: input.address ?? '', recordId: input.recordId ?? null, amount: input.amount }
            : null;
        };
        const deadline = Date.now() + 30_000;
        let tailInput = null;
        while (Date.now() < deadline) {
          tailInput = await readInput(spendTailTxid);
          if (tailInput && tailInput.address === tailAddr) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        const neighborInput = await readInput(spendNeighborTxid);
        return { tailInput, neighborInput };
      },
      { spendTailTxid: seed.spendTailTxid, spendNeighborTxid: seed.spendNeighborTxid, tailAddr: TAIL_ADDR },
    );

    const tailResolved =
      resolveResult.tailInput &&
      resolveResult.tailInput.address === TAIL_ADDR &&
      resolveResult.tailInput.recordId === seed.tailId;
    steps.push({
      name: 'per-row Resolve attributed exactly the clicked row\'s pending spend',
      passed: !!tailResolved,
      detail: `tail spend input after resolve: ${JSON.stringify(resolveResult.tailInput)} (expected address=${TAIL_ADDR}, recordId=${seed.tailId})`,
    });
    const neighborUntouched =
      resolveResult.neighborInput &&
      resolveResult.neighborInput.address === '' &&
      resolveResult.neighborInput.recordId === null;
    steps.push({
      name: 'adjacent row\'s pending spend was NOT resolved (no off-by-one targeting)',
      passed: !!neighborUntouched,
      detail: `neighbor spend input after resolve: ${JSON.stringify(resolveResult.neighborInput)} (must remain blank/unattributed)`,
    });

    // ── Post-resolve UI refresh: the database is right (asserted above); the
    //    SCREEN must now catch up. resolvePrevouts recomputes the tail record's
    //    cached stats (its lone seeded output is now a resolved spend → balance
    //    0 / 0 UTXOs, so the tail row drops out of the group's cached rows) and
    //    notifies the records/transactionParticipants scopes, which re-runs the
    //    aggregation + unresolved-spend breakdown. A notification/recompute
    //    regression would leave stale badges or totals on screen. Assert:
    //      1. the group card's pending badge drops from "2 pending" to
    //         "1 pending";
    //      2. the tail row's badge-address-unresolved-* is GONE;
    //      3. the untouched neighbor row still shows its pending badge;
    //      4. the group balance text dropped (the tail's seeded sats left the
    //         aggregate after its stats recompute). ──────────────────────────
    const uiRefreshed = await page
      .waitForFunction(
        ({ tailAddr, walletName }) => {
          const groupBadge = document.querySelector(
            `[data-testid="badge-unresolved-${walletName}"]`,
          );
          const tailBadge = document.querySelector(
            `[data-testid="badge-address-unresolved-${tailAddr}"]`,
          );
          return (
            !tailBadge &&
            !!groupBadge &&
            /(^|[^\d,.])1 pending/.test(groupBadge.textContent || '')
          );
        },
        { tailAddr: TAIL_ADDR, walletName: WALLET_NAME },
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    const groupBadgeAfter = ((await groupPendingBadge.textContent().catch(() => '')) ?? '').trim();
    steps.push({
      name: 'group card pending count dropped from 2 to 1 and tail badge cleared',
      passed: uiRefreshed,
      detail: uiRefreshed
        ? `group badge after resolve: "${groupBadgeAfter}"`
        : `UI never refreshed: group badge="${groupBadgeAfter}", tail badge ${
            (await page.getByTestId(`badge-address-unresolved-${TAIL_ADDR}`).count()) > 0
              ? 'STILL PRESENT'
              : 'gone'
          }`,
    });

    // The aggregation re-run cleared + reloaded the expanded group's rows, so
    // the list remounted at scrollTop=0. Re-converge on the bottom, where the
    // neighbor (now the lowest-balance row) must still show its pending badge
    // while no tail badge exists anywhere in the DOM.
    const scrollBoxAfter = page.getByTestId('scroll-group-address-rows');
    await scrollBoxAfter.waitFor({ state: 'visible', timeout: 60_000 });
    await scrollBoxAfter.evaluate(async (el) => {
      for (let i = 0; i < 60; i++) {
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 150));
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          await new Promise((r) => setTimeout(r, 200));
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return;
        }
      }
    });
    const neighborBadgeAfter = await page
      .getByTestId(`badge-address-unresolved-${NEIGHBOR_ADDR}`)
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const tailBadgeCount = await page
      .getByTestId(`badge-address-unresolved-${TAIL_ADDR}`)
      .count();
    steps.push({
      name: "neighbor row's pending badge survives the refresh; tail badge stays gone",
      passed: neighborBadgeAfter && tailBadgeCount === 0,
      detail: `neighbor badge visible=${neighborBadgeAfter}, tail badge nodes in DOM=${tailBadgeCount}`,
    });

    // Group balance must reflect the recomputed cached stats: the tail's seeded
    // sats leave the total once its stats recompute to 0 balance / 0 UTXOs.
    const parseBalance = (text) => {
      const m = (text || '').replace(/,/g, '').match(/[\d.]+/);
      return m ? Number.parseFloat(m[0]) : NaN;
    };
    const balanceBefore = parseBalance(groupBalanceBefore);
    let groupBalanceAfter = '';
    let balanceAfter = NaN;
    const balDeadline = Date.now() + 30_000;
    while (Date.now() < balDeadline) {
      groupBalanceAfter = ((await page
        .getByTestId(`text-group-balance-${WALLET_NAME}`)
        .textContent()
        .catch(() => '')) ?? '').trim();
      balanceAfter = parseBalance(groupBalanceAfter);
      if (Number.isFinite(balanceAfter) && balanceAfter < balanceBefore) break;
      await page.waitForTimeout(500);
    }
    steps.push({
      name: 'group balance dropped on screen after the resolve recompute',
      passed:
        Number.isFinite(balanceBefore) &&
        Number.isFinite(balanceAfter) &&
        balanceAfter < balanceBefore,
      detail: `group balance before="${groupBalanceBefore}" (${balanceBefore}), after="${groupBalanceAfter}" (${balanceAfter})`,
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
  console.log(`[group-rows-virtual] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[group-rows-virtual] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log(
    '[group-rows-virtual] PASSED: with thousands of addresses in an expanded wallet group only a small row window mounts, scrolling stays responsive, per-row copy AND per-row Resolve target the correct address/record after deep scrolling, and the post-resolve UI refresh clears the resolved row\'s badge, keeps the neighbor\'s, drops the group pending count 2→1, and lowers the group balance on screen.',
  );
}

main().catch((err) => {
  console.error('[group-rows-virtual] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
