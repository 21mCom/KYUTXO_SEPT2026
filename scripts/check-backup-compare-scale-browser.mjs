#!/usr/bin/env node
// Real-browser SCALE guard for the "Compare backups" dialog (task: confirm the
// backup comparison stays responsive on huge backup files in a real browser).
//
// compareBackups (client/src/lib/backup/compare.ts) streams both ZIPs into
// natural-key maps and yields to the event loop every 20 batch lines. The
// unit/runtime suites pin correctness on small fixtures; THIS script proves
// the streaming design's actual promise on big archives in headless Chromium:
//
//   1. Fresh vault; seed a large vault entirely in-page via the live CRUD
//      singletons (chunked, mirroring check-address-checker-5k /
//      check-quantum-scan-scale seeding): 12,000 records, 6,000 transactions,
//      12,000 participants, sync state.
//   2. Export plaintext v3 zip A in-page (MemorySink); mutate at scale
//      (2,000 label edits, 500 deletes, 500 adds) and export zip B. Both
//      Blobs stay in-page — they are handed to the dialog through a
//      DataTransfer on the real file inputs, so no multi-MB buffer crosses
//      the CDP wire.
//   3. Run the dialog comparison and assert, while it runs:
//        - the progress bar ADVANCES through distinct percents and both
//          "Reading older/newer backup..." phases,
//        - the UI thread stays responsive: a real probe click on the dialog
//          lands mid-run, and an in-page event-loop lag recorder never sees a
//          multi-second freeze,
//      and afterwards that the diff completes within budget with the exact
//      expected counts (+500 added / −500 removed / ~2000 changed records).
//   4. Drill-down virtualization at 3,000 diff entries: only a bounded window
//      of rows is mounted; scrolling the drill-down to the bottom swaps the
//      window and reaches the last entry.
//   5. Cancel responsiveness: re-run the same huge comparison and cancel
//      mid-run — the dialog must return to the pick stage promptly.
//
// Usage: node scripts/check-backup-compare-scale-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script, incl. server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'compare-scale-check-123';

const RECORD_COUNT = 12_000;
const TX_COUNT = 15_000;
const PARTICIPANT_COUNT = 30_000; // 2 per transaction
const CHANGED_COUNT = 2_000;
const REMOVED_COUNT = 500;
const ADDED_COUNT = 500;
const DRILLDOWN_ENTRIES = CHANGED_COUNT + REMOVED_COUNT + ADDED_COUNT;

// Generous end-to-end budget for the comparison itself (streaming both zips +
// diff). Locally this lands well under a minute; kept loose so shared-CPU
// validation load can't flake it. A frozen main thread would blow way past it.
const COMPARE_BUDGET_MS = 240_000;
// Max tolerated single event-loop stall while the comparison runs. The
// 20-line yield cadence keeps stalls in the tens-of-ms range; multi-second
// stalls mean the streaming yields regressed.
const MAX_LOOP_STALL_MS = 3_000;

const addr = (i) => 'bc1qcmpscale' + i.toString(16).padStart(28, '0');
const txid = (i) => i.toString(16).padStart(64, '0');

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
      console.log(`[compare-scale] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
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
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await dismissMigrationOverlayIfPresent(page);
    return;
  }
  await pwInput.fill(SETUP_PASSWORD);
  const confirmInput = page.getByTestId('input-confirm-password');
  if (await confirmInput.isVisible().catch(() => false)) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
}

// Hands the two in-page Blobs (window.__cmpZips) to the dialog's real file
// inputs via a DataTransfer + change event — the exact path a user's file
// pick exercises, with no giant buffer crossing the CDP wire.
async function attachFilesInPage(page) {
  await page.getByTestId('input-compare-older-file').waitFor({ state: 'attached', timeout: 15_000 });
  await page.evaluate(() => {
    const set = (testid, blob, name) => {
      const input = document.querySelector(`[data-testid="${testid}"]`);
      if (!input) throw new Error(`${testid} not found`);
      const dt = new DataTransfer();
      dt.items.add(new File([blob], name, { type: 'application/zip' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('input-compare-older-file', window.__cmpZips.older, 'scale-older.zip');
    set('input-compare-newer-file', window.__cmpZips.newer, 'scale-newer.zip');
  });
  await page.getByTestId('text-older-file-name').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('text-newer-file-name').waitFor({ state: 'visible', timeout: 15_000 });
}

async function main() {
  const exe = resolveChromium();
  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[compare-scale] dev server not up — starting `npm run dev` ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error('Dev server did not become ready.');
    }
  }

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const browser = await launchWithRetry(exe);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));

    // Retry the initial load: under parallel validation the first goto can hit
    // a still-warming Vite pipeline.
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        await page.goto(`${BASE_URL}export`, { waitUntil: 'load', timeout: 60_000 });
        loaded = true;
      } catch (err) {
        console.log(`[compare-scale] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page);

    // ── Phase A: seed the large vault in-page (chunked) ─────────────────────
    const seedStart = Date.now();
    const seed = await page.evaluate(
      async ({ RECORD_COUNT, TX_COUNT }) => {
        const { bulkCreateRecords, clearAllRecords } = await import('/src/lib/data/record-crud.ts');
        const { bulkAddTransactions, bulkAddParticipants, clearTransactions, clearParticipants } =
          await import('/src/lib/data/transaction-crud.ts');
        const { bulkAddAddressSyncState, clearAddressSyncState } =
          await import('/src/lib/data/address-sync-crud.ts');

        await clearAllRecords({ skipNotification: true });
        await clearTransactions({ skipNotification: true });
        await clearParticipants({ skipNotification: true });
        await clearAddressSyncState({ skipNotification: true });

        const addr = (i) => 'bc1qcmpscale' + i.toString(16).padStart(28, '0');
        const txid = (i) => i.toString(16).padStart(64, '0');

        const CHUNK = 2000;
        const ids = [];
        for (let s = 0; s < RECORD_COUNT; s += CHUNK) {
          const batch = [];
          for (let i = s; i < Math.min(s + CHUNK, RECORD_COUNT); i++) {
            const a = addr(i);
            batch.push({
              type: 'address',
              inputString: a,
              inputStringLower: a,
              label: `Scale record ${i}`,
              // Fat notes bloat each row (and therefore the ZIPs) so the
              // comparison actually streams multi-MB archives for seconds —
              // long enough that progress/responsiveness are observable.
              notes: `seeded row #${i} for the compare-scale check ` + 'lorem-ipsum-padding '.repeat(16),
              source: 'manual',
              addressImportance: 'manual',
              tags: [],
              categories: [],
            });
          }
          const created = await bulkCreateRecords(batch, {
            skipNotification: true,
            skipVocabularySync: true,
          });
          ids.push(...created);
        }

        for (let s = 0; s < TX_COUNT; s += CHUNK) {
          const txBatch = [];
          const pBatch = [];
          for (let i = s; i < Math.min(s + CHUNK, TX_COUNT); i++) {
            txBatch.push({
              txid: txid(i),
              blockHeight: 800_000 + i,
              blockTime: 1_700_000_000 + i * 60,
              syncedAt: 1,
            });
            // Two participants per tx, anchored only to records that phase B
            // KEEPS (never the deleted tail), so the record deletions change
            // ONLY the records table.
            const keep = RECORD_COUNT - 500;
            const a1 = i % keep;
            const a2 = (i + 7) % keep;
            pBatch.push(
              { txid: txid(i), role: 'output', address: addr(a1), recordId: ids[a1], vout: 0 },
              { txid: txid(i), role: 'input', address: addr(a2), recordId: ids[a2], vout: 0 },
            );
          }
          await bulkAddTransactions(txBatch, { skipNotification: true });
          await bulkAddParticipants(pBatch, { skipNotification: true });
        }

        await bulkAddAddressSyncState(
          Array.from({ length: 500 }, (_, i) => ({ address: addr(i), syncDepth: 1 })),
          { skipNotification: true },
        );
        return { records: ids.length };
      },
      { RECORD_COUNT, TX_COUNT },
    );
    step(
      `seeded ${RECORD_COUNT} records / ${TX_COUNT} txs / ${PARTICIPANT_COUNT} participants in-page`,
      seed.records === RECORD_COUNT,
      `records=${seed.records} in ${Date.now() - seedStart}ms`,
    );

    // ── Phase B: export zip A, mutate at scale, export zip B (both in-page) ─
    const exportStart = Date.now();
    const sizes = await page.evaluate(
      async ({ RECORD_COUNT, CHANGED_COUNT, REMOVED_COUNT, ADDED_COUNT }) => {
        const { exportBackup } = await import('/src/lib/backup/export.ts');
        const { MemorySink } = await import('/src/lib/backup/sink.ts');
        const { bulkUpdateRecords, bulkDeleteRecords, bulkCreateRecords, getRecordsByInputStrings } =
          await import('/src/lib/data/record-crud.ts');

        const addr = (i) => 'bc1qcmpscale' + i.toString(16).padStart(28, '0');
        const attachmentIO = { async listAll() { return []; }, async read() { return null; } };
        const exportZip = async () => {
          const sink = new MemorySink();
          await exportBackup({ sink, encrypted: false, attachmentIO });
          return sink.blob;
        };

        const older = await exportZip();

        // 2,000 label edits on the head records.
        const CHUNK = 1000;
        for (let s = 0; s < CHANGED_COUNT; s += CHUNK) {
          const wanted = [];
          for (let i = s; i < Math.min(s + CHUNK, CHANGED_COUNT); i++) wanted.push(addr(i));
          const rows = await getRecordsByInputStrings(wanted);
          await bulkUpdateRecords(
            rows.map((r) => ({ id: r.id, changes: { label: `EDITED ${r.label}` } })),
            { skipNotification: true, skipVocabularySync: true },
          );
        }
        // 500 deletes from the tail (records with no participants/sync rows).
        const goneAddrs = [];
        for (let i = RECORD_COUNT - REMOVED_COUNT; i < RECORD_COUNT; i++) goneAddrs.push(addr(i));
        const goneRows = await getRecordsByInputStrings(goneAddrs);
        await bulkDeleteRecords(goneRows.map((r) => r.id), { skipNotification: true });
        // 500 brand-new records.
        const addedBatch = [];
        for (let i = 0; i < ADDED_COUNT; i++) {
          const a = 'bc1qcmpscaleadded' + i.toString(16).padStart(23, '0');
          addedBatch.push({
            type: 'address',
            inputString: a,
            inputStringLower: a,
            label: `Added record ${i}`,
            source: 'manual',
            addressImportance: 'manual',
            tags: [],
            categories: [],
          });
        }
        await bulkCreateRecords(addedBatch, { skipNotification: true, skipVocabularySync: true });

        const newer = await exportZip();
        window.__cmpZips = { older, newer };
        return { olderBytes: older.size, newerBytes: newer.size, deleted: goneRows.length };
      },
      { RECORD_COUNT, CHANGED_COUNT, REMOVED_COUNT, ADDED_COUNT },
    );
    step(
      'zip A exported; vault mutated (2000 edits / 500 deletes / 500 adds); zip B exported',
      sizes.olderBytes > 500_000 && sizes.newerBytes > 500_000 && sizes.deleted === REMOVED_COUNT,
      `older=${(sizes.olderBytes / 1e6).toFixed(1)}MB newer=${(sizes.newerBytes / 1e6).toFixed(1)}MB in ${Date.now() - exportStart}ms`,
    );

    // ── Phase C: run the dialog comparison; watch progress + responsiveness ─
    const openBtn = page.getByTestId('button-open-compare');
    await openBtn.scrollIntoViewIfNeeded();
    await openBtn.click();
    await page.getByTestId('compare-dialog').waitFor({ state: 'visible', timeout: 15_000 });
    await attachFilesInPage(page);

    // Throttle the CPU (CDP) for the comparison runs: the streaming compare is
    // fast on an idle dev box, so without throttling the run finishes before
    // progress/cancel behaviour can be observed. 6x is representative of a
    // weak laptop — exactly the machines the yield cadence protects.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

    // In-page instrumentation installed just before the run: an event-loop
    // stall recorder, a capture-phase click counter for the probe click, and
    // a MutationObserver progress log (records every rendered progress frame
    // even when Node-side polling misses fast transitions).
    await page.evaluate(() => {
      window.__progressLog = [];
      window.__progressObs = new MutationObserver(() => {
        const el = document.querySelector('[data-testid="compare-progress"]');
        if (el) window.__progressLog.push(el.innerText);
      });
      window.__progressObs.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await page.evaluate(() => {
      window.__loopStall = { max: 0 };
      let last = performance.now();
      window.__loopTimer = setInterval(() => {
        const now = performance.now();
        const stall = now - last - 100;
        if (stall > window.__loopStall.max) window.__loopStall.max = stall;
        last = now;
      }, 100);
      window.__probeClicks = 0;
      document.addEventListener('click', () => { window.__probeClicks += 1; }, true);
    });

    const compareStart = Date.now();
    await page.getByTestId('button-run-compare').click();
    const progressEl = page.getByTestId('compare-progress');
    const resultsEl = page.getByTestId('compare-results');

    // Poll progress until the results render, collecting distinct samples and
    // firing ONE probe click mid-run (once real progress is visible).
    const percents = new Set();
    const phases = new Set();
    let probeClickLatencyMs = null;
    let done = false;
    const deadline = Date.now() + COMPARE_BUDGET_MS;
    while (Date.now() < deadline) {
      if (await resultsEl.isVisible().catch(() => false)) {
        done = true;
        break;
      }
      const text = ((await progressEl.innerText().catch(() => '')) ?? '').trim();
      if (text) {
        const pct = text.match(/(\d+)%/);
        if (pct) percents.add(Number(pct[1]));
        const phase = text.match(/^(Reading [a-z]+ backup\.\.\.|Reading \w+\.\.\.|Comparing\.\.\.|Starting\.\.\.|Comparison complete)/m);
        if (phase) phases.add(phase[1]);
        // Probe click: once the run is demonstrably under way, land a real
        // click on the dialog and confirm the page processed it promptly.
        if (probeClickLatencyMs === null && pct && Number(pct[1]) > 5) {
          const t0 = Date.now();
          await page.getByTestId('compare-dialog').click({ position: { x: 20, y: 20 }, timeout: 10_000 }).catch(() => {});
          const clickDeadline = Date.now() + 10_000;
          while (Date.now() < clickDeadline) {
            const n = await page.evaluate(() => window.__probeClicks).catch(() => 0);
            if (n > 0) { probeClickLatencyMs = Date.now() - t0; break; }
            await page.waitForTimeout(50);
          }
          if (probeClickLatencyMs === null) probeClickLatencyMs = -1;
        }
      }
      await page.waitForTimeout(120);
    }
    const compareMs = Date.now() - compareStart;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const { maxStall, progressLog } = await page.evaluate(() => {
      clearInterval(window.__loopTimer);
      window.__progressObs.disconnect();
      return { maxStall: Math.round(window.__loopStall.max), progressLog: window.__progressLog };
    });
    // Fold the in-page progress frames into the sampled sets.
    for (const frame of progressLog) {
      const pct = String(frame).match(/(\d+)%/);
      if (pct) percents.add(Number(pct[1]));
      const phase = String(frame).match(
        /(Reading [a-z]+ backup\.\.\.|Reading \w+\.\.\.|Comparing\.\.\.|Starting\.\.\.|Comparison complete)/,
      );
      if (phase) phases.add(phase[1]);
    }

    step(
      `comparison over two ~${(sizes.olderBytes / 1e6).toFixed(1)}MB backups completes within budget`,
      done && compareMs <= COMPARE_BUDGET_MS,
      `done=${done} in ${compareMs}ms (budget ${COMPARE_BUDGET_MS}ms)`,
    );
    step(
      'progress bar advances through distinct percents with visible phase text',
      percents.size >= 3 && phases.size >= 1,
      `percents=${[...percents].sort((a, b) => a - b).join(',')} phases=${[...phases].join(' | ')}`,
    );
    // Both source files must be streamed with visible per-table phases: the
    // orchestrator emits "Reading older backup..." then table phases, then
    // "Reading newer backup..." — assert we saw progress on BOTH halves.
    const sortedPercents = [...percents].sort((a, b) => a - b);
    step(
      'progress covered both files (samples below and above the 46% file boundary)',
      sortedPercents.some((p) => p > 0 && p < 46) && sortedPercents.some((p) => p > 46),
      `range=${sortedPercents[0]}..${sortedPercents[sortedPercents.length - 1]}`,
    );
    step(
      'UI thread stayed responsive: probe click landed mid-run',
      probeClickLatencyMs !== null && probeClickLatencyMs >= 0 && probeClickLatencyMs < 5_000,
      `probeClickLatency=${probeClickLatencyMs}ms`,
    );
    step(
      `no multi-second event-loop stall during the run (max < ${MAX_LOOP_STALL_MS}ms)`,
      maxStall < MAX_LOOP_STALL_MS,
      `maxStall=${maxStall}ms`,
    );

    // ── Phase D: diff counts are exactly right at scale ─────────────────────
    const countText = async (testid) => page.getByTestId(testid).innerText().catch(() => '');
    const [added, removed, changed] = await Promise.all([
      countText('compare-count-records-added'),
      countText('compare-count-records-removed'),
      countText('compare-count-records-changed'),
    ]);
    step(
      `records summary: +${ADDED_COUNT} added / −${REMOVED_COUNT} removed / ~${CHANGED_COUNT} changed`,
      added.includes(String(ADDED_COUNT)) &&
        removed.includes(String(REMOVED_COUNT)) &&
        changed.includes(String(CHANGED_COUNT)),
      `added="${added}" removed="${removed}" changed="${changed}"`,
    );
    // No other table may report differences (participants/txs were untouched).
    const summaryTables = await page.locator('[data-testid^="compare-summary-"]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-testid')),
    );
    step(
      'only the records table reports differences',
      summaryTables.length === 1 && summaryTables[0] === 'compare-summary-records',
      `tables=${summaryTables.join(',')}`,
    );

    // ── Phase E: drill-down virtualization over 3,000 diff entries ──────────
    await page.getByTestId('button-toggle-records').click();
    const drill = page.getByTestId('compare-drilldown-records');
    await drill.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(400);
    const entrySelector = '[data-testid="compare-entry-records"]';
    const mountedTop = await page.locator(entrySelector).count();
    step(
      `drill-down mounts only a bounded window of the ${DRILLDOWN_ENTRIES} entries`,
      mountedTop > 0 && mountedTop < 400,
      `mounted=${mountedTop} of ${DRILLDOWN_ENTRIES}`,
    );

    const scrollStart = Date.now();
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="compare-drilldown-records"]');
      el.scrollTop = el.scrollHeight;
    });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const scrollProbeMs = Date.now() - scrollStart;
    await page.waitForTimeout(400);
    const bottom = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="compare-entry-records"]'));
      const idx = rows.map((r) => Number(r.getAttribute('data-index')));
      return { mounted: rows.length, maxIndex: Math.max(...idx), minIndex: Math.min(...idx) };
    });
    step(
      'scrolling the drill-down to the bottom reaches the last entry with a bounded window',
      bottom.mounted > 0 &&
        bottom.mounted < 400 &&
        bottom.maxIndex === DRILLDOWN_ENTRIES - 1 &&
        bottom.minIndex > 0 &&
        scrollProbeMs < 3_000,
      `mounted=${bottom.mounted} indices=${bottom.minIndex}..${bottom.maxIndex} scroll+2xRAF=${scrollProbeMs}ms`,
    );

    // ── Phase F: cancel is responsive mid-run on the same huge files ────────
    // A warmed-up (JIT + cache) re-run can finish very quickly, so cancel is
    // clicked the instant the running stage renders, with escalating CPU
    // throttle retries if the run still outraces the click.
    let cancelResult = null;
    for (const rate of [8, 14, 20]) {
      await page.getByTestId('button-compare-again').click();
      await attachFilesInPage(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await page.getByTestId('button-run-compare').click();
      const cancelBtn = page.getByTestId('button-cancel-compare');
      await cancelBtn.waitFor({ state: 'visible', timeout: 15_000 });
      const cancelStart = Date.now();
      // dispatchEvent lands even while the main thread is chewing between
      // yields (no actionability retries that could straddle completion).
      await cancelBtn.dispatchEvent('click').catch(() => {});
      const outcome = await Promise.race([
        page
          .getByTestId('button-run-compare')
          .waitFor({ state: 'visible', timeout: 20_000 })
          .then(() => 'pick'),
        resultsEl.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'results'),
      ]).catch(() => 'timeout');
      const cancelMs = Date.now() - cancelStart;
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      cancelResult = { outcome, cancelMs, rate };
      if (outcome === 'pick') break;
      console.log(`[compare-scale] cancel raced completion at rate=${rate} (${outcome}); retrying slower`);
    }
    step(
      'cancelling mid-run returns to the pick stage promptly',
      cancelResult?.outcome === 'pick' && cancelResult.cancelMs < 8_000,
      `outcome=${cancelResult?.outcome} cancelLatency=${cancelResult?.cancelMs}ms rate=${cancelResult?.rate}x`,
    );
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try {
        process.kill(-devProc.pid);
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n${steps.length - failed.length}/${steps.length} checks passed`);
  if (failed.length > 0) {
    console.error('FAILED checks:');
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
