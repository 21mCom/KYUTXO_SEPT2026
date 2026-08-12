#!/usr/bin/env node
// Real-browser end-to-end guard: the Evidence -> UTXOs notarization HANDOFF.
//
// The jsdom page test (client/src/pages/UTXOs.notarizationBanner.test.tsx)
// locks the banner wiring (subscription -> banner, nonce-scoped dismiss, TTL
// expiry) but cannot exercise the true user journey: clicking "Notarize
// on-chain" on an Evidence attachment, hashing the REAL stored file bytes via
// WebCrypto, wouter-navigating to /utxos, seeing the intent banner with the
// right filename, and clearing the intent via dismiss OR via Build+Save PSBT
// (whose OP_RETURN output carries the digest).
//
// NOTE for reviewers: the banner lives on client/src/pages/UTXOs.tsx
// (data-testid="bar-notarization-intent"); the notarize action is
// handleNotarizeAttachment in client/src/pages/Evidence.tsx; the tab-scoped
// intent store is client/src/lib/evidence-notarization.ts (sessionStorage).
//
// Flow, in headless Chromium against the dev server:
//   1. Fresh vault; seed an owned BIP-84 address with two confirmed UTXOs and
//      an evidence document with a REAL uploaded attachment file (through the
//      app's own upload path, so notarize hashes real stored bytes).
//   2. Click "Notarize on-chain" in the Evidence edit dialog; assert the app
//      navigated itself to /utxos and shows the intent banner with the
//      attachment's filename.
//   3. DISMISS path: click "Cancel notarization"; banner disappears, the
//      stored intent is gone, and a full reload shows no banner.
//   4. Notarize AGAIN; SAVE path: select the two UTXOs, Build PSBT (the
//      builder shows the notarization panel), Save. The saved PSBT's
//      OP_RETURN data output carries the file's SHA-256 digest + evidence
//      references, the banner is cleared, and a reload shows no banner.
//
// Usage: node scripts/check-notarization-handoff-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'notarize-handoff-check-123';

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

const EVIDENCE_TITLE = 'Notarize-handoff fixture';
const EVIDENCE_FILE_NAME = 'notarize-handoff-me.txt';
const EVIDENCE_FILE_CONTENT = 'kyutxo notarization handoff fixture file\n';
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
      console.log(`[notarize-handoff-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
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
    .waitFor({ state: 'visible', timeout: 8_000 })
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

// Open the Evidence edit dialog for the fixture and click Notarize; the app
// hashes the stored bytes and navigates itself to /utxos.
async function notarizeViaEvidencePage(page, evidenceId, attachmentId) {
  await page.goto(`${BASE_URL}evidence`, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page);
  const card = page.getByTestId(`card-evidence-${evidenceId}`);
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.click();
  await page.getByTestId('button-preview-edit').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('button-preview-edit').click();
  const notarizeBtn = page.getByTestId(`button-notarize-${attachmentId}`);
  await notarizeBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await notarizeBtn.click();
}

// The tab-scoped stored intent, read through the app's own module.
async function peekStoredIntent(page) {
  return await page.evaluate(async () => {
    const lib = await import('/src/lib/evidence-notarization.ts');
    return lib.peekPendingNotarization();
  });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[notarize-handoff-browser] chromium: ${exe}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[notarize-handoff-browser] starting dev server (npm run dev) ...');
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
    page.on('pageerror', (e) => console.log(`[notarize-handoff-browser][page-error] ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[notarize-handoff-browser][page-console] ${msg.text()}`);
    });

    // Retry the initial load: under parallel validation the first goto can
    // hit a still-warming Vite pipeline.
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
      try {
        await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
        loaded = true;
      } catch (err) {
        console.log(`[notarize-handoff-browser] goto retry ${i + 1}: ${err.message}`);
        await page.waitForTimeout(3_000);
      }
    }
    if (!loaded) throw new Error('app never loaded');
    await unlockIfNeeded(page);

    // ── Phase 1: seed UTXOs + the evidence fixture with a REAL uploaded file ─
    const seed = await page.evaluate(
      async ({ addr, txA, txB, zpub, fingerprint, derivationPath, title, filename, content }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const templateCrud = await import('/src/lib/data/derivation-templates-crud.ts');
        const evCrud = await import('/src/lib/data/evidence-crud.ts');
        const attachments = await import('/src/lib/attachments.ts');

        // Owned address with two confirmed outputs (real BIP-84 vector).
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'Notarize-handoff check address',
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

        // Evidence document with a REAL uploaded attachment file (through the
        // app's own upload path), so the notarize click hashes stored bytes.
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
        return { evidenceId, attachmentId };
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
      'seeded UTXOs + evidence with a real uploaded attachment',
      typeof seed.evidenceId === 'number' && typeof seed.attachmentId === 'number',
      `evidenceId=${seed.evidenceId} attachmentId=${seed.attachmentId}`,
    );

    // ── Phase 2: notarize → app navigates to /utxos with the banner ─────────
    await notarizeViaEvidencePage(page, seed.evidenceId, seed.attachmentId);

    const intentBar = page.getByTestId('bar-notarization-intent');
    const bannerVisible = await intentBar
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const onUtxos = new URL(page.url()).pathname === '/utxos';
    const bannerText = bannerVisible ? await intentBar.innerText() : '';
    step(
      'Notarize click hashed the file and navigated to /utxos with the intent banner',
      bannerVisible && onUtxos,
      `path=${new URL(page.url()).pathname}`,
    );
    step(
      "banner names the attachment's filename",
      bannerText.includes(EVIDENCE_FILE_NAME),
      `banner="${bannerText.replace(/\s+/g, ' ').trim()}"`,
    );

    // The stored intent carries the REAL WebCrypto digest of the stored bytes.
    const intent = await peekStoredIntent(page);
    step(
      'stored intent carries the correct SHA-256 digest + evidence references',
      !!intent &&
        intent.payloadHex === EXPECTED_DIGEST &&
        intent.evidenceId === seed.evidenceId &&
        intent.evidenceAttachmentId === seed.attachmentId &&
        intent.evidenceFilename === EVIDENCE_FILE_NAME,
      `intent=${JSON.stringify(intent && { payloadHex: intent.payloadHex, evidenceId: intent.evidenceId, evidenceAttachmentId: intent.evidenceAttachmentId, evidenceFilename: intent.evidenceFilename })}`,
    );

    // ── Phase 3: DISMISS clears the intent; a reload shows no banner ────────
    await page.getByTestId('button-dismiss-notarization').click();
    await intentBar.waitFor({ state: 'detached', timeout: 15_000 });
    const intentAfterDismiss = await peekStoredIntent(page);
    step('Cancel notarization removed the banner and cleared the stored intent', intentAfterDismiss === null);

    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    // Wait for the page to actually render, then confirm no banner exists.
    await page.getByTestId(`row-address-${ADDR_W0.slice(0, 8)}`).waitFor({ state: 'visible', timeout: 30_000 });
    const bannerAfterDismissReload = await page.getByTestId('bar-notarization-intent').count();
    step('after dismiss, a full reload shows no banner', bannerAfterDismissReload === 0);

    // ── Phase 4: notarize AGAIN; Build PSBT + Save clears the intent ────────
    await notarizeViaEvidencePage(page, seed.evidenceId, seed.attachmentId);
    await intentBar.waitFor({ state: 'visible', timeout: 30_000 });
    step('second Notarize click raised the banner again', true);

    // Select the two UTXOs, build with the OP_RETURN output, save.
    const groupRow = page.getByTestId(`row-address-${ADDR_W0.slice(0, 8)}`);
    await groupRow.waitFor({ state: 'visible', timeout: 30_000 });
    await groupRow.click();
    await page.getByTestId(`checkbox-utxo-${TX_A}:0`).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId(`checkbox-utxo-${TX_A}:0`).click();
    await page.getByTestId(`checkbox-utxo-${TX_B}:1`).click();
    await page.getByTestId('button-build-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'visible', timeout: 15_000 });
    const builderPanelVisible = await page
      .getByTestId('panel-notarization-intent')
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    step('Build PSBT dialog shows the notarization panel', builderPanelVisible);
    await page.getByTestId('input-destination').fill(ADDR_W1);
    await page.getByTestId('panel-build-summary').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('button-save-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'detached', timeout: 15_000 });

    // Saving cleared the intent: banner gone now AND after a reload.
    const bannerGoneAfterSave = await intentBar
      .waitFor({ state: 'detached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const intentAfterSave = await peekStoredIntent(page);
    step('saving the PSBT removed the banner and cleared the stored intent', bannerGoneAfterSave && intentAfterSave === null);

    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    await page.getByTestId(`row-address-${ADDR_W0.slice(0, 8)}`).waitFor({ state: 'visible', timeout: 30_000 });
    const bannerAfterSaveReload = await page.getByTestId('bar-notarization-intent').count();
    step('after save, a full reload shows no banner', bannerAfterSaveReload === 0);

    // The saved PSBT's OP_RETURN data output carries the digest + references.
    const saved = await page.evaluate(async () => {
      const crud = await import('/src/lib/data/saved-psbts-crud.ts');
      const rows = await crud.getAllSavedPsbts();
      const row = rows.find((r) => r.outputs?.some((o) => o.dataOutput));
      const dataOut = row?.outputs?.find((o) => o.dataOutput)?.dataOutput;
      return {
        savedCount: rows.length,
        psbtBase64Present: typeof row?.psbtBase64 === 'string' && row.psbtBase64.length > 0,
        dataOutput: dataOut
          ? {
              isNotarization: dataOut.isNotarization,
              payloadHex: dataOut.payloadHex,
              evidenceId: dataOut.evidenceId,
              evidenceAttachmentId: dataOut.evidenceAttachmentId,
              evidenceFilename: dataOut.evidenceFilename,
            }
          : null,
      };
    });
    step(
      "saved PSBT's OP_RETURN output carries the file digest + evidence references",
      !!saved.dataOutput &&
        saved.dataOutput.isNotarization === true &&
        saved.dataOutput.payloadHex === EXPECTED_DIGEST &&
        saved.dataOutput.evidenceId === seed.evidenceId &&
        saved.dataOutput.evidenceAttachmentId === seed.attachmentId &&
        saved.psbtBase64Present,
      `savedCount=${saved.savedCount} dataOutput=${JSON.stringify(saved.dataOutput)}`,
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
  console.log(`\n[notarize-handoff-browser] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    console.error('FAILED steps:', failed.map((s) => `${s.name} (${s.detail})`).join('; '));
    process.exit(1);
  }
  console.log('[notarize-handoff-browser] OK: the Evidence -> UTXOs notarization handoff works end-to-end.');
}

main().catch((err) => {
  console.error('[notarize-handoff-browser] FATAL:', err.stack || err.message);
  process.exit(1);
});
