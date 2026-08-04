#!/usr/bin/env node
// Real-browser end-to-end guard for the Dashboard's "Show hidden matches"
// reveal on vaults larger than the 5,000-record load window.
//
// NOTE for reviewers: the route exercised here is "/" — the records Dashboard
// (client/src/pages/Dashboard.tsx, see App.tsx `<Route path="/">`), NOT the
// /records page (Records.tsx), which queries the DB vault-wide and never had
// this defect.
//
// jsdom + fake-indexeddb tests already pin the bounded vault-wide fetch, the
// shared count/reveal predicate, and the "showing first N" cap note — but the
// original bug (window-only reveal dead-ending on "No records found") is a
// real-IndexedDB, real-scale failure class. This script drives the real page
// in headless Chromium:
//   1. creates a fresh vault
//   2. seeds 5,100 visible filler rows (all recently updated) plus ONE
//      blockchain-discovered (hidden-tier) row whose updatedAt is older than
//      every filler — so it can never be inside the 5,000-row window
//   3. searches a token that only matches the hidden row, asserts the "1
//      match is hidden" notice, and clicks "Show hidden matches"
//   4. asserts the hidden row actually renders (table view AND grid view) —
//      the pre-fix behavior was a blank "No records found" page
//   5. searches an unrelated term, then re-searches the original token and
//      asserts the match renders again without an app restart
//
// Everything runs offline against local IndexedDB — no network requests.
// Usage: node scripts/check-dashboard-hidden-matches-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dash-hidden-check-123';

// Unique identifiers — first 8 chars differ (testid slicing rule).
const ADDR_HIDDEN = 'bc1qdhhidden0000000000001checkaddr';
// Search token that appears ONLY in the hidden row's label + walletName.
const HIDDEN_TOKEN = 'dhhiddenmatchtoken';
const NO_MATCH_TOKEN = 'zzz-dh-no-such-match';
const FILLER_COUNT = 5_100;

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

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[dash-hidden-browser] legacy-migration overlay detected; waiting it out ...');
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

async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 30_000 })
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

async function main() {
  const exe = resolveChromium();
  console.log(`[dash-hidden-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dash-hidden-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dash-hidden-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[dash-hidden-browser] dev server ready at ${BASE_URL}`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel load.
  let browser = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(
        `[dash-hidden-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[dash-hidden-browser][page-console] ${msg.text()}`);
      }
    });

    // ── 1. Create the vault ─────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── 2. Seed: 5,100 recently-updated visible fillers + ONE hidden-tier
    //        row whose updatedAt is older than every filler — outside the
    //        5,000-row load window no matter which tiers are included. ──────
    const seed = await page.evaluate(
      async ({ addrHidden, hiddenToken, fillerCount }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        const base = 2_000_000;
        const fillers = [];
        for (let i = 0; i < fillerCount; i++) {
          const inputString = `bc1qdhfiller${String(i).padStart(6, '0')}fillerrowaddr`;
          fillers.push({
            type: 'address',
            inputString,
            inputStringLower: inputString.toLowerCase(),
            label: `Filler ${i}`,
            tags: [],
            categories: [],
            source: 'manual',
            addressImportance: 'manual',
            createdAt: base + i,
            updatedAt: base + i,
          });
        }
        // Bulk add for speed; direct table writes stand in for a big synced
        // vault's filler rows (they carry valid tiers + synced search keys).
        await db.records.bulkAdd(fillers);

        const idHidden = await recordCrud.createRecord({
          type: 'address',
          inputString: addrHidden,
          label: `Old discovered counterparty ${hiddenToken}`,
          walletName: hiddenToken,
          tags: [],
          categories: [],
          source: 'blockchain-sync',
          addressImportance: 'blockchain-discovered',
          createdAt: 1_000_000,
          updatedAt: 1_000_000,
        });

        const rHidden = await db.records.get(idHidden);
        const total = await db.records.count();
        return { idHidden, hiddenTier: rHidden?.addressImportance, total };
      },
      { addrHidden: ADDR_HIDDEN, hiddenToken: HIDDEN_TOKEN, fillerCount: FILLER_COUNT },
    );
    steps.push({
      name: 'seed: 5,100 visible fillers + one hidden-tier row older than all fillers (outside the load window)',
      passed: seed.hiddenTier === 'blockchain-discovered' && seed.total === FILLER_COUNT + 1,
      detail: JSON.stringify(seed),
    });

    // ── 3. Dashboard: search → notice → reveal ─────────────────────────────
    // Reload so the freshly-seeded rows are picked up deterministically, then
    // unlock again (reload locks the vault).
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const searchInput = page.getByTestId('input-search');
    await searchInput.waitFor({ state: 'visible', timeout: 60_000 });

    const hiddenRow = page.getByTestId(`row-record-${seed.idHidden}`);
    const hiddenBeforeSearch = await hiddenRow.count();
    steps.push({
      name: 'hidden row is not listed in the default view',
      passed: hiddenBeforeSearch === 0,
      detail: `row-record-${seed.idHidden} count=${hiddenBeforeSearch}`,
    });

    await searchInput.fill(HIDDEN_TOKEN);

    const notice = page.getByTestId('notice-hidden-matches');
    const noticeVisible = await notice
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    const noticeText = noticeVisible ? ((await notice.textContent()) ?? '').trim() : '';
    steps.push({
      name: 'search matching only an out-of-window hidden row shows the "match is hidden" notice',
      passed: noticeVisible && /1\s*match is\s*hidden/i.test(noticeText.replace(/\s+/g, ' ')),
      detail: noticeVisible ? `notice text: ${JSON.stringify(noticeText)}` : 'notice never appeared',
    });

    const hiddenBeforeReveal = await hiddenRow.count();
    steps.push({
      name: 'hidden row is still not listed before clicking the button',
      passed: hiddenBeforeReveal === 0,
      detail: `row-record-${seed.idHidden} count=${hiddenBeforeReveal}`,
    });

    if (noticeVisible) {
      await page.getByTestId('button-show-hidden-matches').click();
      // The pre-fix behavior: the click reloaded the same 5,000-row window
      // (now including discovered tiers), which does not contain the match —
      // a blank "No records found" page. The reveal must fetch the row
      // vault-wide and render it.
      const shown = await hiddenRow
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      const rowCount = await hiddenRow.count();
      steps.push({
        name: '"Show hidden matches" reveals the out-of-window hidden row (table view)',
        passed: shown && rowCount === 1,
        detail: `row-record-${seed.idHidden} visible=${shown} count=${rowCount} (count>1 would mean the union duplicated a window row)`,
      });
    } else {
      steps.push({
        name: '"Show hidden matches" reveals the out-of-window hidden row (table view)',
        passed: false,
        detail: 'skipped — notice never appeared',
      });
    }

    // ── 4. The revealed row renders in grid view too ────────────────────────
    await page.getByTestId('button-view-grid').click();
    const hiddenCard = page.getByTestId(`card-record-${seed.idHidden}`);
    const cardShown = await hiddenCard
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'revealed hidden row renders in grid view',
      passed: cardShown,
      detail: `card-record-${seed.idHidden} visible=${cardShown}`,
    });
    await page.getByTestId('button-view-table').click();
    await hiddenRow.waitFor({ state: 'visible', timeout: 30_000 });

    // ── 5. Re-searching the revealed term re-reveals it (no app restart) ────
    await searchInput.fill(NO_MATCH_TOKEN);
    const rowGone = await hiddenRow
      .waitFor({ state: 'detached', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'searching an unrelated term clears the revealed row',
      passed: rowGone,
      detail: `row-record-${seed.idHidden} detached=${rowGone}`,
    });

    await searchInput.fill(HIDDEN_TOKEN);
    const reshown = await hiddenRow
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 're-searching the previously-revealed term shows the match again (no blank dead end, no restart)',
      passed: reshown,
      detail: `row-record-${seed.idHidden} visible=${reshown}`,
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

  console.log(`[dash-hidden-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dash-hidden-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dash-hidden-browser] PASSED: the Dashboard "Show hidden matches" reveal fetches out-of-window hidden matches vault-wide and re-reveals them on re-search, in a real browser.',
  );
}

main().catch((err) => {
  console.error('[dash-hidden-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
