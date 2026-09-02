#!/usr/bin/env node
// Real-browser end-to-end guard: notarized evidence files stay VERIFIABLE
// across a full backup restore.
//
// The Node runtime tests (saved-psbts-roundtrip, v3-merge-restore) prove the
// evidence/attachment id remap contract inside saved-PSBT notarization
// outputs, but nothing exercised the whole journey in a real browser:
// notarize -> export unencrypted v3 zip (with the real attachment FILE) ->
// wipe -> restore via the ACTUAL Settings dialog (replace mode) -> Evidence
// page still shows the Notarized badge and Verify re-hashes the restored
// bytes and reports a match.
//
// Decoy evidence/attachment/saved-PSBT rows are seeded BEFORE the real
// fixture (so backup ids aren't 1) and again AFTER the wipe (advancing the
// IndexedDB autoincrement counters), so the restored rows are guaranteed to
// receive DIFFERENT ids than the backup carried — the Notarized badge can
// only survive if restoreEvidenceRows' id maps + remapEvidenceRefs really
// rewrote the saved-PSBT references.
//
// Flow, in headless Chromium against the dev server:
//   1. Fresh vault; seed decoy evidence docs + attachments, an owned BIP-84
//      address with two confirmed UTXOs, and the real evidence document with
//      a REAL uploaded attachment file.
//   2. Notarize via the Evidence page UI (WebCrypto SHA-256 -> UTXOs intent
//      banner -> Build PSBT with the OP_RETURN output -> Save).
//   3. Export an UNENCRYPTED v3 backup in-page (exportBackup + MemorySink,
//      same attachment IO the Export page wires up).
//   4. Wipe the evidence/attachment/saved-PSBT tables and insert fresh decoy
//      rows so the autoincrement counters move past the backup's ids.
//   5. Drive the real Settings restore dialog in REPLACE mode with the zip.
//   6. Assert the restored ids SHIFTED, the saved-PSBT notarization output
//      references the NEW live ids, and the Evidence page shows the
//      Notarized badge + a successful "Notarization verified" toast.
//
// Usage: node scripts/check-notarization-restore-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'notarize-restore-check-123';

// BIP-84 test-vector fixtures (same as check-psbt-builder-browser.mjs) so
// scriptPubKey reconstruction works in the browser.
const ADDR_W0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/84'/0'/0'/0/0
const ADDR_W1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'; // m/84'/0'/0'/0/1
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const MASTER_FINGERPRINT = '73c5da0a';
const DERIVATION_PATH = "m/84'/0'/0'/0/0";
const TX_A = 'ac'.repeat(32);
const TX_B = 'bd'.repeat(32);

const EVIDENCE_TITLE = 'Notarize-restore fixture';
const EVIDENCE_FILE_NAME = 'notarize-restore-me.txt';
const EVIDENCE_FILE_CONTENT = 'kyutxo notarization restore fixture file\n';
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
      console.log(`[notarize-restore-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[notarize-restore-browser] chromium: ${exe}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[notarize-restore-browser] starting dev server (npm run dev) ...');
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
    page.on('pageerror', (e) => console.log(`[notarize-restore-browser][page-error] ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[notarize-restore-browser][page-console] ${msg.text()}`);
    });

    // Retry the initial load: under parallel validation the first goto can
    // hit a still-warming Vite pipeline.
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
        loaded = true;
      } catch (err) {
        console.log(`[notarize-restore-browser] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });

    // ── Phase 1: seed decoys + UTXOs + the real evidence with a real file ──
    const seed = await page.evaluate(
      async ({ addr, txA, txB, zpub, fingerprint, derivationPath, title, filename, content }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const templateCrud = await import('/src/lib/data/derivation-templates-crud.ts');
        const evCrud = await import('/src/lib/data/evidence-crud.ts');
        const psbtCrud = await import('/src/lib/data/saved-psbts-crud.ts');
        const attachments = await import('/src/lib/attachments.ts');

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
            filename: `decoy-${i}.bin`,
            mimeType: 'application/octet-stream',
            size: 3,
            objectStoragePath: `zz/notarize-restore-decoy-${i}.bin`,
          });
          decoyIds.push(dId);
        }
        // A decoy saved PSBT row (no notarization) so savedPsbts ids shift too.
        await psbtCrud.savePsbt({
          name: 'Decoy saved PSBT',
          psbtBase64: 'cHNidP8BAAAA',
          destinationAddress: 'bc1qdecoy',
          feeRateSatsPerVb: 1,
          feeSats: 1,
          estimatedVbytes: 1,
          totalInputSats: 1,
          sendAmountSats: 1,
          changeSats: 0,
          inputs: [],
          outputs: [],
        });

        // Owned address with two confirmed outputs (real BIP-84 vector).
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'Notarize-restore check address',
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
          documentType: 'contract',
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

    // ── Phase 4: wipe the notarization tables + shift the id counters ──────
    // Clear evidence/attachments/saved PSBTs (the tables under test), then
    // insert fresh decoy rows: clear() does NOT reset IndexedDB autoincrement
    // key generation, and these decoys push the counters even further past
    // the backup's ids, so the replace restore MUST hand out different ids.
    const wiped = await page.evaluate(async () => {
      const evCrud = await import('/src/lib/data/evidence-crud.ts');
      const psbtCrud = await import('/src/lib/data/saved-psbts-crud.ts');
      await evCrud.clearAllEvidenceData();
      await psbtCrud.clearSavedPsbts();
      // Post-wipe decoys (the replace restore will clear these again, but
      // their ids advance the autoincrement counters first).
      for (let i = 0; i < 3; i++) {
        const dId = await evCrud.addEvidence({
          title: `Decoy post-wipe doc ${i}`,
          documentType: 'other',
          tags: [],
        });
        await evCrud.addEvidenceAttachment({
          evidenceId: dId,
          filename: `post-wipe-decoy-${i}.bin`,
          mimeType: 'application/octet-stream',
          size: 3,
          objectStoragePath: `zz/notarize-restore-postwipe-${i}.bin`,
        });
      }
      const evCount = (await evCrud.getAllEvidence()).length;
      const psbtCount = (await psbtCrud.getAllSavedPsbts()).length;
      return { evCount, psbtCount };
    });
    step(
      'vault wiped of notarization data; post-wipe decoys advance the id counters',
      wiped.evCount === 3 && wiped.psbtCount === 0,
      `evidence=${wiped.evCount} savedPsbts=${wiped.psbtCount}`,
    );

    // ── Phase 5: drive the REAL Settings restore dialog (REPLACE mode) ─────
    await page.goto(`${BASE_URL}settings`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    const openBtn = page.getByTestId('button-open-restore');
    await openBtn.scrollIntoViewIfNeeded();
    await openBtn.click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'notarize-restore-check-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipB64, 'base64'),
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('radio-replace').click();
    await page.getByTestId('button-continue-restore').click();
    await page.getByTestId('restore-preferences-preview').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('button-confirm-restore').click();
    await page
      .getByText('Restore Successful', { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 120_000 });
    step('replace-mode restore completed via the Settings dialog', true);

    // ── Phase 6: assert the ids SHIFTED and the saved PSBT was remapped ─────
    const post = await page.evaluate(async ({ title, filename }) => {
      const evCrud = await import('/src/lib/data/evidence-crud.ts');
      const psbtCrud = await import('/src/lib/data/saved-psbts-crud.ts');
      const evidence = await evCrud.getAllEvidence();
      const fixture = evidence.find((e) => e.title === title);
      const atts = fixture?.id !== undefined
        ? await evCrud.getEvidenceAttachmentsByEvidenceId(fixture.id)
        : [];
      const att = atts.find((a) => a.filename === filename);
      const rows = await psbtCrud.getAllSavedPsbts();
      const notarized = rows.find((r) => r.outputs?.some((o) => o.dataOutput));
      const dataOut = notarized?.outputs?.find((o) => o.dataOutput)?.dataOutput;
      return {
        evidenceCount: evidence.length,
        savedPsbtCount: rows.length,
        newEvidenceId: fixture?.id,
        newAttachmentId: att?.id,
        dataOutput: dataOut
          ? { evidenceId: dataOut.evidenceId, evidenceAttachmentId: dataOut.evidenceAttachmentId, payloadHex: dataOut.payloadHex }
          : null,
      };
    }, { title: EVIDENCE_TITLE, filename: EVIDENCE_FILE_NAME });

    step(
      'restore really shifted the evidence/attachment ids (decoys did their job)',
      typeof post.newEvidenceId === 'number' &&
        typeof post.newAttachmentId === 'number' &&
        post.newEvidenceId !== seed.evidenceId &&
        post.newAttachmentId !== seed.attachmentId,
      `evidence ${seed.evidenceId} -> ${post.newEvidenceId}, attachment ${seed.attachmentId} -> ${post.newAttachmentId}`,
    );
    step(
      'restored saved PSBT notarization output was remapped to the NEW live ids',
      !!post.dataOutput &&
        post.dataOutput.evidenceId === post.newEvidenceId &&
        post.dataOutput.evidenceAttachmentId === post.newAttachmentId &&
        post.dataOutput.payloadHex === EXPECTED_DIGEST,
      `dataOutput=${JSON.stringify(post.dataOutput)} savedPsbts=${post.savedPsbtCount} evidence=${post.evidenceCount}`,
    );

    // ── Phase 7: Evidence page — Notarized badge + successful Verify ───────
    await page.goto(`${BASE_URL}evidence`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000 });
    const card2 = page.getByTestId(`card-evidence-${post.newEvidenceId}`);
    await card2.waitFor({ state: 'visible', timeout: 30_000 });
    await card2.click();
    await page.getByTestId('button-preview-edit').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('button-preview-edit').click();

    const badge = page.getByTestId(`badge-notarized-${post.newAttachmentId}`);
    const badgeVisible = await badge
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    step('restored attachment shows the Notarized badge on the Evidence page', badgeVisible);

    let verifyToast = false;
    if (badgeVisible) {
      await page.getByTestId(`button-verify-notarization-${post.newAttachmentId}`).click();
      // Radix duplicates toast text into an aria-live region — match .first().
      verifyToast = await page
        .getByText('Notarization verified')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
    }
    step('Verify re-hashes the restored bytes and reports a match', verifyToast);

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
  console.log(`\n[notarize-restore-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.error('FAILED steps:', failed.map((s) => `${s.name} (${s.detail})`).join('; '));
    process.exit(1);
  }
  console.log('[notarize-restore-browser] OK: notarized files stay verifiable across a full backup restore.');
}

main().catch((err) => {
  console.error('[notarize-restore-browser] FATAL:', err.stack || err.message);
  process.exit(1);
});
