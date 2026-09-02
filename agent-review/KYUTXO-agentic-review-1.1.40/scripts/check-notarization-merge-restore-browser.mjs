#!/usr/bin/env node
// Real-browser end-to-end guard: notarized evidence files stay VERIFIABLE
// across a MERGE restore that de-dupes the document onto an existing live row.
//
// Sibling of check-notarization-restore-browser.mjs (which covers REPLACE
// mode). Merge mode takes DIFFERENT remap paths in restoreEvidenceRows:
// a backup evidence row whose identity (title + documentType + originalDate)
// already exists live is SKIPPED and mapped onto the surviving live row, and
// its attachments are mapped onto the live attachments by FILENAME. The
// restored saved-PSBT notarization output must be remapped through those
// identity/filename maps — Node runtime tests prove the maps, but nothing
// exercised the whole journey in a real browser until this check.
//
// NOTE for reviewers: the merge-mode identity/filename mapping under test
// lives in client/src/lib/data/evidence-crud.ts (restoreEvidenceRows) and
// client/src/lib/data/saved-psbts-crud.ts (restoreSavedPsbtRows's
// remapEvidenceRefs); the UI surfaces are client/src/pages/Evidence-related
// components (Notarized badge + Verify) driven via the Settings restore dialog.
//
// Flow, in headless Chromium against the dev server:
//   1. Fresh vault; seed decoy evidence docs + attachments, an owned BIP-84
//      address with two confirmed UTXOs, and the real evidence document with
//      a REAL uploaded attachment file.
//   2. Notarize via the Evidence page UI (WebCrypto SHA-256 -> UTXOs intent
//      banner -> Build PSBT with the OP_RETURN output -> Save).
//   3. Export an UNENCRYPTED v3 backup in-page (exportBackup + MemorySink).
//   4. Wipe the evidence/attachment/saved-PSBT tables, insert fresh decoy
//      rows (advancing the autoincrement counters), then RE-CREATE the SAME
//      notarized document (identical title/documentType + same filename,
//      freshly uploaded bytes) — the same document now lives under DIFFERENT
//      ids than the backup carried.
//   5. Drive the real Settings restore dialog in MERGE mode with the zip.
//   6. Assert the backup evidence row was de-duped onto the pre-existing live
//      row (exactly ONE document with the fixture title, keeping the live
//      ids), and the restored saved-PSBT notarization output points at those
//      SURVIVING live ids — not the backup's stale ids.
//   7. Evidence page still shows the Notarized badge on the live attachment
//      and Verify re-hashes the live bytes and reports a match.
//
// Usage: node scripts/check-notarization-merge-restore-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'notarize-merge-restore-check-123';

// BIP-84 test-vector fixtures (same as check-psbt-builder-browser.mjs) so
// scriptPubKey reconstruction works in the browser.
const ADDR_W0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/84'/0'/0'/0/0
const ADDR_W1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'; // m/84'/0'/0'/0/1
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const MASTER_FINGERPRINT = '73c5da0a';
const DERIVATION_PATH = "m/84'/0'/0'/0/0";
const TX_A = 'ce'.repeat(32);
const TX_B = 'df'.repeat(32);

const EVIDENCE_TITLE = 'Notarize-merge-restore fixture';
const EVIDENCE_DOC_TYPE = 'contract';
const EVIDENCE_FILE_NAME = 'notarize-merge-restore-me.txt';
// Round 2: the live copy of the SAME document carries a RENAMED file, so the
// merge's filename map finds no match and the saved-PSBT attachment reference
// must be DROPPED (never left dangling at an unrelated live attachment).
const EVIDENCE_RENAMED_FILE_NAME = 'renamed-after-notarization.txt';
const EVIDENCE_FILE_CONTENT = 'kyutxo notarization MERGE restore fixture file\n';
const EXPECTED_DIGEST = createHash('sha256').update(EVIDENCE_FILE_CONTENT, 'utf8').digest('hex');

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
      console.log(`[notarize-merge-restore-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[notarize-merge-restore-browser] chromium: ${exe}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[notarize-merge-restore-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
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
    page.on('pageerror', (e) => console.log(`[notarize-merge-restore-browser][page-error] ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[notarize-merge-restore-browser][page-console] ${msg.text()}`);
    });

    // Retry the initial load: under parallel validation the first goto can
    // hit a still-warming Vite pipeline.
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
        loaded = true;
      } catch (err) {
        console.log(`[notarize-merge-restore-browser] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    // ── Phase 1: seed decoys + UTXOs + the real evidence with a real file ──
    const seed = await page.evaluate(
      async ({ addr, txA, txB, zpub, fingerprint, derivationPath, title, docType, filename, content }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const templateCrud = await import('/src/lib/data/derivation-templates-crud.ts');
        const evCrud = await import('/src/lib/data/evidence-crud.ts');
        const psbtCrud = await import('/src/lib/data/saved-psbts-crud.ts');
        const attachments = await import('/src/lib/attachments.ts');

        // Fresh notarization tables in case another check ran before us.
        await evCrud.clearAllEvidenceData();
        await psbtCrud.clearSavedPsbts();

        // Decoy evidence docs + attachments FIRST, so the real fixture's
        // backup ids are not the table's first ids.
        const decoyIds = [];
        for (let i = 0; i < 2; i++) {
          const dId = await evCrud.addEvidence({
            title: `Decoy pre-export doc ${i}`,
            documentType: 'other',
            tags: [],
          });
          await evCrud.addEvidenceAttachment({
            evidenceId: dId,
            filename: `merge-decoy-${i}.bin`,
            mimeType: 'application/octet-stream',
            size: 3,
            objectStoragePath: `zz/notarize-merge-restore-decoy-${i}.bin`,
          });
          decoyIds.push(dId);
        }

        // Owned address with two confirmed outputs (real BIP-84 vector).
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'Notarize-merge-restore check address',
          xpub: zpub,
          derivationPath,
        });
        await templateCrud.addDerivationTemplate({
          fingerprint,
          scriptType: 'P2WPKH',
          derivationPath: "m/84'/0'/0'",
          xpub: zpub,
          gapLimit: 20,
          network: 'mainnet',
        });
        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({ txid: txA, blockHeight: 800000, blockTime: now - 2 * 86400, fee: 100, feeRate: 1, syncedAt: Date.now() });
        await txCrud.addTransaction({ txid: txB, blockHeight: 800100, blockTime: now - 86400, fee: 100, feeRate: 1, syncedAt: Date.now() });
        await txCrud.addParticipant({ txid: txA, role: 'output', address: addr, amount: 100_000, vout: 0, recordId });
        await txCrud.addParticipant({ txid: txB, role: 'output', address: addr, amount: 60_000, vout: 1, recordId });

        // The real evidence document with a REAL uploaded attachment file
        // (through the app's own upload path, so the backup carries bytes).
        const file = new File([content], filename, { type: 'text/plain' });
        const storagePath = await attachments.uploadFile(file);
        const evidenceId = await evCrud.addEvidence({
          title,
          documentType: docType,
          tags: [],
        });
        const attachmentId = await evCrud.addEvidenceAttachment({
          evidenceId,
          filename,
          mimeType: 'text/plain',
          size: content.length,
          objectStoragePath: storagePath,
        });
        return { evidenceId, attachmentId, decoyIds };
      },
      {
        addr: ADDR_W0,
        txA: TX_A,
        txB: TX_B,
        zpub: ZPUB,
        fingerprint: MASTER_FINGERPRINT,
        derivationPath: DERIVATION_PATH,
        title: EVIDENCE_TITLE,
        docType: EVIDENCE_DOC_TYPE,
        filename: EVIDENCE_FILE_NAME,
        content: EVIDENCE_FILE_CONTENT,
      },
    );
    step(
      'seeded decoys + UTXOs + real evidence with an uploaded attachment',
      seed.evidenceId > 2 && seed.attachmentId > 2,
      `evidenceId=${seed.evidenceId} attachmentId=${seed.attachmentId} (decoys=${seed.decoyIds.join(',')})`,
    );

    // ── Phase 2: notarize via the Evidence page UI ──────────────────────────
    await page.goto(`${BASE_URL}evidence`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    const card = page.getByTestId(`card-evidence-${seed.evidenceId}`);
    await card.waitFor({ state: 'visible', timeout: 30_000 });
    await card.click();
    await page.getByTestId('button-preview-edit').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('button-preview-edit').click();
    const notarizeBtn = page.getByTestId(`button-notarize-${seed.attachmentId}`);
    await notarizeBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await notarizeBtn.click();

    const intentBar = page.getByTestId('bar-notarization-intent');
    const intentVisible = await intentBar
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    step('Notarize click hashed the file and landed on UTXOs with the intent banner', intentVisible);

    // Select the two UTXOs, build with the OP_RETURN output, save.
    const groupRow = page.getByTestId(`row-address-${ADDR_W0.slice(0, 8)}`);
    await groupRow.waitFor({ state: 'visible', timeout: 30_000 });
    await groupRow.click();
    await page.getByTestId(`checkbox-utxo-${TX_A}:0`).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId(`checkbox-utxo-${TX_A}:0`).click();
    await page.getByTestId(`checkbox-utxo-${TX_B}:1`).click();
    await page.getByTestId('button-build-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('panel-notarization-intent').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('input-destination').fill(ADDR_W1);
    await page.getByTestId('panel-build-summary').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('button-save-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'detached', timeout: 15_000 });

    // Sanity: the saved row's notarization output references the fixture ids.
    const preRestore = await page.evaluate(async () => {
      const crud = await import('/src/lib/data/saved-psbts-crud.ts');
      const rows = await crud.getAllSavedPsbts();
      const row = rows.find((r) => r.outputs?.some((o) => o.dataOutput));
      const dataOut = row?.outputs?.find((o) => o.dataOutput)?.dataOutput;
      return {
        savedCount: rows.length,
        dataOutput: dataOut
          ? {
              evidenceId: dataOut.evidenceId,
              evidenceAttachmentId: dataOut.evidenceAttachmentId,
              payloadHex: dataOut.payloadHex,
              isNotarization: dataOut.isNotarization,
            }
          : null,
      };
    });
    step(
      'saved notarization PSBT references the fixture evidence/attachment ids',
      preRestore.dataOutput?.isNotarization === true &&
        preRestore.dataOutput?.evidenceId === seed.evidenceId &&
        preRestore.dataOutput?.evidenceAttachmentId === seed.attachmentId &&
        preRestore.dataOutput?.payloadHex === EXPECTED_DIGEST,
      `savedCount=${preRestore.savedCount} dataOutput=${JSON.stringify(preRestore.dataOutput)}`,
    );

    // ── Phase 3: export an UNENCRYPTED v3 backup in-page ────────────────────
    const zipB64 = await page.evaluate(async () => {
      const { exportBackup } = await import('/src/lib/backup/export.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');
      // Same attachment IO the Export page wires up (web mode endpoints).
      const listAll = async () => {
        const res = await fetch('/api/attachments/list-all');
        const data = await res.json();
        return data.success ? (data.files || []) : [];
      };
      const read = async (relativePath) => {
        const res = await fetch(`/api/attachments/download/attachments/${relativePath}`);
        return res.ok ? await res.arrayBuffer() : null;
      };
      const sink = new MemorySink();
      await exportBackup({ sink, encrypted: false, batchSize: 25, attachmentIO: { listAll, read } });
      const buf = new Uint8Array(await sink.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin);
    });
    step('unencrypted v3 backup exported in-page', zipB64.length > 100, `${Math.round(zipB64.length * 0.75)} bytes`);

    // ── Phase 4: wipe + recreate the SAME document under DIFFERENT ids ─────
    // Clear evidence/attachments/saved PSBTs, insert fresh decoys (clear()
    // does NOT reset IndexedDB autoincrement key generation, so the counters
    // advance past the backup's ids), then RE-CREATE the same notarized
    // document (identical identity: title + documentType + originalDate, and
    // the same attachment filename with freshly uploaded real bytes). The
    // merge restore MUST de-dupe the backup rows onto these live rows and
    // remap the saved-PSBT references onto their ids.
    const live = await page.evaluate(
      async ({ title, docType, filename, content }) => {
        const evCrud = await import('/src/lib/data/evidence-crud.ts');
        const psbtCrud = await import('/src/lib/data/saved-psbts-crud.ts');
        const attachments = await import('/src/lib/attachments.ts');
        await evCrud.clearAllEvidenceData();
        await psbtCrud.clearSavedPsbts();
        // Post-wipe decoys advance the autoincrement counters first.
        for (let i = 0; i < 3; i++) {
          const dId = await evCrud.addEvidence({
            title: `Decoy post-wipe doc ${i}`,
            documentType: 'other',
            tags: [],
          });
          await evCrud.addEvidenceAttachment({
            evidenceId: dId,
            filename: `post-wipe-merge-decoy-${i}.bin`,
            mimeType: 'application/octet-stream',
            size: 3,
            objectStoragePath: `zz/notarize-merge-restore-postwipe-${i}.bin`,
          });
        }
        // The SAME document, re-created live: identical identity + filename.
        const file = new File([content], filename, { type: 'text/plain' });
        const storagePath = await attachments.uploadFile(file);
        const liveEvidenceId = await evCrud.addEvidence({
          title,
          documentType: docType,
          tags: [],
        });
        const liveAttachmentId = await evCrud.addEvidenceAttachment({
          evidenceId: liveEvidenceId,
          filename,
          mimeType: 'text/plain',
          size: content.length,
          objectStoragePath: storagePath,
        });
        const evCount = (await evCrud.getAllEvidence()).length;
        const psbtCount = (await psbtCrud.getAllSavedPsbts()).length;
        return { liveEvidenceId, liveAttachmentId, evCount, psbtCount };
      },
      { title: EVIDENCE_TITLE, docType: EVIDENCE_DOC_TYPE, filename: EVIDENCE_FILE_NAME, content: EVIDENCE_FILE_CONTENT },
    );
    step(
      'wiped + recreated the SAME notarized document under DIFFERENT live ids',
      live.evCount === 4 &&
        live.psbtCount === 0 &&
        live.liveEvidenceId !== seed.evidenceId &&
        live.liveAttachmentId !== seed.attachmentId,
      `evidence ${seed.evidenceId} -> live ${live.liveEvidenceId}, attachment ${seed.attachmentId} -> live ${live.liveAttachmentId} (evidence=${live.evCount} savedPsbts=${live.psbtCount})`,
    );

    // ── Phase 5: drive the REAL Settings restore dialog (MERGE mode) ───────
    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    const openBtn = page.getByTestId('button-open-restore');
    await openBtn.scrollIntoViewIfNeeded();
    await openBtn.click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'notarize-merge-restore-check-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipB64, 'base64'),
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('radio-merge').click();
    await page.getByTestId('button-continue-restore').click();
    await page.getByTestId('restore-preferences-preview').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('button-confirm-restore').click();
    await page
      .getByText('Restore Successful', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 120_000 });
    step('merge-mode restore completed via the Settings dialog', true);

    // ── Phase 6: assert de-dup kept the live rows and the PSBT was remapped ─
    const post = await page.evaluate(async ({ title, filename }) => {
      const evCrud = await import('/src/lib/data/evidence-crud.ts');
      const psbtCrud = await import('/src/lib/data/saved-psbts-crud.ts');
      const evidence = await evCrud.getAllEvidence();
      const fixtureDocs = evidence.filter((e) => e.title === title);
      const fixture = fixtureDocs[0];
      const atts = fixture?.id !== undefined
        ? await evCrud.getEvidenceAttachmentsByEvidenceId(fixture.id)
        : [];
      const fixtureAtts = atts.filter((a) => a.filename === filename);
      const rows = await psbtCrud.getAllSavedPsbts();
      const notarized = rows.find((r) => r.outputs?.some((o) => o.dataOutput));
      const dataOut = notarized?.outputs?.find((o) => o.dataOutput)?.dataOutput;
      return {
        evidenceCount: evidence.length,
        fixtureDocCount: fixtureDocs.length,
        fixtureAttachmentCount: fixtureAtts.length,
        survivingEvidenceId: fixture?.id,
        survivingAttachmentId: fixtureAtts[0]?.id,
        savedPsbtCount: rows.length,
        dataOutput: dataOut
          ? { evidenceId: dataOut.evidenceId, evidenceAttachmentId: dataOut.evidenceAttachmentId, payloadHex: dataOut.payloadHex }
          : null,
      };
    }, { title: EVIDENCE_TITLE, filename: EVIDENCE_FILE_NAME });

    step(
      'merge de-duped the backup document onto the pre-existing live row (no duplicate doc/attachment)',
      post.fixtureDocCount === 1 &&
        post.fixtureAttachmentCount === 1 &&
        post.survivingEvidenceId === live.liveEvidenceId &&
        post.survivingAttachmentId === live.liveAttachmentId,
      `docs=${post.fixtureDocCount} atts=${post.fixtureAttachmentCount} evidenceId=${post.survivingEvidenceId} (live ${live.liveEvidenceId}) attachmentId=${post.survivingAttachmentId} (live ${live.liveAttachmentId})`,
    );
    step(
      'restored saved-PSBT notarization output points at the SURVIVING live ids, not the backup ids',
      !!post.dataOutput &&
        post.dataOutput.evidenceId === live.liveEvidenceId &&
        post.dataOutput.evidenceAttachmentId === live.liveAttachmentId &&
        post.dataOutput.evidenceId !== seed.evidenceId &&
        post.dataOutput.evidenceAttachmentId !== seed.attachmentId &&
        post.dataOutput.payloadHex === EXPECTED_DIGEST,
      `dataOutput=${JSON.stringify(post.dataOutput)} savedPsbts=${post.savedPsbtCount} evidence=${post.evidenceCount}`,
    );

    // ── Phase 7: Evidence page — Notarized badge + successful Verify ───────
    await page.goto(`${BASE_URL}evidence`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    const card2 = page.getByTestId(`card-evidence-${live.liveEvidenceId}`);
    await card2.waitFor({ state: 'visible', timeout: 30_000 });
    await card2.click();
    await page.getByTestId('button-preview-edit').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('button-preview-edit').click();

    const badge = page.getByTestId(`badge-notarized-${live.liveAttachmentId}`);
    const badgeVisible = await badge
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    step('surviving live attachment shows the Notarized badge after the merge restore', badgeVisible);

    let verifyToast = false;
    if (badgeVisible) {
      await page.getByTestId(`button-verify-notarization-${live.liveAttachmentId}`).click();
      // Radix duplicates toast text into an aria-live region — match .first().
      verifyToast = await page
        .getByText('Notarization verified')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
    }
    step('Verify re-hashes the surviving live bytes and reports a match', verifyToast);

    // ════════════════════════════════════════════════════════════════════════
    // ROUND 2: the live copy of the duplicate document was RENAMED before the
    // merge. The evidence row still de-dupes by identity (title + documentType
    // + originalDate), but the filename map finds NO live attachment matching
    // the backup's filename — restoreSavedPsbtRows must DROP the attachment
    // reference (undefined), never leave the backup's stale numeric id
    // pointing at an unrelated live attachment. payloadHex + title/filename
    // hints must survive, and no Notarized badge may appear on any attachment.
    // ════════════════════════════════════════════════════════════════════════

    // ── Phase 8: wipe + recreate the SAME document with a RENAMED file ─────
    const renamed = await page.evaluate(
      async ({ title, docType, renamedFilename, content }) => {
        const evCrud = await import('/src/lib/data/evidence-crud.ts');
        const psbtCrud = await import('/src/lib/data/saved-psbts-crud.ts');
        const attachments = await import('/src/lib/attachments.ts');
        await evCrud.clearAllEvidenceData();
        await psbtCrud.clearSavedPsbts();
        // Decoys again so any dangling numeric id WOULD collide with an
        // unrelated live attachment if the drop path regressed.
        const decoyAttachmentIds = [];
        for (let i = 0; i < 3; i++) {
          const dId = await evCrud.addEvidence({
            title: `Decoy renamed-round doc ${i}`,
            documentType: 'other',
            tags: [],
          });
          const aId = await evCrud.addEvidenceAttachment({
            evidenceId: dId,
            filename: `renamed-round-decoy-${i}.bin`,
            mimeType: 'application/octet-stream',
            size: 3,
            objectStoragePath: `zz/notarize-merge-renamed-decoy-${i}.bin`,
          });
          decoyAttachmentIds.push(aId);
        }
        // Same document identity, but the file was RENAMED: the backup's
        // filename no longer exists under the surviving live document.
        const file = new File([content], renamedFilename, { type: 'text/plain' });
        const storagePath = await attachments.uploadFile(file);
        const liveEvidenceId = await evCrud.addEvidence({
          title,
          documentType: docType,
          tags: [],
        });
        const liveAttachmentId = await evCrud.addEvidenceAttachment({
          evidenceId: liveEvidenceId,
          filename: renamedFilename,
          mimeType: 'text/plain',
          size: content.length,
          objectStoragePath: storagePath,
        });
        const evCount = (await evCrud.getAllEvidence()).length;
        const psbtCount = (await psbtCrud.getAllSavedPsbts()).length;
        return { liveEvidenceId, liveAttachmentId, decoyAttachmentIds, evCount, psbtCount };
      },
      {
        title: EVIDENCE_TITLE,
        docType: EVIDENCE_DOC_TYPE,
        renamedFilename: EVIDENCE_RENAMED_FILE_NAME,
        content: EVIDENCE_FILE_CONTENT,
      },
    );
    step(
      'wiped + recreated the SAME document with a RENAMED attachment file',
      renamed.evCount === 4 && renamed.psbtCount === 0 && renamed.liveAttachmentId !== seed.attachmentId,
      `liveEvidenceId=${renamed.liveEvidenceId} liveAttachmentId=${renamed.liveAttachmentId} decoyAtts=${renamed.decoyAttachmentIds.join(',')}`,
    );

    // ── Phase 9: merge the SAME backup again via the Settings dialog ───────
    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    const openBtn2 = page.getByTestId('button-open-restore');
    await openBtn2.scrollIntoViewIfNeeded();
    await openBtn2.click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'notarize-merge-restore-check-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipB64, 'base64'),
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('radio-merge').click();
    await page.getByTestId('button-continue-restore').click();
    await page.getByTestId('restore-preferences-preview').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('button-confirm-restore').click();
    await page
      .getByText('Restore Successful', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 120_000 });
    step('renamed-file merge restore completed via the Settings dialog', true);

    // ── Phase 10: attachment reference DROPPED, hints + payload preserved ──
    const post2 = await page.evaluate(async ({ title, filename }) => {
      const evCrud = await import('/src/lib/data/evidence-crud.ts');
      const psbtCrud = await import('/src/lib/data/saved-psbts-crud.ts');
      const evidence = await evCrud.getAllEvidence();
      const fixtureDocs = evidence.filter((e) => e.title === title);
      const fixture = fixtureDocs[0];
      const atts = fixture?.id !== undefined
        ? await evCrud.getEvidenceAttachmentsByEvidenceId(fixture.id)
        : [];
      const allAtts = await evCrud.getAllEvidenceAttachments();
      const rows = await psbtCrud.getAllSavedPsbts();
      const notarized = rows.find((r) => r.outputs?.some((o) => o.dataOutput));
      const dataOut = notarized?.outputs?.find((o) => o.dataOutput)?.dataOutput;
      return {
        fixtureDocCount: fixtureDocs.length,
        survivingEvidenceId: fixture?.id,
        fixtureAttachmentFilenames: atts.map((a) => a.filename),
        allAttachmentIds: allAtts.map((a) => a.id),
        savedPsbtCount: rows.length,
        dataOutput: dataOut
          ? {
              evidenceId: dataOut.evidenceId,
              evidenceAttachmentId: dataOut.evidenceAttachmentId,
              payloadHex: dataOut.payloadHex,
              isNotarization: dataOut.isNotarization,
              evidenceTitle: dataOut.evidenceTitle,
              evidenceFilename: dataOut.evidenceFilename,
            }
          : null,
      };
    }, { title: EVIDENCE_TITLE, filename: EVIDENCE_FILE_NAME });

    step(
      'renamed-round merge still de-duped the document onto the surviving live row',
      post2.fixtureDocCount === 1 && post2.survivingEvidenceId === renamed.liveEvidenceId,
      `docs=${post2.fixtureDocCount} evidenceId=${post2.survivingEvidenceId} (live ${renamed.liveEvidenceId})`,
    );
    step(
      'restored notarization output DROPPED the attachment reference (no evidenceAttachmentId)',
      !!post2.dataOutput &&
        post2.dataOutput.evidenceAttachmentId === undefined &&
        post2.dataOutput.evidenceId === renamed.liveEvidenceId,
      `dataOutput=${JSON.stringify(post2.dataOutput)}`,
    );
    step(
      'dropped reference cannot dangle at any live attachment id',
      !!post2.dataOutput &&
        !post2.allAttachmentIds.includes(post2.dataOutput.evidenceAttachmentId),
      `attachmentIds=${post2.allAttachmentIds.join(',')} ref=${post2.dataOutput?.evidenceAttachmentId}`,
    );
    step(
      'payloadHex and title/filename hints survived the drop',
      !!post2.dataOutput &&
        post2.dataOutput.payloadHex === EXPECTED_DIGEST &&
        post2.dataOutput.isNotarization === true &&
        post2.dataOutput.evidenceTitle === EVIDENCE_TITLE &&
        post2.dataOutput.evidenceFilename === EVIDENCE_FILE_NAME,
      `dataOutput=${JSON.stringify(post2.dataOutput)}`,
    );

    // ── Phase 11: Evidence page shows NO Notarized badge on any attachment ─
    await page.goto(`${BASE_URL}evidence`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    const card3 = page.getByTestId(`card-evidence-${renamed.liveEvidenceId}`);
    await card3.waitFor({ state: 'visible', timeout: 30_000 });
    await card3.click();
    await page.getByTestId('button-preview-edit').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('button-preview-edit').click();
    // The renamed live attachment's row must be rendered (its Notarize button
    // exists) but carry NO Notarized badge — the reference was dropped, so
    // nothing links the saved PSBT to it.
    await page
      .getByTestId(`button-notarize-${renamed.liveAttachmentId}`)
      .waitFor({ state: 'visible', timeout: 15_000 });
    const badgeCount = await page.locator('[data-testid^="badge-notarized-"]').count();
    step(
      'Evidence page shows NO Notarized badge on the renamed (or any other) attachment',
      badgeCount === 0,
      `badges=${badgeCount}`,
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
  console.log(`\n[notarize-merge-restore-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.error('FAILED steps:', failed.map((s) => `${s.name} (${s.detail})`).join('; '));
    process.exit(1);
  }
  console.log('[notarize-merge-restore-browser] OK: notarized files stay verifiable after a MERGE restore onto an existing live document.');
}

main().catch((err) => {
  console.error('[notarize-merge-restore-browser] FATAL:', err.stack || err.message);
  process.exit(1);
});
