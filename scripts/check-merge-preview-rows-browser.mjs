#!/usr/bin/env node
// Real-browser verification that the NEW merge-preview rows (evidence
// documents, price history, dust flags, saved PSBTs) actually render in the
// Restore dialog's read-only "Merge preview" when analyzing a REAL v3 backup —
// and stay hidden when the backup carries none of those rows.
//
// The runtime suite (merge-analysis.runtime.test.ts) proves analyzeV3Backup's
// counts; this check proves the DIALOG surface: restore-backup-flow.tsx renders
// analysis-row-inline-{evidence,priceData,dustFlags,savedPsbts} only when the
// backup carries rows, with correct "N new · M already present" text.
//
// In headless Chromium against the dev server:
//   1. Creates/unlocks a vault, seeds a "backup source" vault with a record
//      plus TWO rows each of evidence / priceData / dustFlags / savedPsbts via
//      the live CRUD singletons, and exports a REAL v3 zip (zipFull).
//   2. Clears those four tables and exports a second real zip that carries
//      NONE of them (zipEmpty) — the record remains so analysis still runs.
//   3. Reshapes the live vault: re-adds exactly ONE natural-key-matching row
//      per table (evidenceIdentity / date+currency+asset / outpoint /
//      psbtBase64) so the preview must report "1 new · 1 already present".
//   4. Drives the ACTUAL Settings dialog: Restore → file-select (zipFull) →
//      Merge radio → Analyze, and asserts all four inline rows are visible
//      with the exact counts.
//   5. Reloads, repeats with zipEmpty, and asserts the four rows are ABSENT
//      while the analysis results (records row) still render.
//   6. Repeats with a PASSWORD-PROTECTED (encrypted) export: asserts Analyze
//      is disabled until a password is entered, the correct password yields
//      the same four rows/counts, and a WRONG password fails cleanly (toast,
//      no results) without changing any vault table counts.
//
// Usage: node scripts/check-merge-preview-rows-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script, incl. server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'merge-preview-check-123';
const BACKUP_PASSWORD = 'encrypted-preview-pw-456';
const WRONG_PASSWORD = 'definitely-not-the-password';

const ADDR = 'bc1qmergepreviewrows000000000000000000000000';
// Distinct first-8 chars everywhere (testid-collision lesson).
const DUST_TXID_A = 'a1'.padEnd(64, '0');
const DUST_TXID_B = 'b2'.padEnd(64, '0');

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
      console.log(`[merge-preview-rows] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

// Open the Settings restore dialog, feed it a zip, pick Merge, run Analyze,
// and wait for the results panel. For encrypted zips pass opts.password;
// opts.expectFailure waits for the destructive toast instead of results.
// Returns { analyzeDisabledBeforePassword } for encrypted gating asserts.
async function analyzeZip(page, zipB64, zipName, opts = {}) {
  await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page, SETUP_PASSWORD);

  const openBtn = page.getByTestId('button-open-restore');
  await openBtn.scrollIntoViewIfNeeded();
  await openBtn.click();

  await page.getByTestId('input-restore-file').setInputFiles({
    name: zipName,
    mimeType: 'application/zip',
    buffer: Buffer.from(zipB64, 'base64'),
  });
  // Manifest peek renders the backup info card.
  await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });

  await page.getByTestId('radio-merge').click();
  const analyzeBtn = page.getByTestId('button-analyze-merge');
  await analyzeBtn.scrollIntoViewIfNeeded();

  let analyzeDisabledBeforePassword = null;
  if (opts.password !== undefined) {
    // Encrypted path: the button must be gated until a password is entered.
    analyzeDisabledBeforePassword = await analyzeBtn.isDisabled();
    const pwField = page.getByTestId('input-restore-password');
    await pwField.waitFor({ state: 'visible', timeout: 10_000 });
    await pwField.fill(opts.password);
  }

  await analyzeBtn.click();
  if (opts.expectFailure) {
    // Wrong password must surface the non-destructive failure toast (toast
    // text duplicates into aria-live — use .first()).
    await page
      .getByText('Could not analyze backup', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
  } else {
    await page.getByTestId('analysis-results').waitFor({ state: 'visible', timeout: 60_000 });
  }
  return { analyzeDisabledBeforePassword };
}

async function main() {
  const exe = resolveChromium();
  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[merge-preview-rows] dev server not up — starting `npm run dev` ...');
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

    // Retry the initial load: under parallel validation the first goto can
    // hit a still-warming Vite pipeline.
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        loaded = true;
      } catch (err) {
        console.log(`[merge-preview-rows] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page);

    // ── Phase A: seed source vault, export zipFull + zipEmpty, then reshape
    //    the live vault so exactly ONE row per table collides by natural key ──
    const { zipFullB64, zipEmptyB64, zipEncB64 } = await page.evaluate(
      async ({ ADDR, DUST_TXID_A, DUST_TXID_B, BACKUP_PASSWORD }) => {
        const { bulkCreateRecords, clearAllRecords } = await import('/src/lib/data/record-crud.ts');
        const { addEvidence, clearAllEvidenceData } = await import('/src/lib/data/evidence-crud.ts');
        const { addPriceData, clearPriceData } = await import('/src/lib/data/price-data-crud.ts');
        const { markOutpointsAsDust, clearDustFlags } = await import('/src/lib/data/dust-flags-crud.ts');
        const { savePsbt, clearSavedPsbts } = await import('/src/lib/data/saved-psbts-crud.ts');
        const { exportBackup } = await import('/src/lib/backup/export.ts');
        const { MemorySink } = await import('/src/lib/backup/sink.ts');

        const exportZipB64 = async (password) => {
          const sink = new MemorySink();
          await exportBackup({
            sink,
            encrypted: Boolean(password),
            password,
            batchSize: 25,
            attachmentIO: {
              async listAll() { return []; },
              async read() { return null; },
            },
          });
          const buf = new Uint8Array(await sink.blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          return btoa(bin);
        };

        // Start from a known-empty state for the tables under test.
        await clearAllRecords({ skipNotification: true });
        await clearAllEvidenceData({ skipNotification: true });
        await clearPriceData({ skipNotification: true });
        await clearDustFlags({ skipNotification: true });
        await clearSavedPsbts({ skipNotification: true });

        await bulkCreateRecords(
          [{
            type: 'address',
            inputString: ADDR,
            label: 'Merge preview rows check',
            tags: [],
            categories: [],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          }],
          { skipNotification: true, skipVocabularySync: true },
        );

        // Natural keys: evidence = title+documentType+originalDate;
        // priceData = date+currency+asset; dustFlags = outpoint;
        // savedPsbts = psbtBase64.
        const evShared = { title: 'Shared preview doc', documentType: 'receipt', originalDate: 1_690_000_000, notes: 'shared', tags: [] };
        const evNew = { title: 'Backup-only preview doc', documentType: 'email', originalDate: 1_691_000_000, notes: 'backup-only', tags: [] };
        await addEvidence(evShared, { skipNotification: true });
        await addEvidence(evNew, { skipNotification: true });

        const priceShared = { date: '2023-07-01', currency: 'USD', asset: 'BTC', close: 30000, source: 'merge-preview-check', importedAt: 1_700_000_000_000 };
        const priceNew = { date: '2023-07-02', currency: 'USD', asset: 'BTC', close: 30500, source: 'merge-preview-check', importedAt: 1_700_000_000_000 };
        await addPriceData(priceShared, { skipNotification: true });
        await addPriceData(priceNew, { skipNotification: true });

        const dustShared = { txid: DUST_TXID_A, vout: 0, address: ADDR, amountSats: 546 };
        const dustNew = { txid: DUST_TXID_B, vout: 1, address: ADDR, amountSats: 600 };
        await markOutpointsAsDust([dustShared, dustNew]);

        const psbtBase = {
          destinationAddress: ADDR,
          feeRateSatsPerVb: 2,
          feeSats: 300,
          estimatedVbytes: 150,
          totalInputSats: 20_000,
          sendAmountSats: 19_700,
          changeSats: 0,
          inputs: [{ txid: DUST_TXID_A, vout: 0, address: ADDR, amountSats: 20_000, scriptType: 'P2WPKH' }],
          outputs: [{ address: ADDR, amountSats: 19_700, isChange: false }],
        };
        const psbtSharedB64 = 'cHNidP8BAHNoYXJlZC1wcmV2aWV3LXBzYnQ=';
        const psbtNewB64 = 'cHNidP8BAG5ldy1wcmV2aWV3LXBzYnQ=';
        await savePsbt({ ...psbtBase, name: 'Shared preview PSBT', psbtBase64: psbtSharedB64 });
        await savePsbt({ ...psbtBase, name: 'Backup-only preview PSBT', psbtBase64: psbtNewB64 });

        // zipFull carries 2 rows in each of the four tables; zipEnc is the
        // SAME content exported as a password-protected (encrypted) v3 zip.
        const zipFullB64 = await exportZipB64();
        const zipEncB64 = await exportZipB64(BACKUP_PASSWORD);

        // zipEmpty carries NONE of them (record remains so analysis has data).
        await clearAllEvidenceData({ skipNotification: true });
        await clearPriceData({ skipNotification: true });
        await clearDustFlags({ skipNotification: true });
        await clearSavedPsbts({ skipNotification: true });
        const zipEmptyB64 = await exportZipB64();

        // Reshape the LIVE vault: exactly one natural-key match per table, so
        // analyzing zipFull must show "1 new · 1 already present" on each row.
        await addEvidence(evShared, { skipNotification: true });
        await addPriceData(priceShared, { skipNotification: true });
        await markOutpointsAsDust([dustShared]);
        await savePsbt({ ...psbtBase, name: 'Shared preview PSBT (live)', psbtBase64: psbtSharedB64 });

        return { zipFullB64, zipEmptyB64, zipEncB64 };
      },
      { ADDR, DUST_TXID_A, DUST_TXID_B, BACKUP_PASSWORD },
    );
    step('source vault seeded; zipFull + zipEmpty + zipEnc exported; live vault holds 1 matching row per table',
      zipFullB64.length > 100 && zipEmptyB64.length > 100 && zipEncB64.length > 100,
      `full=${Math.round(zipFullB64.length * 0.75)}B empty=${Math.round(zipEmptyB64.length * 0.75)}B enc=${Math.round(zipEncB64.length * 0.75)}B`);

    // ── Phase B: analyze zipFull — all four rows visible with exact counts ──
    await analyzeZip(page, zipFullB64, 'merge-preview-full.zip');

    const ROWS = [
      ['evidence', 'Evidence documents'],
      ['priceData', 'Price history'],
      ['dustFlags', 'Dust flags'],
      ['savedPsbts', 'Saved PSBTs'],
    ];
    for (const [key, label] of ROWS) {
      const row = page.getByTestId(`analysis-row-inline-${key}`);
      const visible = await row.isVisible().catch(() => false);
      const text = visible ? (await row.innerText()).replace(/\s+/g, ' ').trim() : '(absent)';
      step(
        `zipFull: "${label}" preview row shows 1 new · 1 already present`,
        visible && text.includes(label) && text.includes('1 new') && text.includes('1 already present'),
        text,
      );
    }

    // ── Phase C: analyze zipEmpty — the four rows must be ABSENT ────────────
    // Full reload so the dialog state (file, analysis) starts fresh.
    await analyzeZip(page, zipEmptyB64, 'merge-preview-empty.zip');

    const recordsRowVisible = await page.getByTestId('analysis-row-records').isVisible().catch(() => false);
    step('zipEmpty: analysis still renders (records row visible)', recordsRowVisible);
    for (const [key, label] of ROWS) {
      const count = await page.getByTestId(`analysis-row-inline-${key}`).count();
      step(`zipEmpty: "${label}" preview row is hidden when the backup carries none`, count === 0, `count=${count}`);
    }

    // ── Phase D: encrypted zip + CORRECT password — same rows, same counts ──
    const { analyzeDisabledBeforePassword } = await analyzeZip(
      page, zipEncB64, 'merge-preview-encrypted.zip', { password: BACKUP_PASSWORD },
    );
    step('zipEnc: Analyze button is disabled until a password is entered',
      analyzeDisabledBeforePassword === true);
    for (const [key, label] of ROWS) {
      const row = page.getByTestId(`analysis-row-inline-${key}`);
      const visible = await row.isVisible().catch(() => false);
      const text = visible ? (await row.innerText()).replace(/\s+/g, ' ').trim() : '(absent)';
      step(
        `zipEnc + correct password: "${label}" preview row shows 1 new · 1 already present`,
        visible && text.includes(label) && text.includes('1 new') && text.includes('1 already present'),
        text,
      );
    }

    // ── Phase E: encrypted zip + WRONG password — clean failure, vault
    //    untouched ──────────────────────────────────────────────────────────
    const countsBefore = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      return {
        records: await db.records.count(),
        evidence: await db.evidence.count(),
        priceData: await db.priceData.count(),
        dustFlags: await db.dustFlags.count(),
        savedPsbts: await db.savedPsbts.count(),
      };
    });

    await analyzeZip(page, zipEncB64, 'merge-preview-encrypted.zip', {
      password: WRONG_PASSWORD,
      expectFailure: true,
    });
    step('zipEnc + wrong password: failure toast surfaces ("Could not analyze backup")', true);

    const resultsCount = await page.getByTestId('analysis-results').count();
    step('zipEnc + wrong password: no analysis results render', resultsCount === 0, `count=${resultsCount}`);

    const countsAfter = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      return {
        records: await db.records.count(),
        evidence: await db.evidence.count(),
        priceData: await db.priceData.count(),
        dustFlags: await db.dustFlags.count(),
        savedPsbts: await db.savedPsbts.count(),
      };
    });
    step(
      'zipEnc + wrong password: vault untouched (table counts unchanged)',
      JSON.stringify(countsAfter) === JSON.stringify(countsBefore),
      `before=${JSON.stringify(countsBefore)} after=${JSON.stringify(countsAfter)}`,
    );

    await context.close();
  } finally {
    await browser.close().catch(() => {});
    if (devProc && devProc.pid) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  console.log(`\n[merge-preview-rows] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.error('FAILED steps:', failed.map((s) => s.name).join('; '));
    process.exit(1);
  }
  console.log('[merge-preview-rows] OK');
}

main().catch((err) => {
  console.error('[merge-preview-rows] FATAL:', err.stack || err.message);
  process.exit(1);
});
