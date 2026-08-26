#!/usr/bin/env node
// Real-browser UI guard for the Database Doctor stale-list header
// "select all" checkbox (task: "Confirm the stale-list 'select all' checkbox
// never silently ticks rows the user hasn't seen").
//
// The stale-balance list in the BalanceIntegrityCard is virtualized and its
// rows stream in windows of 100 (STALE_WINDOW_SIZE) from a scratch store. The
// header checkbox (data-testid="checkbox-stale-select-all") intentionally
// selects ONLY the rows whose windows have been loaded into the row cache —
// never the unloaded remainder. If a regression made it grab every stale
// record id, "Recompute selected" would quietly become a full-vault recompute,
// defeating the point of selection on huge vaults.
//
// This script, in a real Chromium:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds 150 address records, each with an addressSyncState row and a
//      deliberately WRONG cached balance (123 sats, no transactions => the
//      recomputed truth is 0) so the Doctor's balance check flags all 150
//   3. on /database-doctor, clicks "Run balance check" and waits for the
//      verdict to report 150 of 150 stale
//   4. WITHOUT scrolling the stale list, waits for the first window of rows
//      to load, then clicks the header select-all checkbox
//   5. asserts the "Recompute selected (N)" button reports exactly 100 (the
//      one loaded window) — NOT the full 150 stale rows
//   6. as a control, scrolls the list to the bottom (loading the second
//      window) and clicks select-all again: the count must now grow beyond
//      100 (proving selection follows loaded windows, not a hardcoded cap)
//
// NOTE for reviewers: the control under test is the header Checkbox
// data-testid="checkbox-stale-select-all" inside StaleAddressList in
// client/src/pages/DatabaseDoctor.tsx (route /database-doctor); its
// onCheckedChange passes `loadedIds` (rows present in rowCacheRef) to
// onSetManySelected, and the count surfaces in
// data-testid="button-recompute-selected" as "Recompute selected (N)".
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-database-doctor-select-all-loaded-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dbdoctor-select-all-loaded-check-123';

const STALE_TOTAL = 150; // more than one 100-row window
const WINDOW_SIZE = 100; // must match STALE_WINDOW_SIZE in DatabaseDoctor.tsx
const WRONG_CACHED_SATS = 123;

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

async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(
        `[dbdoctor-select-all-loaded] goto ${url} failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
}

function parseSelectedCount(label) {
  const m = /Recompute selected \(([\d,]+)\)/.exec(label);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dbdoctor-select-all-loaded] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dbdoctor-select-all-loaded] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dbdoctor-select-all-loaded] starting dev server (npm run dev) ...`);
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
    console.log(`[dbdoctor-select-all-loaded] dev server ready at ${BASE_URL}`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel
  // validation load.
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
        `[dbdoctor-select-all-loaded] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
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
        console.log(`[dbdoctor-select-all-loaded][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await gotoWithRetry(page, BASE_URL);
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'dbdoctor-select-all-loaded',
    });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed 150 stale synced addresses ─────────────────────────────────────
    const seed = await page.evaluate(
      async ({ total, wrongCachedSats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const syncCrud = await import('/src/lib/data/address-sync-crud.ts');

        const pad = (i) => String(i).padStart(5, '0');
        // Valid-looking, unique bech32-ish strings (lowercase, no '1'/'b'/'i'/'o'
        // ambiguity concerns needed — the app stores them as given).
        const addrs = Array.from(
          { length: total },
          (_, i) => `bc1qddselallloaded${pad(i)}xxxxxxxxxxcheck`,
        );

        const ids = await recordCrud.bulkCreateRecords(
          addrs.map((a, i) => ({
            type: 'address',
            inputString: a,
            label: `DD select-all loaded ${i}`,
          })),
          { skipVocabularySync: true, skipNotification: true },
        );

        // Mark every address as synced (no transactions exist, so the
        // recomputed truth is 0 sats), then stamp a wrong cached balance so
        // the Doctor's balance check flags all of them as stale.
        await syncCrud.bulkAddAddressSyncState(
          addrs.map((a, i) => ({
            address: a,
            recordId: ids[i],
            lastSyncedHeight: 800_100,
            lastSyncedAt: Date.now(),
            txCount: 0,
          })),
        );

        const now = Math.floor(Date.now() / 1000);
        await recordCrud.bulkUpdateAddressStats(
          ids.map((id) => ({
            id,
            stats: {
              cachedBalanceSats: wrongCachedSats,
              cachedTxCount: 0,
              cachedLastActivityTime: now - 3_600,
              cachedUtxoCount: 0,
              statsComputedAt: Date.now(),
            },
          })),
          { skipNotification: true },
        );

        return { created: ids.length };
      },
      { total: STALE_TOTAL, wrongCachedSats: WRONG_CACHED_SATS },
    );
    steps.push({
      name: `seeded ${STALE_TOTAL} stale synced addresses`,
      passed: seed.created === STALE_TOTAL,
      detail: JSON.stringify(seed),
    });

    // ── Database Doctor: run the balance check ──────────────────────────────
    await gotoWithRetry(page, `${BASE_URL}database-doctor`);
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'dbdoctor-select-all-loaded',
    });

    await page.getByTestId('button-run-balance-check').click();
    const verdict = page.getByTestId('text-balance-verdict');
    await verdict.waitFor({ state: 'visible', timeout: 120_000 });
    // Wait for the verdict to settle on the full stale count (rows stream in).
    let verdictText = '';
    {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        verdictText = ((await verdict.textContent().catch(() => '')) ?? '').trim();
        if (new RegExp(`^${STALE_TOTAL} of ${STALE_TOTAL} `).test(verdictText)) break;
        await page.waitForTimeout(500);
      }
    }
    steps.push({
      name: `balance check flagged all ${STALE_TOTAL} seeded addresses as stale`,
      passed:
        new RegExp(`^${STALE_TOTAL} of ${STALE_TOTAL} `).test(verdictText) &&
        verdictText.includes('stale cached balance'),
      detail: `verdict="${verdictText}"`,
    });

    // ── Wait for the FIRST window of rows to load, WITHOUT scrolling ────────
    // Per-row checkboxes only render once the window has streamed into the
    // row cache; wait for one so select-all sees a non-empty loadedIds.
    const anyRowCheckbox = page
      .locator('[data-testid^="checkbox-stale-"]:not([data-testid="checkbox-stale-select-all"])')
      .first();
    await anyRowCheckbox.waitFor({ state: 'visible', timeout: 60_000 });
    // Give the window fetch a beat to finish populating the full 100-row cache
    // (rows render as soon as the cache version bumps, which happens once per
    // window load, so a visible row means the whole window is cached).
    const scrollTopBefore = await page
      .getByTestId('scroll-stale-addresses')
      .evaluate((el) => el.scrollTop);
    steps.push({
      name: 'first row window loaded without any scrolling',
      passed: scrollTopBefore === 0,
      detail: `scrollTop=${scrollTopBefore}`,
    });

    // ── Click select-all: must select ONLY the loaded window (100 rows) ─────
    await page.getByTestId('checkbox-stale-select-all').click();
    const recomputeSelectedBtn = page.getByTestId('button-recompute-selected');
    await recomputeSelectedBtn.waitFor({ state: 'visible', timeout: 30_000 });
    const label1 = ((await recomputeSelectedBtn.textContent()) ?? '').trim();
    const count1 = parseSelectedCount(label1);
    steps.push({
      name: `select-all without scrolling selects exactly the ${WINDOW_SIZE} loaded rows, not all ${STALE_TOTAL}`,
      passed: count1 === WINDOW_SIZE,
      detail: `label="${label1}" parsed=${count1} (full stale count=${STALE_TOTAL})`,
    });
    steps.push({
      name: 'select-all did NOT silently tick unloaded rows',
      passed: count1 !== null && count1 < STALE_TOTAL,
      detail: `selected=${count1} < staleTotal=${STALE_TOTAL}`,
    });

    // ── Control: scroll to the bottom, loading the second window ────────────
    await page
      .getByTestId('scroll-stale-addresses')
      .evaluate((el) => { el.scrollTop = el.scrollHeight; });
    // Wait until a row beyond the first window has rendered (its checkbox is
    // only mounted once window 2 streams into the cache).
    {
      const deadline = Date.now() + 60_000;
      let extraLoaded = false;
      while (Date.now() < deadline) {
        const loadingRows = await page
          .locator('[data-testid^="row-stale-loading-"]')
          .count();
        const rowCheckboxes = await page
          .locator('[data-testid^="checkbox-stale-"]:not([data-testid="checkbox-stale-select-all"])')
          .count();
        if (loadingRows === 0 && rowCheckboxes > 0) {
          extraLoaded = true;
          break;
        }
        await page.waitForTimeout(300);
      }
      steps.push({
        name: 'second window loaded after scrolling to the bottom',
        passed: extraLoaded,
        detail: 'no loading placeholders remain in view',
      });
    }
    await page.getByTestId('checkbox-stale-select-all').click();
    // Header may now be indeterminate → first click selects all loaded rows.
    // Poll the button label until it grows past the first window.
    let label2 = '';
    let count2 = null;
    {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        label2 = ((await recomputeSelectedBtn.textContent().catch(() => '')) ?? '').trim();
        count2 = parseSelectedCount(label2);
        if (count2 !== null && count2 > WINDOW_SIZE) break;
        await page.waitForTimeout(300);
      }
    }
    steps.push({
      name: 'after scrolling, select-all grows to cover the newly loaded window (proves selection tracks loaded windows)',
      passed:
        count2 !== null && count2 > WINDOW_SIZE && count2 === STALE_TOTAL,
      detail: `label="${label2}" parsed=${count2} (expected ${STALE_TOTAL} once both windows are loaded)`,
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

  console.log(`[dbdoctor-select-all-loaded] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dbdoctor-select-all-loaded] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dbdoctor-select-all-loaded] PASSED: the stale-list header select-all ticked only the loaded window (100 of 150), and only grew after the user scrolled more rows into view.',
  );
}

main().catch((err) => {
  console.error('[dbdoctor-select-all-loaded] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
