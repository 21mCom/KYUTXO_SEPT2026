#!/usr/bin/env node
// Real-browser verification that the "All Custody Segments" paged list in
// client/src/components/ContinuityProof.tsx (rendered on /provenance) refreshes
// after a REAL Build Lineage run — both when the run completes and when it is
// cancelled mid-build. jsdom coverage mocks the build functions, so a stale
// paged list after a live build/cancel would only surface in a real browser.
//
// Session 1 (completion refresh):
//   1. Fresh vault; seeds 55 pre-existing custody segments (so the list pages:
//      "Showing 50 of 55") plus REAL lineage inputs — curated owned records,
//      blockchainTransactions and participants forming the custody-build
//      recipe (external→A→B→external spent chain + still-held origin C).
//      utxoLineage is NOT pre-seeded: the real buildAllLineage phase creates it.
//   2. Opens /provenance, pages to "Showing 55 of 55" (proves paging state is
//      non-trivial before the build), then clicks the real Build Lineage button.
//   3. After the run finishes, asserts the list refreshed to page one with the
//      3 newly built segments included ("Showing 50 of 58"), the new segments
//      lead the list (newest-first), and the UI count matches the table count.
//
// Session 2 (cancellation consistency):
//   1. Fresh vault; seeds 10 pre-existing segments plus 220 independent
//      still-held origins (one owned address, 220 funding txs+participants).
//   2. Clicks Build Lineage under CDP CPU throttling, waits for the custody
//      phase (Step 2), then cancels mid-run via dispatchEvent (no
//      actionability retries that could straddle completion).
//   3. Asserts the refreshed list is consistent with the segments actually
//      created: UI "Showing X of Y" matches the live table count exactly, no
//      duplicate segmentIds/origin outpoints exist, the 10 pre-seeded rows
//      survive, and the build genuinely stopped early (count < full 230).
//      If a warm run outraces the cancel, the attempt retries with an
//      escalating throttle rate.
//
// Session 3 (step-1 / lineage-phase cancellation):
//   1. Fresh vault; same seed shape as session 2 (10 pre-existing segments,
//      220 independent origins). utxoLineage is NOT pre-seeded.
//   2. Clicks Build Lineage under CDP CPU throttling and cancels while the
//      progress UI still shows Step 1 of 2 ("Building UTXO lineage") — the
//      EARLIER return path in handleBuildLineage, before any custody work.
//   3. Asserts NO custody segments were created (table still holds exactly the
//      10 pre-seeded rows), the paged list is unchanged ("Showing 10 of 10",
//      no stale empty-state), and utxoLineage stopped partially built
//      (0 < rows < 220). Then re-runs a full un-throttled Build Lineage and
//      asserts the partial lineage rows caused no duplicates: exactly 220
//      lineage rows with unique (createdTxid, createdVout), 230 segments with
//      unique segmentIds/origin outpoints, and the list refreshed to
//      "Showing 50 of 230". If the cancel lands after step 1 already finished
//      (warm run), the attempt retries with a higher throttle rate.
//
// NOTE for reviewers: the refresh-after-build path under test is the finally
// block of handleBuildLineage in client/src/components/ContinuityProof.tsx
// (loadStats + loadAllSegmentsPage(true)); /provenance is
// client/src/pages/Provenance.tsx.
//
// Usage: node scripts/check-lineage-build-segments-refresh-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'build-refresh-check-123';
const MAX_ATTEMPTS = 3;
const PRESEED_COMPLETE = 55; // pages: 50 shown of 55
const PRESEED_CANCEL = 10;
const CANCEL_ORIGINS = 220;
const THROTTLE_RATES = [8, 14, 20]; // escalate if a warm run outraces the cancel

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
      console.log(`[build-refresh] chromium launch failed (try ${i}): ${e.message.split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
  throw lastErr;
}

async function openFreshVault(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));
  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 60_000 });
  return page;
}

async function gotoProvenance(page) {
  await page.goto(`${BASE_URL}provenance`, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 60_000 });
}

function preSegment(prefix, i) {
  return {
    segmentId: `${prefix}-seg-${i.toString().padStart(4, '0')}`,
    originTxid: `${prefix.length}${i.toString(16)}`.padStart(64, 'f'),
    originVout: 0,
    originAddress: `bc1q${prefix}origin${i.toString().padStart(6, '0')}`,
    originDate: Date.now() - (1000 - i) * 3_600_000,
    originAmount: 100_000 + i,
    currentAmount: 100_000 + i,
    status: 'active',
    hopCount: 0,
    evidenceTxids: [],
    narrative: `${prefix} segment ${i}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function waitForShowing(page, shown, total, timeout = 60_000) {
  await page.waitForFunction(
    ({ shown, total }) => {
      const el = document.querySelector('[data-testid="text-segments-showing"]');
      return !!el && el.textContent.includes(`Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`);
    },
    { shown, total },
    { timeout },
  );
}

// --- Session 1: list refreshes after a completed real build --------------
async function runCompletionSession(browser, step) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await openFreshVault(context);

    const seeded = await page.evaluate(
      async ({ preseed, preSegmentSrc }) => {
        const { createRecord } = await import('/src/lib/data/record-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants } = await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddCustodySegments } = await import('/src/lib/data/lineage-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        // Pre-existing paged segments (distinct origins from the build inputs).
        const preSegment = new Function(`return (${preSegmentSrc})`)();
        const pre = [];
        for (let i = 0; i < preseed; i++) pre.push(preSegment('refresh', i));
        await bulkAddCustodySegments(pre, { skipNotification: true });

        // Real lineage inputs (custody-build recipe): utxoLineage is built by
        // the real buildAllLineage phase, not seeded here.
        const A = 'bc1qrefreshoriginaaaaaaaaaaaaaaaaaaaaaaa';
        const B = 'bc1qrefreshhopbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const C = 'bc1qrefreshheldcccccccccccccccccccccccc';
        const EXT = 'bc1qexternalpartyxxxxxxxxxxxxxxxxxxxxxxx';
        const tx1 = 'a7'.repeat(32);
        const tx2 = 'b8'.repeat(32);
        const tx3 = 'c9'.repeat(32);
        const tx4 = 'd0'.repeat(32);
        const t1 = 1700000000, t2 = 1700003600, t3 = 1700007200, t4 = 1700010800;

        for (const [addr, label] of [[A, 'Origin A'], [B, 'Hop B'], [C, 'Held C']]) {
          await createRecord(
            { type: 'address', inputString: addr, label, addressImportance: 'manual' },
            { skipVocabularySync: true, skipNotification: true },
          );
        }

        const txBase = { fee: 200, feeRate: 2, syncedAt: Date.now() };
        await bulkAddTransactions(
          [
            { txid: tx1, blockHeight: 800000, blockTime: t1, ...txBase },
            { txid: tx2, blockHeight: 800010, blockTime: t2, ...txBase },
            { txid: tx3, blockHeight: 800020, blockTime: t3, ...txBase },
            { txid: tx4, blockHeight: 800030, blockTime: t4, ...txBase },
          ],
          { skipNotification: true },
        );
        await bulkAddParticipants(
          [
            { txid: tx1, role: 'input', address: EXT, amount: 101000 },
            { txid: tx1, role: 'output', address: A, amount: 100000, vout: 0 },
            { txid: tx2, role: 'input', address: A, amount: 100000 },
            { txid: tx2, role: 'output', address: B, amount: 90000, vout: 0 },
            { txid: tx3, role: 'input', address: B, amount: 90000 },
            { txid: tx3, role: 'output', address: EXT, amount: 80000, vout: 0 },
            { txid: tx4, role: 'input', address: EXT, amount: 51000 },
            { txid: tx4, role: 'output', address: C, amount: 50000, vout: 0 },
          ],
          { skipNotification: true },
        );

        return {
          segments: await db.custodySegments.count(),
          lineage: await db.utxoLineage.count(),
        };
      },
      { preseed: PRESEED_COMPLETE, preSegmentSrc: preSegment.toString() },
    );
    step(
      'completion: seeded pre-existing segments + real lineage inputs (no utxoLineage yet)',
      seeded.segments === PRESEED_COMPLETE && seeded.lineage === 0,
      `segments=${seeded.segments}, lineage=${seeded.lineage}`,
    );

    await gotoProvenance(page);
    await waitForShowing(page, 50, PRESEED_COMPLETE);
    step('completion: pre-build list pages at "Showing 50 of 55"', true, '');

    // Advance paging so the refresh has non-trivial state to reset.
    await page.getByTestId('button-load-more-segments').click();
    await waitForShowing(page, PRESEED_COMPLETE, PRESEED_COMPLETE);
    step('completion: Load more exhausts the pre-build table (55 of 55)', true, '');

    // Real Build Lineage run.
    await page.getByTestId('button-build-lineage').click();
    await page
      .getByTestId('lineage-build-progress')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => {}); // tiny builds may finish before the progress UI paints
    await page.getByTestId('lineage-build-progress').waitFor({ state: 'hidden', timeout: 120_000 });

    // 3 new segments (origins tx1:0, tx2:0, tx4:0) -> 58 total, page one.
    const expectedTotal = PRESEED_COMPLETE + 3;
    await waitForShowing(page, 50, expectedTotal, 60_000);
    const dbState = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      const rows = await db.custodySegments.toArray();
      return {
        count: rows.length,
        uniqueIds: new Set(rows.map((s) => s.segmentId)).size,
      };
    });
    step(
      'completion: list refreshed to page one including the newly built segments',
      dbState.count === expectedTotal && dbState.uniqueIds === expectedTotal,
      `table=${dbState.count}, unique=${dbState.uniqueIds}, UI shows 50 of ${expectedTotal}`,
    );

    // Newest-first: the freshly built segments (highest ids) lead the list.
    const newSegmentVisible = await page
      .getByText(/still held|Fully spent/)
      .first()
      .isVisible()
      .catch(() => false);
    const loadMoreBack = (await page.getByTestId('button-load-more-segments').count()) === 1;
    step(
      'completion: built segments appear on page one and paging is reset',
      newSegmentVisible && loadMoreBack,
      `newSegmentVisible=${newSegmentVisible}, loadMoreBack=${loadMoreBack}`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

// --- Session 2: cancellation mid-build leaves a consistent list ----------
async function runCancelSession(browser, step, throttleRate) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await openFreshVault(context);

    const seeded = await page.evaluate(
      async ({ preseed, origins, preSegmentSrc }) => {
        const { createRecord } = await import('/src/lib/data/record-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants } = await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddCustodySegments } = await import('/src/lib/data/lineage-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        const preSegment = new Function(`return (${preSegmentSrc})`)();
        const pre = [];
        for (let i = 0; i < preseed; i++) pre.push(preSegment('cancelpre', i));
        await bulkAddCustodySegments(pre, { skipNotification: true });

        // One owned address funded by many independent txs: each output is a
        // distinct still-held origin, so the custody phase has many
        // per-origin abort checkpoints to cancel between.
        const C = 'bc1qcancelheldcccccccccccccccccccccccccc';
        const EXT = 'bc1qexternalpartyxxxxxxxxxxxxxxxxxxxxxxx';
        await createRecord(
          { type: 'address', inputString: C, label: 'Cancel held', addressImportance: 'manual' },
          { skipVocabularySync: true, skipNotification: true },
        );

        const txs = [];
        const parts = [];
        for (let i = 0; i < origins; i++) {
          const txid = (i + 0x1000).toString(16).padStart(8, '0').repeat(8);
          txs.push({
            txid,
            blockHeight: 800000 + i,
            blockTime: 1700000000 + i * 600,
            fee: 200,
            feeRate: 2,
            syncedAt: Date.now(),
          });
          parts.push(
            { txid, role: 'input', address: EXT, amount: 51000 },
            { txid, role: 'output', address: C, amount: 50000, vout: 0 },
          );
        }
        await bulkAddTransactions(txs, { skipNotification: true });
        await bulkAddParticipants(parts, { skipNotification: true });

        return { segments: await db.custodySegments.count(), txs: txs.length };
      },
      { preseed: PRESEED_CANCEL, origins: CANCEL_ORIGINS, preSegmentSrc: preSegment.toString() },
    );
    step(
      'cancel: seeded pre-existing segments + many independent origins',
      seeded.segments === PRESEED_CANCEL && seeded.txs === CANCEL_ORIGINS,
      `segments=${seeded.segments}, txs=${seeded.txs}`,
    );

    await gotoProvenance(page);
    await waitForShowing(page, PRESEED_CANCEL, PRESEED_CANCEL);

    // Throttle the CPU so the custody phase is slow enough to cancel into.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttleRate });

    try {
      await page.getByTestId('button-build-lineage').click();

      // Wait for the custody phase (Step 2) to have processed a few origins —
      // so the cancel genuinely lands MID-build with partial segments created —
      // then cancel via dispatchEvent so actionability retries can't straddle
      // completion.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="lineage-build-progress"]');
          if (!el || !/Step 2 of 2/.test(el.textContent || '')) return false;
          const counter = document.querySelector('[data-testid="text-build-counter"]');
          const m = counter && (counter.textContent || '').match(/^([\d,]+) of/);
          return !!m && parseInt(m[1].replace(/,/g, ''), 10) >= 3;
        },
        undefined,
        { timeout: 300_000 },
      );
      await page.getByTestId('button-cancel-build').dispatchEvent('click');
      // Below the confirm threshold this aborts directly; handle the confirm
      // dialog anyway in case settings/progress push it over.
      await page
        .getByTestId('button-cancel-build-confirm')
        .dispatchEvent('click', undefined, { timeout: 2_000 })
        .catch(() => {});

      await page.getByTestId('lineage-build-progress').waitFor({ state: 'hidden', timeout: 300_000 });
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    }

    const post = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      const rows = await db.custodySegments.toArray();
      const ids = rows.map((s) => s.segmentId);
      const outpoints = rows.map((s) => `${s.originTxid}:${s.originVout}`);
      return {
        count: rows.length,
        uniqueIds: new Set(ids).size,
        uniqueOutpoints: new Set(outpoints).size,
        preseedIntact: ids.filter((id) => id.startsWith('cancelpre-seg-')).length,
      };
    });

    const fullTotal = PRESEED_CANCEL + CANCEL_ORIGINS;
    if (post.count >= fullTotal) {
      throw new Error(
        `cancel raced completion at throttle ${throttleRate}x (table=${post.count}); retrying with a higher rate`,
      );
    }
    step(
      'cancel: build stopped mid-run with partial segments created, no duplicate or lost rows',
      post.count > PRESEED_CANCEL &&
        post.count < fullTotal &&
        post.uniqueIds === post.count &&
        post.uniqueOutpoints === post.count &&
        post.preseedIntact === PRESEED_CANCEL,
      `table=${post.count} (<${fullTotal}), uniqueIds=${post.uniqueIds}, uniqueOutpoints=${post.uniqueOutpoints}, preseed=${post.preseedIntact}`,
    );

    // The refreshed list must match exactly what was actually created.
    const shown = Math.min(50, post.count);
    await waitForShowing(page, shown, post.count, 60_000);
    const showingText = (
      await page.getByTestId('text-segments-showing').innerText()
    ).trim();
    step(
      'cancel: "Showing X of Y" matches the live table after cancellation',
      showingText.includes(`Showing ${shown.toLocaleString()} of ${post.count.toLocaleString()}`),
      `"${showingText}" vs table=${post.count}`,
    );

    const staleEmptyCopy = await page.getByText(/No custody segments built yet/).count();
    step(
      'cancel: no stale empty-state copy while segments exist',
      staleEmptyCopy === 0,
      `matches=${staleEmptyCopy}`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

// --- Session 3: cancel during step 1 leaves segments list untouched ------
async function runStep1CancelSession(browser, step, throttleRate) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await openFreshVault(context);

    const seeded = await page.evaluate(
      async ({ preseed, origins, preSegmentSrc }) => {
        const { createRecord } = await import('/src/lib/data/record-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants } = await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddCustodySegments } = await import('/src/lib/data/lineage-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        const preSegment = new Function(`return (${preSegmentSrc})`)();
        const pre = [];
        for (let i = 0; i < preseed; i++) pre.push(preSegment('canceleone', i));
        await bulkAddCustodySegments(pre, { skipNotification: true });

        // Same recipe as session 2: many independent funding txs so BOTH
        // phases have many abort checkpoints; here we cancel during phase 1.
        const C = 'bc1qcancelearlyccccccccccccccccccccccccc';
        const EXT = 'bc1qexternalpartyxxxxxxxxxxxxxxxxxxxxxxx';
        await createRecord(
          { type: 'address', inputString: C, label: 'Cancel early held', addressImportance: 'manual' },
          { skipVocabularySync: true, skipNotification: true },
        );

        const txs = [];
        const parts = [];
        for (let i = 0; i < origins; i++) {
          const txid = (i + 0x2000).toString(16).padStart(8, '0').repeat(8);
          txs.push({
            txid,
            blockHeight: 810000 + i,
            blockTime: 1710000000 + i * 600,
            fee: 200,
            feeRate: 2,
            syncedAt: Date.now(),
          });
          parts.push(
            { txid, role: 'input', address: EXT, amount: 51000 },
            { txid, role: 'output', address: C, amount: 50000, vout: 0 },
          );
        }
        await bulkAddTransactions(txs, { skipNotification: true });
        await bulkAddParticipants(parts, { skipNotification: true });

        return {
          segments: await db.custodySegments.count(),
          txs: txs.length,
          lineage: await db.utxoLineage.count(),
        };
      },
      { preseed: PRESEED_CANCEL, origins: CANCEL_ORIGINS, preSegmentSrc: preSegment.toString() },
    );
    step(
      'step1-cancel: seeded pre-existing segments + many origins, no utxoLineage',
      seeded.segments === PRESEED_CANCEL && seeded.txs === CANCEL_ORIGINS && seeded.lineage === 0,
      `segments=${seeded.segments}, txs=${seeded.txs}, lineage=${seeded.lineage}`,
    );

    await gotoProvenance(page);
    await waitForShowing(page, PRESEED_CANCEL, PRESEED_CANCEL);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttleRate });

    try {
      await page.getByTestId('button-build-lineage').click();

      // Wait for the LINEAGE phase (Step 1) to have processed a few
      // transactions, then cancel while still in step 1 — the earlier return
      // path in handleBuildLineage before any custody-segment work starts.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="lineage-build-progress"]');
          if (!el || !/Step 1 of 2/.test(el.textContent || '')) return false;
          if (!/Building UTXO lineage/.test(el.textContent || '')) return false;
          const counter = document.querySelector('[data-testid="text-build-counter"]');
          const m = counter && (counter.textContent || '').match(/^([\d,]+) of/);
          return !!m && parseInt(m[1].replace(/,/g, ''), 10) >= 3;
        },
        undefined,
        { timeout: 300_000 },
      );
      await page.getByTestId('button-cancel-build').dispatchEvent('click');
      await page
        .getByTestId('button-cancel-build-confirm')
        .dispatchEvent('click', undefined, { timeout: 2_000 })
        .catch(() => {});

      await page.getByTestId('lineage-build-progress').waitFor({ state: 'hidden', timeout: 300_000 });
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    }

    const post = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      const rows = await db.custodySegments.toArray();
      const ids = rows.map((s) => s.segmentId);
      return {
        segments: rows.length,
        preseedIntact: ids.filter((id) => id.startsWith('canceleone-seg-')).length,
        lineage: await db.utxoLineage.count(),
      };
    });

    // If the throttled run outraced the cancel past step 1, segments exist —
    // retry the attempt with a higher throttle rate.
    if (post.segments > PRESEED_CANCEL) {
      throw new Error(
        `step1 cancel raced past the lineage phase at throttle ${throttleRate}x (segments=${post.segments}); retrying with a higher rate`,
      );
    }
    step(
      'step1-cancel: no custody segments created; lineage stopped partially built',
      post.segments === PRESEED_CANCEL &&
        post.preseedIntact === PRESEED_CANCEL &&
        post.lineage > 0 &&
        post.lineage < CANCEL_ORIGINS,
      `segments=${post.segments} (=${PRESEED_CANCEL}), preseed=${post.preseedIntact}, lineage=${post.lineage} (0<x<${CANCEL_ORIGINS})`,
    );

    // Paged list must be untouched: same "Showing 10 of 10", no empty-state.
    await waitForShowing(page, PRESEED_CANCEL, PRESEED_CANCEL, 60_000);
    const staleEmptyCopy = await page.getByText(/No custody segments built yet/).count();
    step(
      'step1-cancel: paged list unchanged after lineage-phase cancel',
      staleEmptyCopy === 0,
      `Showing ${PRESEED_CANCEL} of ${PRESEED_CANCEL}, emptyStateMatches=${staleEmptyCopy}`,
    );

    // Full un-throttled re-run: partial lineage rows must not duplicate.
    await page.getByTestId('button-build-lineage').click();
    await page
      .getByTestId('lineage-build-progress')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => {});
    await page.getByTestId('lineage-build-progress').waitFor({ state: 'hidden', timeout: 300_000 });

    const fullTotal = PRESEED_CANCEL + CANCEL_ORIGINS;
    await waitForShowing(page, 50, fullTotal, 60_000);
    const rerun = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      const segs = await db.custodySegments.toArray();
      const lin = await db.utxoLineage.toArray();
      return {
        segments: segs.length,
        uniqueSegIds: new Set(segs.map((s) => s.segmentId)).size,
        uniqueOutpoints: new Set(segs.map((s) => `${s.originTxid}:${s.originVout}`)).size,
        lineage: lin.length,
        uniqueLineage: new Set(lin.map((l) => `${l.createdTxid}:${l.createdVout}`)).size,
      };
    });
    step(
      'step1-cancel: full re-run builds correct segments with no duplicates from partial lineage',
      rerun.segments === fullTotal &&
        rerun.uniqueSegIds === fullTotal &&
        rerun.uniqueOutpoints === fullTotal &&
        rerun.lineage === CANCEL_ORIGINS &&
        rerun.uniqueLineage === CANCEL_ORIGINS,
      `segments=${rerun.segments}/${fullTotal}, uniqueIds=${rerun.uniqueSegIds}, uniqueOutpoints=${rerun.uniqueOutpoints}, lineage=${rerun.lineage}/${CANCEL_ORIGINS}, uniqueLineage=${rerun.uniqueLineage}`,
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
    // Retry the whole run on environment flake (chromium crash, load timeout
    // under parallel validation) or a cancel that raced completion; each
    // attempt uses fresh contexts and an escalating CPU throttle rate.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      steps = [];
      const browser = await launchBrowser(exe);
      try {
        await runCompletionSession(browser, step);
        await runCancelSession(browser, step, THROTTLE_RATES[attempt - 1] ?? 20);
        await runStep1CancelSession(browser, step, THROTTLE_RATES[attempt - 1] ?? 20);
        break;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.log(`[build-refresh] attempt ${attempt} crashed: ${msg.split('\n')[0]}`);
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
  console.log(`\n[build-refresh] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length || steps.length === 0) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; ') || '(no steps ran)');
    process.exit(1);
  }
  console.log('[build-refresh] OK');
}

main().catch((err) => {
  console.error('[build-refresh] FATAL:', err);
  process.exit(1);
});
