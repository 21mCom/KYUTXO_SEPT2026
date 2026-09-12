#!/usr/bin/env node
// Real-browser verification that buildAllCustodySegments actually creates
// custody segments from REAL owned utxoLineage rows now that the origin scan
// (scanOwnedLineageOrigins) finds owned-created rows.
//
// Background: the origin scan previously used `where('createdOwned').equals(1)`
// on a boolean field, which silently matched ZERO rows in IndexedDB — so the
// downstream buildCustodySegment path effectively never ran against real data.
// The scan is fixed (pinned by lineageEngine.ownedOriginScan.test.ts); this
// check exercises the full build end-to-end in a real browser:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds (via the real CRUD helpers over live Dexie/IndexedDB):
//      - curated owned records for addresses A, B, C
//      - blockchainTransactions tx1..tx4 + participants
//      - owned utxoLineage rows forming: external→A→B→external (a 2-hop
//        spent chain), plus an independent still-held origin C, plus a
//        non-owned created row that must NOT become an origin.
//   3. Runs buildAllCustodySegments with an onProgress callback.
//   4. Asserts: 3 segments are created with the correct origin outpoints
//      (tx1:0, tx2:0, tx4:0), correct status/hopCount/evidence chains,
//      progress reported monotonically 1..3 of 3, and a re-run is idempotent
//      (no duplicate segments).
//   5. Reloads on /provenance and asserts the Custody stats card shows the
//      built segment count (UI surface).
//
// NOTE for reviewers: the UI consumer of buildAllCustodySegments is
// client/src/components/ContinuityProof.tsx (rendered on the /provenance
// page), whose "text-segment-count" stat reflects the custodySegments table.
//
// Usage: node scripts/check-custody-segment-build-browser.mjs

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'custody-build-check-123';
const MAX_ATTEMPTS = 3;

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
      console.log(`[custody-build] chromium launch failed (try ${i}): ${e.message.split('\n')[0]}`);
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

    // Seed + build + assert in one combined snippet against the live app DB.
    const result = await page.evaluate(async () => {
      const { createRecord } = await import('/src/lib/data/record-crud.ts');
      const { bulkAddTransactions, bulkAddParticipants } = await import('/src/lib/data/transaction-crud.ts');
      const { bulkAddUtxoLineage } = await import('/src/lib/data/lineage-crud.ts');
      const { buildAllCustodySegments } = await import('/src/lib/lineageEngine.ts');
      const { db } = await import('/src/lib/database.ts');

      const A = 'bc1qcustodyoriginaaaaaaaaaaaaaaaaaaaaaaa';
      const B = 'bc1qcustodyhopbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const C = 'bc1qcustodyheldcccccccccccccccccccccccc';
      const EXT = 'bc1qexternalpartyxxxxxxxxxxxxxxxxxxxxxxx';
      const tx1 = 'a1'.repeat(32); // funds A (origin 1)
      const tx2 = 'b2'.repeat(32); // A -> B (owned hop, origin 2 for B)
      const tx3 = 'c3'.repeat(32); // B -> EXT (custody ends)
      const tx4 = 'd4'.repeat(32); // funds C (origin 3, still held)
      const t1 = 1700000000, t2 = 1700003600, t3 = 1700007200, t4 = 1700010800;

      // Curated owned records so isOwnedAddress() sees A/B/C as ours.
      for (const [addr, label] of [[A, 'Origin A'], [B, 'Hop B'], [C, 'Held C']]) {
        await createRecord(
          {
            type: 'address',
            inputString: addr,
            label,
            addressImportance: 'manual',
            acquisitionMethod: addr === A ? 'purchase' : undefined,
          },
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

      // Owned utxoLineage rows — booleans, exactly as the real lineage builder
      // stores them (the shape the broken indexed scan silently missed).
      const now = Date.now();
      await bulkAddUtxoLineage(
        [
          {
            spentTxid: '', spentVout: 0, spentAddress: EXT, spentAmount: 101000,
            consumingTxid: tx1,
            createdTxid: tx1, createdVout: 0, createdAddress: A, createdAmount: 100000,
            spentOwned: false, createdOwned: true, isChange: false,
            confidence: 'high', blockTime: t1, blockHeight: 800000, createdAt: now,
          },
          {
            spentTxid: tx1, spentVout: 0, spentAddress: A, spentAmount: 100000,
            consumingTxid: tx2,
            createdTxid: tx2, createdVout: 0, createdAddress: B, createdAmount: 90000,
            spentOwned: true, createdOwned: true, isChange: false,
            confidence: 'high', blockTime: t2, blockHeight: 800010, createdAt: now,
          },
          {
            // Custody exits here: created side NOT owned — must not be an origin.
            spentTxid: tx2, spentVout: 0, spentAddress: B, spentAmount: 90000,
            consumingTxid: tx3,
            createdTxid: tx3, createdVout: 0, createdAddress: EXT, createdAmount: 80000,
            spentOwned: true, createdOwned: false, isChange: false,
            confidence: 'high', blockTime: t3, blockHeight: 800020, createdAt: now,
          },
          {
            spentTxid: '', spentVout: 0, spentAddress: EXT, spentAmount: 51000,
            consumingTxid: tx4,
            createdTxid: tx4, createdVout: 0, createdAddress: C, createdAmount: 50000,
            spentOwned: false, createdOwned: true, isChange: false,
            confidence: 'high', blockTime: t4, blockHeight: 800030, createdAt: now,
          },
        ],
        { skipNotification: true },
      );

      // Run the real build with progress capture.
      const progress = [];
      const buildResult = await buildAllCustodySegments((current, total) => {
        progress.push({ current, total });
      });

      const segments = (await db.custodySegments.toArray()).map((s) => ({
        originTxid: s.originTxid,
        originVout: s.originVout,
        originAddress: s.originAddress,
        originAmount: s.originAmount,
        currentAddress: s.currentAddress ?? null,
        currentAmount: s.currentAmount,
        status: s.status,
        hopCount: s.hopCount,
        evidenceTxids: s.evidenceTxids,
        narrative: s.narrative ?? '',
        acquisitionMethod: s.acquisitionMethod ?? null,
      }));

      // Idempotency: re-running must not duplicate segments.
      const rerun = await buildAllCustodySegments();
      const countAfterRerun = await db.custodySegments.count();

      return {
        buildResult, progress, segments, rerun, countAfterRerun,
        ids: { A, B, C, EXT, tx1, tx2, tx3, tx4 },
      };
    });

    const { buildResult, progress, segments, rerun, countAfterRerun, ids } = result;

    step(
      'build processed exactly the 3 owned-created origins',
      buildResult.processed === 3 && buildResult.created === 3,
      `processed=${buildResult.processed}, created=${buildResult.created}`,
    );

    const progressOk =
      progress.length === 3 &&
      progress.every((p, i) => p.current === i + 1 && p.total === 3);
    step(
      'progress reported monotonically 1..3 of 3',
      progressOk,
      JSON.stringify(progress),
    );

    const byOrigin = new Map(segments.map((s) => [`${s.originTxid}:${s.originVout}`, s]));
    step(
      'segments carry exactly the expected origin outpoints',
      segments.length === 3 &&
        byOrigin.has(`${ids.tx1}:0`) &&
        byOrigin.has(`${ids.tx2}:0`) &&
        byOrigin.has(`${ids.tx4}:0`),
      segments.map((s) => `${s.originTxid.slice(0, 8)}…:${s.originVout}`).join(', '),
    );

    const segA = byOrigin.get(`${ids.tx1}:0`);
    const chainAOk =
      !!segA &&
      segA.originAddress === ids.A &&
      segA.originAmount === 100000 &&
      segA.status === 'spent' &&
      segA.hopCount === 2 &&
      segA.currentAmount === 0 &&
      JSON.stringify(segA.evidenceTxids) === JSON.stringify([ids.tx1, ids.tx2, ids.tx3]) &&
      segA.acquisitionMethod === 'purchase' &&
      segA.narrative.includes('Fully spent');
    step(
      'A-origin segment traced the full owned chain to the external spend',
      chainAOk,
      segA ? `status=${segA.status}, hops=${segA.hopCount}, evidence=${segA.evidenceTxids.length}` : 'missing',
    );

    const segB = byOrigin.get(`${ids.tx2}:0`);
    const chainBOk =
      !!segB &&
      segB.originAddress === ids.B &&
      segB.originAmount === 90000 &&
      segB.status === 'spent' &&
      segB.hopCount === 1 &&
      JSON.stringify(segB.evidenceTxids) === JSON.stringify([ids.tx2, ids.tx3]);
    step(
      'B-origin segment records the single hop out of custody',
      chainBOk,
      segB ? `status=${segB.status}, hops=${segB.hopCount}` : 'missing',
    );

    const segC = byOrigin.get(`${ids.tx4}:0`);
    const chainCOk =
      !!segC &&
      segC.originAddress === ids.C &&
      segC.status === 'active' &&
      segC.hopCount === 0 &&
      segC.currentAddress === ids.C &&
      segC.currentAmount === 50000 &&
      segC.narrative.includes('still held');
    step(
      'C-origin segment stays active with funds still held',
      chainCOk,
      segC ? `status=${segC.status}, current=${segC.currentAmount}` : 'missing',
    );

    step(
      're-run is idempotent (no duplicate segments)',
      rerun.processed === 3 && countAfterRerun === 3,
      `rerun processed=${rerun.processed}, table count=${countAfterRerun}`,
    );

    // UI surface: /provenance Custody stats card reflects the built segments.
    await page.goto(`${BASE_URL}provenance`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 60_000 });

    const segCountEl = page.getByTestId('text-segment-count');
    await segCountEl.waitFor({ state: 'visible', timeout: 60_000 });
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="text-segment-count"]');
          return el && parseInt(el.textContent || '0', 10) >= 3;
        }, undefined,
        { timeout: 30_000 },
      )
      .catch(() => {});
    const segCountText = (await segCountEl.innerText()).trim();
    step(
      'Provenance page shows the built segment count',
      parseInt(segCountText, 10) === 3,
      `UI shows "${segCountText}"`,
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
        console.log(`[custody-build] attempt ${attempt} crashed: ${msg.split('\n')[0]}`);
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
  console.log(`\n[custody-build] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length || steps.length === 0) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; ') || '(no steps ran)');
    process.exit(1);
  }
  console.log('[custody-build] OK');
}

main().catch((err) => {
  console.error('[custody-build] FATAL:', err);
  process.exit(1);
});
