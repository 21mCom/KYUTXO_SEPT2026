#!/usr/bin/env node
// Real-browser verification that the Continuity Proof card's "All Custody
// Segments" list (client/src/components/ContinuityProof.tsx, rendered on the
// /provenance page — Provenance.tsx wires selectedAddress to its explorer
// address input) pages the custodySegments table and refreshes correctly.
//
// jsdom coverage exists (ContinuityProof.allSegments.test.tsx) but cannot
// catch real-browser-only issues: ScrollArea height/overflow with a growing
// card list, Radix Collapsible mount cost with a full 50-card first page, or
// stale rendering against live Dexie/IndexedDB.
//
// This check:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds 120 custody segments (>2 pages of 50) via the real CRUD helper,
//      with mixed custody statuses, two rows belonging to a distinct
//      "selected" address, five rows carrying a "zzfilter" address marker,
//      and three SPARSE rows (missing evidenceTxids with hopCount > 0, like
//      segments restored from older backups) placed on the LAST page.
//   3. Opens /provenance and asserts: first page shows "Showing 50 of 120",
//      exactly 50 cards mount, and the "No custody segments built yet" copy
//      never appears while the count is non-zero.
//   4. Clicks Load more twice: 50 → 100 → 120 cards; the button disappears
//      once the table is exhausted. Reaching the last page covers the
//      reported regression where Load more "did nothing" because a sparse
//      restored segment crashed the whole list render mid-append.
//   5. Types the selected address into the explorer input: the list switches
//      to that address's 2 segments (no paging indicator).
//   6. Clears the selection: the full paged list returns at page one.
//   7. Filters: soloing the Spent status chip narrows the paged query to the
//      30 spent segments (filtered total, no Load more); the debounced
//      address substring narrows to the 5 marked rows; clearing restores the
//      full paged list.
//
// NOTE for reviewers: the paging UI under test lives in
// client/src/components/ContinuityProof.tsx ("text-segments-showing",
// "button-load-more-segments"); /provenance is client/src/pages/Provenance.tsx.
//
// Usage: node scripts/check-continuity-proof-all-segments-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'all-segments-check-123';
const MAX_ATTEMPTS = 3;
const TOTAL_SEGMENTS = 120;
const SELECTED_ADDRESS = 'bc1qallsegmentsselectedaddr0000000000000';

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH.');
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

async function launchBrowser(exe) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      lastErr = e;
      console.log(`[all-segments] chromium launch failed (try ${i}): ${e.message.split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
  throw lastErr;
}

async function runSession(browser, step) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // Fresh vault via setup form (fresh context = fresh IndexedDB).
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 60_000 });

    // Seed 120 segments via the real CRUD helper against live IndexedDB.
    const seeded = await page.evaluate(
      async ({ total, selectedAddress }) => {
        const { bulkAddCustodySegments } = await import('/src/lib/data/lineage-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        const segments = [];
        for (let i = 0; i < total; i++) {
          const isSelected = i === 3 || i === 7; // two low-id rows off page one
          const segment = {
            segmentId: `browser-seg-${i.toString().padStart(4, '0')}`,
            originTxid: (i + 1).toString(16).padStart(64, '0'),
            originVout: 0,
            originAddress: isSelected
              ? selectedAddress
              : i >= 40 && i <= 44
                ? `bc1qzzfilterorigin${i.toString().padStart(6, '0')}`
                : `bc1qallsegorigin${i.toString().padStart(6, '0')}`,
            originDate: Date.now() - (total - i) * 3_600_000,
            originAmount: 100_000 + i,
            currentAmount: 100_000 + i,
            status: ['active', 'spent', 'split', 'consolidated'][i % 4],
            hopCount: 0,
            evidenceTxids: [],
            narrative: `Browser segment ${i}`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          // Sparse rows like segments restored from older backups: missing
          // evidenceTxids but hopCount > 0. Lowest ids → last page, so the
          // final Load more pulls them onto the screen (render-crash
          // regression: this used to tear down the whole list).
          if (i === 0 || i === 1 || i === 2) {
            segment.hopCount = 2;
            delete segment.evidenceTxids;
          }
          segments.push(segment);
        }
        await bulkAddCustodySegments(segments, { skipNotification: true });
        return db.custodySegments.count();
      },
      { total: TOTAL_SEGMENTS, selectedAddress: SELECTED_ADDRESS },
    );
    step('seeded 120 custody segments', seeded === TOTAL_SEGMENTS, `table count=${seeded}`);

    // Open the Provenance page (fresh load requires unlock again).
    await page.goto(`${BASE_URL}provenance`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 60_000 });

    const showing = page.getByTestId('text-segments-showing');
    await showing.waitFor({ state: 'visible', timeout: 60_000 });

    const cardCount = () => page.locator('text=/^Browser segment \\d+$/').count();

    const firstShowing = (await showing.innerText()).trim();
    const firstCards = await cardCount();
    step(
      'first page renders "Showing 50 of 120" with exactly one page of cards',
      firstShowing.includes(`Showing 50 of ${TOTAL_SEGMENTS}`) && firstCards === 50,
      `"${firstShowing}", cards=${firstCards}`,
    );

    // Newest-first ordering: the highest-index segment heads the list.
    const topVisible = await page
      .getByText(`Browser segment ${TOTAL_SEGMENTS - 1}`)
      .isVisible()
      .catch(() => false);
    step('newest segment appears on the first page', topVisible, '');

    const staleEmptyCopy = await page
      .getByText(/No custody segments built yet/)
      .count();
    step(
      'no "No custody segments built yet" copy while count is non-zero',
      staleEmptyCopy === 0,
      `matches=${staleEmptyCopy}`,
    );

    // Load more: 50 -> 100.
    await page.getByTestId('button-load-more-segments').click();
    await page.waitForFunction(
      (n) => {
        const el = document.querySelector('[data-testid="text-segments-showing"]');
        return el && el.textContent.includes(`Showing 100 of ${n}`);
      },
      TOTAL_SEGMENTS,
      { timeout: 30_000 },
    );
    const secondCards = await cardCount();
    step('Load more appends the second page (100 cards)', secondCards === 100, `cards=${secondCards}`);

    // Load more: 100 -> 120 (final short page, button disappears).
    await page.getByTestId('button-load-more-segments').click();
    await page.waitForFunction(
      (n) => {
        const el = document.querySelector('[data-testid="text-segments-showing"]');
        return el && el.textContent.includes(`Showing ${n} of ${n}`);
      },
      TOTAL_SEGMENTS,
      { timeout: 30_000 },
    );
    const thirdCards = await cardCount();
    const loadMoreGone = (await page.getByTestId('button-load-more-segments').count()) === 0;
    step(
      'final Load more exhausts the table and removes the button',
      thirdCards === TOTAL_SEGMENTS && loadMoreGone,
      `cards=${thirdCards}, loadMoreGone=${loadMoreGone}`,
    );

    // Selecting an address switches to that address's segments only.
    await page.getByTestId('input-explorer-address').fill(SELECTED_ADDRESS);
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="text-segments-showing"]'), undefined,
      { timeout: 30_000 },
    );
    // The two selected-address segments (indices 3 and 7) and nothing else.
    await page.getByText('Browser segment 3').waitFor({ state: 'visible', timeout: 30_000 });
    const selectedCards = await cardCount();
    const seg7Visible = await page.getByText('Browser segment 7').isVisible().catch(() => false);
    step(
      "selecting an address shows only that address's segments, unpaged",
      selectedCards === 2 && seg7Visible,
      `cards=${selectedCards}, seg7=${seg7Visible}`,
    );

    // Clearing the selection returns to the full paged list at page one.
    await page.getByTestId('button-clear-address').click();
    await page.waitForFunction(
      (n) => {
        const el = document.querySelector('[data-testid="text-segments-showing"]');
        return el && el.textContent.includes(`Showing 50 of ${n}`);
      },
      TOTAL_SEGMENTS,
      { timeout: 30_000 },
    );
    const clearedCards = await cardCount();
    const loadMoreBack = (await page.getByTestId('button-load-more-segments').count()) === 1;
    step(
      'clearing the selection restores the paged list at page one',
      clearedCards === 50 && loadMoreBack,
      `cards=${clearedCards}, loadMoreBack=${loadMoreBack}`,
    );

    // Filter: solo the Spent status chip — i % 4 === 1 → 30 spent segments.
    await page.getByTestId('filter-status-spent').click();
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="text-segments-showing"]');
        return el && el.textContent.includes('Showing 30 of 30 segments (filtered)');
      },
      undefined,
      { timeout: 30_000 },
    );
    const spentCards = await cardCount();
    const loadMoreFilteredOut = (await page.getByTestId('button-load-more-segments').count()) === 0;
    step(
      'status filter narrows the paged query to the 30 spent segments',
      spentCards === 30 && loadMoreFilteredOut,
      `cards=${spentCards}, loadMoreGone=${loadMoreFilteredOut}`,
    );

    // Clearing the status filter restores the unfiltered paged list.
    await page.getByTestId('button-clear-segment-filters').click();
    await page.waitForFunction(
      (n) => {
        const el = document.querySelector('[data-testid="text-segments-showing"]');
        return el && el.textContent.includes(`Showing 50 of ${n} segments`) && !el.textContent.includes('(filtered)');
      },
      TOTAL_SEGMENTS,
      { timeout: 30_000 },
    );
    step(
      'clearing the status filter restores the unfiltered list',
      (await cardCount()) === 50,
      '',
    );

    // Filter: debounced address substring — 5 rows carry the "zzfilter" marker.
    await page.getByTestId('input-filter-address').fill('zzfilter');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="text-segments-showing"]');
        return el && el.textContent.includes('Showing 5 of 5 segments (filtered)');
      },
      undefined,
      { timeout: 30_000 },
    );
    const addrCards = await cardCount();
    step(
      'address substring filter narrows to the 5 marked segments',
      addrCards === 5,
      `cards=${addrCards}`,
    );

    // Clearing the address filter (debounced) returns the full paged list.
    await page.getByTestId('input-filter-address').fill('');
    await page.waitForFunction(
      (n) => {
        const el = document.querySelector('[data-testid="text-segments-showing"]');
        return el && el.textContent.includes(`Showing 50 of ${n} segments`) && !el.textContent.includes('(filtered)');
      },
      TOTAL_SEGMENTS,
      { timeout: 30_000 },
    );
    const clearedFilterCards = await cardCount();
    step(
      'clearing the address filter restores the paged list',
      clearedFilterCards === 50,
      `cards=${clearedFilterCards}`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const exe = resolveChromium();
  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error('Dev server did not become ready.');
    }
  }

  let steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    // Retry the whole session on environment flake (chromium crash, load
    // timeout under parallel validation); each attempt uses a fresh context.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      steps = [];
      const browser = await launchBrowser(exe);
      try {
        await runSession(browser, step);
        break;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.log(`[all-segments] attempt ${attempt} crashed: ${msg.split('\n')[0]}`);
        if (attempt === MAX_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, 15_000 * attempt));
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } finally {
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[all-segments] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length || steps.length === 0) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; ') || '(no steps ran)');
    process.exit(1);
  }
  console.log('[all-segments] OK');
}

main().catch((err) => {
  console.error('[all-segments] FATAL:', err);
  process.exit(1);
});
