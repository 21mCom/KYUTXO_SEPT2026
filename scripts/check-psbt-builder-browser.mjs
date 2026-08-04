#!/usr/bin/env node
// Real-browser regression guard for the watch-only PSBT builder on the UTXOs
// page:
//   1. creates a fresh vault and seeds one owned address (a REAL BIP-84
//      test-vector address, so scriptPubKey reconstruction works) with two
//      confirmed outputs (100k + 60k sats),
//   2. expands the address group, selects both UTXOs via the checkboxes and
//      asserts the selection bar total,
//   3. opens the Build PSBT dialog, asserts the fresh change-address
//      suggestion pre-fills the expected BIP-84 change address (the record
//      carries the test-vector zpub + a derivation template, so zpub→xpub
//      conversion and bip32 derivation run in the browser), enters a
//      destination, and asserts the live fee math (2 P2WPKH inputs + 1 output
//      = 178 vB at 5 sats/vB = 890 sats),
//   3b. poisoning guard: a seeded record tagged "suspected-poisoning" must
//      surface the red warning banners (warning-poisoned-destination /
//      warning-poisoned-change) when its address is entered as destination
//      or (with send-max off) as change — in a REAL DOM under Trusted Types,
//      which the jsdom tests in BuildPsbtDialog.test.tsx cannot verify —
//      and the banners must clear once clean addresses are restored,
//   4. saves the PSBT, then opens Saved PSBTs and asserts the entry exists with
//      its decoded components and that the stored base64 round-trips through
//      bitcoinjs-lib IN THE BROWSER (this is what catches a Buffer-global
//      crash that vitest cannot),
//   5. reloads the page and asserts the saved PSBT persists,
//   6. notarization E2E: seeds an evidence document with a real uploaded
//      attachment, clicks "Notarize on-chain" on the Evidence page (SHA-256
//      via WebCrypto in the browser), lands on the UTXOs page with the
//      intent banner, builds + saves the PSBT with the OP_RETURN data
//      output, asserts the digest in Saved PSBTs (payload hex, copy-hash
//      button, notarization badge) and the exact OP_RETURN script bytes in
//      Node, then back on the Evidence page asserts the Notarized badge and
//      that "Verify" reports a match.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-psbt-builder-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'psbt-builder-check-123';

// BIP-84 test-vector addresses (valid mainnet P2WPKH), all from the standard
// "abandon … about" test-vector account below.
const ADDR_W0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/84'/0'/0'/0/0
const ADDR_W1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'; // m/84'/0'/0'/0/1
// BIP-84 test-vector account xpub (zpub form) + the expected fresh change
// address and receive-0 pubkey, matching client/src/lib/psbt-metadata.test.ts.
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const ADDR_CHANGE0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/84'/0'/0'/1/0
const ADDR_W0_PUBKEY = '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c';
const MASTER_FINGERPRINT = '73c5da0a';
const EXPECTED_DERIVATION_PATH = "m/84'/0'/0'/0/0";
// A lookalike address tagged "suspected-poisoning" — must NOT collide with
// the owned/destination/change addresses above.
const POISONED_ADDR = 'bc1qpsbtpoisonlookalike000000000000000xyz';
const POISON_TAG = 'suspected-poisoning';
const TX_A = 'aa'.repeat(32);
const TX_B = 'bb'.repeat(32);
const SATS_A = 100_000;
const SATS_B = 60_000;
// 2 P2WPKH inputs (68 vB) + 1 P2WPKH output (31) + 10.5 overhead = 178 vB.
const EXPECTED_FEE = 178 * 5;
// Notarization: the OP_RETURN data output adds 43 vB (8 amount + 1 scriptlen +
// 1 OP_RETURN + 1 push + 32-byte digest) -> 221 vB at 5 sats/vB.
const EXPECTED_NOTARIZATION_FEE = (178 + 43) * 5;
const EVIDENCE_FILE_NAME = 'notarize-me.txt';
const EVIDENCE_FILE_CONTENT = 'kyutxo notarization fixture file\n';
const EXPECTED_DIGEST = createHash('sha256').update(EVIDENCE_FILE_CONTENT, 'utf8').digest('hex');

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
  console.log('[psbt-builder-browser] legacy-migration overlay detected; waiting it out ...');
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
      console.log(`[psbt-builder-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function openSavedPsbts(page) {
  await page.getByTestId('button-saved-psbts').click();
  await page.getByTestId('dialog-saved-psbts').waitFor({ state: 'visible', timeout: 15_000 });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[psbt-builder-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[psbt-builder-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[psbt-builder-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  let bufferErrorSeen = false;

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('buffer is not defined')) bufferErrorSeen = true;
      if (msg.type() === 'error') {
        console.log(`[psbt-builder-browser][page-console] ${t}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true });

    // ── Seed one owned address with two confirmed outputs ───────────────────
    // The record carries the BIP-84 zpub + derivation path and a matching
    // derivation template, so the dialog exercises the real browser paths for
    // zpub→xpub conversion, bip32 derivation resolution, and the fresh
    // change-address suggestion.
    const seed = await page.evaluate(
      async ({ addr, txA, txB, satsA, satsB, zpub, fingerprint, derivationPath, poisonedAddr, poisonTag }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const templateCrud = await import('/src/lib/data/derivation-templates-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'PSBT builder check address',
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
        await txCrud.addParticipant({ txid: txA, role: 'output', address: addr, amount: satsA, vout: 0, recordId });
        await txCrud.addParticipant({ txid: txB, role: 'output', address: addr, amount: satsB, vout: 1, recordId });
        // Lookalike record tagged suspected-poisoning: the Build PSBT dialog
        // must banner-warn when this address is entered as destination/change.
        const poisonedRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: poisonedAddr,
          label: 'Suspected poisoning lookalike',
          tags: [poisonTag],
        });
        return { recordId, poisonedRecordId };
      },
      {
        addr: ADDR_W0,
        txA: TX_A,
        txB: TX_B,
        satsA: SATS_A,
        satsB: SATS_B,
        zpub: ZPUB,
        fingerprint: MASTER_FINGERPRINT,
        derivationPath: EXPECTED_DERIVATION_PATH,
        poisonedAddr: POISONED_ADDR,
        poisonTag: POISON_TAG,
      },
    );
    steps.push({
      name: 'seeded one owned address with two confirmed outputs + a suspected-poisoning record',
      passed:
        Number.isInteger(seed.recordId) &&
        seed.recordId > 0 &&
        Number.isInteger(seed.poisonedRecordId) &&
        seed.poisonedRecordId > 0,
      detail: `recordId=${seed.recordId} poisonedRecordId=${seed.poisonedRecordId}`,
    });

    // ── UTXOs page: expand the group and select both UTXOs ──────────────────
    await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const groupRow = page.getByTestId(`row-address-${ADDR_W0.slice(0, 8)}`);
    await groupRow.waitFor({ state: 'visible', timeout: 30_000 });
    await groupRow.click();

    const checkboxA = page.getByTestId(`checkbox-utxo-${TX_A}:0`);
    const checkboxB = page.getByTestId(`checkbox-utxo-${TX_B}:1`);
    await checkboxA.waitFor({ state: 'visible', timeout: 15_000 });
    await checkboxA.click();
    await checkboxB.click();

    const summary = page.getByTestId('text-selection-summary');
    await summary.waitFor({ state: 'visible', timeout: 10_000 });
    const summaryText = ((await summary.textContent()) ?? '').trim();
    steps.push({
      name: 'selection bar shows both UTXOs and the combined total',
      passed: summaryText.includes('2 UTXOs selected') && summaryText.includes('160,000 sats'),
      detail: `summary: "${summaryText}"`,
    });

    // ── Build dialog: live fee math for a send-max build ────────────────────
    await page.getByTestId('button-build-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('input-destination').waitFor({ state: 'visible', timeout: 15_000 });

    // The fresh change-address suggestion runs while the dialog prepares —
    // wait for the input to fill and assert the exact BIP-84 change address
    // (m/84'/0'/0'/1/0), proving zpub→xpub conversion + change-chain
    // derivation ran in the real browser.
    const changeInput = page.getByTestId('input-change-address');
    await changeInput.waitFor({ state: 'visible', timeout: 15_000 });
    let prefilled = '';
    const prefillDeadline = Date.now() + 20_000;
    while (Date.now() < prefillDeadline) {
      prefilled = (await changeInput.inputValue()) ?? '';
      if (prefilled) break;
      await page.waitForTimeout(250);
    }
    steps.push({
      name: 'dialog pre-fills the expected fresh change address (m/84\'/0\'/0\'/1/0)',
      passed: prefilled === ADDR_CHANGE0,
      detail: `change input: "${prefilled}"`,
    });

    // ── Poisoning banners: destination tagged suspected-poisoning ───────────
    // Enter the tagged lookalike as the destination and assert the red
    // warning banner renders in the real DOM (Radix + Trusted Types path the
    // jsdom tests cannot cover).
    const destInput = page.getByTestId('input-destination');
    await destInput.fill(POISONED_ADDR);
    const destBanner = page.getByTestId('warning-poisoned-destination');
    const destBannerVisible = await destBanner
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const destBannerText = destBannerVisible ? ((await destBanner.textContent()) ?? '').trim() : '';
    steps.push({
      name: 'destination poisoning warning banner renders for the tagged address',
      passed: destBannerVisible && destBannerText.toLowerCase().includes(POISON_TAG),
      detail: `visible=${destBannerVisible}, text="${destBannerText}"`,
    });

    // ── Poisoning banner: change address (only shown when send-max is off) ──
    await page.getByTestId('switch-send-max').click();
    const changeInputForPoison = page.getByTestId('input-change-address');
    const originalChange = (await changeInputForPoison.inputValue()) ?? '';
    await changeInputForPoison.fill(POISONED_ADDR);
    const changeBanner = page.getByTestId('warning-poisoned-change');
    const changeBannerVisible = await changeBanner
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const changeBannerText = changeBannerVisible
      ? ((await changeBanner.textContent()) ?? '').trim()
      : '';
    steps.push({
      name: 'change-address poisoning warning banner renders for the tagged address',
      passed: changeBannerVisible && changeBannerText.toLowerCase().includes(POISON_TAG),
      detail: `visible=${changeBannerVisible}, text="${changeBannerText}"`,
    });

    // Restore clean values and assert both banners clear.
    await changeInputForPoison.fill(originalChange);
    await destInput.fill(ADDR_W1);
    const destBannerGone = await destBanner
      .waitFor({ state: 'detached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const changeBannerGone = await changeBanner
      .waitFor({ state: 'detached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'poisoning banners clear once clean destination/change are restored',
      passed: destBannerGone && changeBannerGone,
      detail: `destination cleared=${destBannerGone}, change cleared=${changeBannerGone}`,
    });
    // Back to send-max on for the original fee-math flow; clear the
    // destination so the later fill starts from the untouched state.
    await page.getByTestId('switch-send-max').click();
    await destInput.fill('');

    // Toggle send-max off: the "fresh unused change address" hint must appear
    // (it only renders when the pre-fill matches the suggestion), then back on
    // to keep the original send-max fee-math flow.
    await page.getByTestId('switch-send-max').click();
    const hintVisible = await page
      .getByTestId('text-change-suggestion')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'fresh-change suggestion hint shows when send-max is off',
      passed: hintVisible,
      detail: hintVisible ? 'hint visible' : 'hint missing',
    });
    await page.getByTestId('switch-send-max').click();

    await page.getByTestId('input-destination').fill(ADDR_W1);

    const summaryPanel = page.getByTestId('panel-build-summary');
    await summaryPanel.waitFor({ state: 'visible', timeout: 15_000 });
    const feeText = ((await page.getByTestId('text-fee').textContent()) ?? '').trim();
    const sendText = ((await page.getByTestId('text-send-amount').textContent()) ?? '').trim();
    steps.push({
      name: `live fee math shows ${EXPECTED_FEE.toLocaleString()} sats at 5 sats/vB`,
      passed: feeText === `${EXPECTED_FEE.toLocaleString()} sats` && sendText === `${(160_000 - EXPECTED_FEE).toLocaleString()} sats`,
      detail: `fee: "${feeText}", send: "${sendText}"`,
    });

    // ── Save, then inspect in Saved PSBTs ───────────────────────────────────
    await page.getByTestId('button-save-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'detached', timeout: 15_000 });

    await openSavedPsbts(page);
    const savedRows = page.locator('[data-testid^="row-saved-psbt-"]');
    const savedCount = await savedRows.count();
    steps.push({
      name: 'saved PSBT appears in the Saved PSBTs list',
      passed: savedCount === 1,
      detail: `rows: ${savedCount}`,
    });

    await savedRows.first().click();
    const inputRows = page.locator('[data-testid^="row-psbt-input-"]');
    await inputRows.first().waitFor({ state: 'visible', timeout: 10_000 });
    const inputCount = await inputRows.count();
    steps.push({
      name: 'detail view lists both decoded inputs',
      passed: inputCount === 2,
      detail: `input rows: ${inputCount}`,
    });

    // Round-trip the stored base64 through the app's own decoder IN THE
    // BROWSER (bare package specifiers don't resolve inside page.evaluate,
    // so go through the Vite-served app module).
    const roundTrip = await page.evaluate(async () => {
      const crud = await import('/src/lib/data/saved-psbts-crud.ts');
      const psbtLib = await import('/src/lib/psbt.ts');
      const rows = await crud.getAllSavedPsbts();
      if (rows.length !== 1) return { ok: false, detail: `saved rows: ${rows.length}` };
      try {
        const s = psbtLib.decodePsbtSummary(rows[0].psbtBase64);
        return {
          ok: s.inputCount === 2 && s.outputCount === 1 && s.allInputsHaveWitnessUtxo && !s.hasSignatures,
          detail: `inputs=${s.inputCount} outputs=${s.outputCount} witnessUtxo=${s.allInputsHaveWitnessUtxo} sigs=${s.hasSignatures}`,
          psbtBase64: rows[0].psbtBase64,
          savedInputs: rows[0].inputs?.map((i) => ({
            hasDerivationInfo: i.hasDerivationInfo,
            derivationPath: i.derivationPath,
          })),
        };
      } catch (err) {
        return { ok: false, detail: `decode threw: ${err.message}` };
      }
    });
    steps.push({
      name: 'stored PSBT base64 round-trips through bitcoinjs-lib in the browser',
      passed: roundTrip.ok,
      detail: roundTrip.detail,
    });

    // The browser produced the base64 (so the derivation code ran there);
    // verify in Node that every input carries the exact bip32Derivation the
    // template + zpub imply.
    let derivationOk = false;
    let derivationDetail = 'no psbtBase64 returned';
    if (roundTrip.psbtBase64) {
      try {
        const bitcoin = await import('bitcoinjs-lib');
        const psbt = bitcoin.Psbt.fromBase64(roundTrip.psbtBase64, {
          network: bitcoin.networks.bitcoin,
        });
        const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
        const checks = psbt.data.inputs.map((input) => {
          const d = input.bip32Derivation?.[0];
          if (!d) return 'missing bip32Derivation';
          const pub = toHex(d.pubkey);
          const fp = toHex(d.masterFingerprint);
          if (pub !== ADDR_W0_PUBKEY) return `pubkey=${pub}`;
          if (fp !== MASTER_FINGERPRINT) return `fingerprint=${fp}`;
          if (d.path !== EXPECTED_DERIVATION_PATH) return `path=${d.path}`;
          return 'ok';
        });
        derivationOk =
          psbt.data.inputs.length === 2 &&
          checks.every((c) => c === 'ok') &&
          Array.isArray(roundTrip.savedInputs) &&
          roundTrip.savedInputs.length === 2 &&
          roundTrip.savedInputs.every(
            (i) => i.hasDerivationInfo && i.derivationPath === EXPECTED_DERIVATION_PATH,
          );
        derivationDetail = `inputs=${psbt.data.inputs.length} checks=[${checks.join(', ')}] savedInputs=${JSON.stringify(roundTrip.savedInputs)}`;
      } catch (err) {
        derivationDetail = `parse threw: ${err.message}`;
      }
    }
    steps.push({
      name: 'both PSBT inputs carry bip32Derivation with the right pubkey/fingerprint/path',
      passed: derivationOk,
      detail: derivationDetail,
    });

    await page.keyboard.press('Escape');

    // ── Persistence across reload ────────────────────────────────────────────
    await page.reload({ waitUntil: 'load' });
    await unlockIfNeeded(page);
    await page.getByTestId('button-saved-psbts').waitFor({ state: 'visible', timeout: 30_000 });
    await openSavedPsbts(page);
    const afterReloadCount = await page.locator('[data-testid^="row-saved-psbt-"]').count();
    steps.push({
      name: 'saved PSBT persists across a page reload',
      passed: afterReloadCount === 1,
      detail: `rows after reload: ${afterReloadCount}`,
    });

    // ── Notarization E2E: Evidence page -> UTXOs -> build -> save -> verify ─
    // Seed an evidence document with a REAL uploaded attachment through the
    // app's own upload path (server endpoint in web mode).
    const evSeed = await page.evaluate(
      async ({ filename, content }) => {
        const evCrud = await import('/src/lib/data/evidence-crud.ts');
        const attachments = await import('/src/lib/attachments.ts');
        const file = new File([content], filename, { type: 'text/plain' });
        const storagePath = await attachments.uploadFile(file);
        const evidenceId = await evCrud.addEvidence({
          title: 'Notarization fixture',
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
      { filename: EVIDENCE_FILE_NAME, content: EVIDENCE_FILE_CONTENT },
    );
    steps.push({
      name: 'seeded an evidence document with a real uploaded attachment',
      passed: evSeed.evidenceId > 0 && evSeed.attachmentId > 0,
      detail: `evidenceId=${evSeed.evidenceId} attachmentId=${evSeed.attachmentId}`,
    });

    // Evidence page: open the document (card -> preview -> Edit opens the
    // detail dialog) and click "Notarize on-chain" on the attachment. The
    // click hashes the bytes via WebCrypto and navigates to the UTXOs page.
    await page.goto(`${BASE_URL}evidence`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    const card = page.getByTestId(`card-evidence-${evSeed.evidenceId}`);
    await card.waitFor({ state: 'visible', timeout: 30_000 });
    await card.click();
    await page.getByTestId('button-preview-edit').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('button-preview-edit').click();
    const notarizeBtn = page.getByTestId(`button-notarize-${evSeed.attachmentId}`);
    await notarizeBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await notarizeBtn.click();

    // Landing on the UTXOs page with the intent banner proves the digest was
    // computed and the handoff happened.
    const intentBar = page.getByTestId('bar-notarization-intent');
    const intentVisible = await intentBar
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const intentText = intentVisible ? ((await intentBar.textContent()) ?? '') : '';
    steps.push({
      name: 'Notarize click hashes the file and lands on UTXOs with the intent banner',
      passed: intentVisible && intentText.includes(EVIDENCE_FILE_NAME),
      detail: `visible=${intentVisible} text="${intentText.trim().slice(0, 120)}"`,
    });

    // Select the two UTXOs again and open the build dialog.
    const groupRow2 = page.getByTestId(`row-address-${ADDR_W0.slice(0, 8)}`);
    await groupRow2.waitFor({ state: 'visible', timeout: 30_000 });
    await groupRow2.click();
    await page.getByTestId(`checkbox-utxo-${TX_A}:0`).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId(`checkbox-utxo-${TX_A}:0`).click();
    await page.getByTestId(`checkbox-utxo-${TX_B}:1`).click();
    await page.getByTestId('button-build-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'visible', timeout: 15_000 });

    // The dialog carries the notarization intent and the exact browser-computed digest.
    const dialogIntent = page.getByTestId('panel-notarization-intent');
    await dialogIntent.waitFor({ state: 'visible', timeout: 20_000 });
    const hashText = ((await page.getByTestId('text-notarization-hash').textContent()) ?? '').trim();
    steps.push({
      name: 'build dialog shows the browser-computed SHA-256 digest',
      passed: hashText === EXPECTED_DIGEST,
      detail: `dialog hash: "${hashText}" expected: "${EXPECTED_DIGEST}"`,
    });

    // Fee math accounts for the OP_RETURN output: 221 vB at 5 sats/vB.
    await page.getByTestId('input-destination').fill(ADDR_W1);
    await page.getByTestId('panel-build-summary').waitFor({ state: 'visible', timeout: 15_000 });
    const nFeeText = ((await page.getByTestId('text-fee').textContent()) ?? '').trim();
    const dataOutText = ((await page.getByTestId('text-data-output').textContent()) ?? '').trim();
    steps.push({
      name: `fee math includes the OP_RETURN output (${EXPECTED_NOTARIZATION_FEE.toLocaleString()} sats)`,
      passed:
        nFeeText === `${EXPECTED_NOTARIZATION_FEE.toLocaleString()} sats` &&
        dataOutText.includes('0 sats'),
      detail: `fee: "${nFeeText}", data output: "${dataOutText}"`,
    });

    // Save; the intent banner on the UTXOs page clears via onSaved.
    await page.getByTestId('button-save-psbt').click();
    await page.getByTestId('dialog-build-psbt').waitFor({ state: 'detached', timeout: 15_000 });
    const intentGone = await intentBar
      .waitFor({ state: 'detached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'saving the notarization PSBT clears the intent banner',
      passed: intentGone,
      detail: `banner detached=${intentGone}`,
    });

    // Saved PSBTs: the notarization row shows the badge and the exact payload.
    await openSavedPsbts(page);
    const nBadge = page.locator('[data-testid^="badge-notarization-"]').first();
    await nBadge.waitFor({ state: 'visible', timeout: 15_000 });
    const nPsbtId = (await nBadge.getAttribute('data-testid')).replace('badge-notarization-', '');
    await page.getByTestId(`row-saved-psbt-${nPsbtId}`).click();
    const payloadEl = page.getByTestId(`text-data-payload-${nPsbtId}-1`);
    await payloadEl.waitFor({ state: 'visible', timeout: 10_000 });
    const payloadText = ((await payloadEl.textContent()) ?? '').trim();
    const copyHashVisible = await page
      .getByTestId(`button-copy-hash-${nPsbtId}-1`)
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'Saved PSBTs shows the notarization badge, exact payload, and copy-hash action',
      passed: payloadText === EXPECTED_DIGEST && copyHashVisible,
      detail: `payload: "${payloadText}" copyHash=${copyHashVisible}`,
    });

    // The saved row records the evidence reference, and the OP_RETURN script
    // bytes are exactly 6a 20 <digest> with a zero value (checked in Node).
    const nRoundTrip = await page.evaluate(async (psbtId) => {
      const crud = await import('/src/lib/data/saved-psbts-crud.ts');
      const rows = await crud.getAllSavedPsbts();
      const row = rows.find((r) => String(r.id) === String(psbtId));
      if (!row) return { ok: false, detail: 'row not found' };
      const dataOut = row.outputs?.find((o) => o.dataOutput);
      return {
        ok: !!dataOut,
        detail: dataOut ? 'found' : 'no data output on the saved row',
        psbtBase64: row.psbtBase64,
        dataOutput: dataOut?.dataOutput,
      };
    }, nPsbtId);
    let scriptOk = false;
    let scriptDetail = nRoundTrip.detail;
    if (nRoundTrip.ok && nRoundTrip.psbtBase64) {
      try {
        const bitcoin = await import('bitcoinjs-lib');
        const psbt = bitcoin.Psbt.fromBase64(nRoundTrip.psbtBase64, {
          network: bitcoin.networks.bitcoin,
        });
        const out1 = psbt.txOutputs[1];
        const scriptHex = Array.from(out1.script, (b) => b.toString(16).padStart(2, '0')).join('');
        scriptOk =
          psbt.txOutputs.length === 2 &&
          out1.value === BigInt(0) &&
          scriptHex === `6a20${EXPECTED_DIGEST}` &&
          nRoundTrip.dataOutput?.isNotarization === true &&
          nRoundTrip.dataOutput?.evidenceAttachmentId === evSeed.attachmentId &&
          nRoundTrip.dataOutput?.payloadHex === EXPECTED_DIGEST;
        scriptDetail = `outputs=${psbt.txOutputs.length} value=${out1.value} script=${scriptHex.slice(0, 20)}… dataOutput=${JSON.stringify(nRoundTrip.dataOutput)}`;
      } catch (err) {
        scriptDetail = `parse threw: ${err.message}`;
      }
    }
    steps.push({
      name: 'saved PSBT carries the exact OP_RETURN script bytes and the evidence reference',
      passed: scriptOk,
      detail: scriptDetail,
    });
    await page.keyboard.press('Escape');

    // Back on the Evidence page: the attachment shows Notarized and Verify
    // re-hashes the bytes and reports a match.
    await page.goto(`${BASE_URL}evidence`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    const card2 = page.getByTestId(`card-evidence-${evSeed.evidenceId}`);
    await card2.waitFor({ state: 'visible', timeout: 30_000 });
    await card2.click();
    await page.getByTestId('button-preview-edit').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('button-preview-edit').click();
    const notarizedBadge = page.getByTestId(`badge-notarized-${evSeed.attachmentId}`);
    const notarizedVisible = await notarizedBadge
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'notarized attachment shows the Notarized badge on the Evidence page',
      passed: notarizedVisible,
      detail: `visible=${notarizedVisible}`,
    });

    await page.getByTestId(`button-verify-notarization-${evSeed.attachmentId}`).click();
    // Radix duplicates toast text into an aria-live region — match .first().
    const verifyToast = await page
      .getByText('Notarization verified')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'Verify re-hashes the current bytes and reports a match',
      passed: verifyToast,
      detail: `toast visible=${verifyToast}`,
    });

    steps.push({
      name: 'no "Buffer is not defined" page error at any point',
      passed: !bufferErrorSeen,
      detail: bufferErrorSeen ? 'Buffer global referenced in the browser bundle' : 'clean',
    });
  } finally {
    await browser.close().catch(() => {});
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
  console.log(`[psbt-builder-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name}${step.detail ? ` :: ${step.detail}` : ''}`);
  }

  if (!ok) {
    console.error('\n[psbt-builder-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail ?? ''}`);
    }
    process.exit(1);
  }

  console.log('[psbt-builder-browser] PASSED: select UTXOs -> build -> save -> inspect -> reload all work in a real browser.');
}

main().catch((err) => {
  console.error('[psbt-builder-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
