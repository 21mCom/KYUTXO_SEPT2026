#!/usr/bin/env node
// Real-browser end-to-end check for the Address Importer's "Use saved
// template" flow (client/src/pages/BulkImport.tsx +
// client/src/pages/bulk-import/SavedTemplatesDialog.tsx).
//
// Unit tests cover the dialog in isolation; this drives headless Chromium
// through the full flow:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds two derivation templates straight into Dexie via the live Vite
//      module singleton (same URL the app imported ⇒ same db instance):
//      - a WELL-FORMED zpub with gap limit 5 + metadata (owner/wallet/seed)
//      - a Coinomi-era MALFORMED zpub (depth-0 header w/ nonzero
//        fingerprint) with gap limit 3
//   3. Opens the Saved Templates dialog, applies the well-formed template,
//      asserts the xpub + gap limit (end index 4) + metadata landed, steps
//      to Preview and asserts 10 addresses derived (5 receive + 5 change)
//      with the known-good first receive address.
//   4. Walks back to step 1, applies the MALFORMED template, asserts the
//      non-standard-header note appears (lenient parse path), steps to
//      Preview and asserts 6 addresses derived with the SAME first receive
//      address (same key material, corrected derivation).
//
// Fixture keys are deterministic (seed = 32x 0x07, account m/84'/0'/0'),
// mirroring client/src/lib/xpub.lenient.test.ts and
// scripts/check-coinomi-xpub-browser.mjs.
//
// Usage: node scripts/check-saved-template-derive-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize against the other real-Chromium checks (they starve each other
// of CPU and fight over the port-5000 dev server when run in parallel).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'saved-template-check-123';

const WELLFORMED_ZPUB =
  'zpub6rxE7Tz5qUS41mjHBbWxDw6kZTdq9TbX2X6jn5291FBKSXbgQr752WFytoa7LQzvMDWMzevuHCE34zzF6zXo5AFCWijnpdVzV8khE5cgT1A';
const MALFORMED_ZPUB =
  'zpub6mJpY7S2CZR4STqt5d8fHXojAnu13HGAppiXeVQ8zS6c9nmFHzb3fTXBe5kb7bnXX8Cv5T3mW5br2aXKVvEutuwQGmG1jdcP1wkM54eMafM';
// Full expected derivation for the fixture key (chain 0 = receive, chain 1 =
// change, indices 0..4), computed independently with bitcoinjs-lib/bip32 from
// the zpub payload (P2WPKH, mainnet). BOTH headers (well-formed and
// Coinomi-era malformed) must derive exactly these addresses.
const EXPECTED_RECEIVE = [
  'bc1qvx4y0qycukdpmg0ftrz9zjt377ra8nfpgdqk9c',
  'bc1qjye6udldqh5vpc5c7pt5frcms8qxr298vs7gq7',
  'bc1q9p0mcg4ayrlc9r2zhndu5vj8gxgzuma596qkl9',
  'bc1qe8kvzae6shs5ksgnffwykc0mrfjwyduvgc0uq0',
  'bc1qxsq89vecngqjqxl7sd0k26ffc3a7qtxk6gcjlv',
];
const EXPECTED_CHANGE = [
  'bc1qzpl6npwa3cwke9sphzdqgct5uy0v0jaqpnumv5',
  'bc1qspt0rymcc5a5rmxztl0zu6qt6x4hg85fn5ejtm',
  'bc1ql9endau5e8q7sdnehdkun8acvskv3sxw7apa4x',
  'bc1qz9n66fezzzgpnghfuc7fypscdzn5gveflkue4k',
  'bc1q0xm90vs892xgr5wx8nluexa6zmp50jfptuajam',
];

const WELLFORMED_GAP = 5; // → end index 4, 10 addresses total
const MALFORMED_GAP = 3; // → end index 2, 6 addresses total
const TPL_OWNER = 'Template Owner';
const TPL_WALLET = 'Template Wallet';
const TPL_SEED = 'Template Seed';
const TPL_NOTES = 'well-formed template notes';

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

async function main() {
  const exe = resolveChromium();
  console.log(`[saved-template-derive-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[saved-template-derive-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[saved-template-derive-browser] starting dev server (npm run dev) ...`);
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
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name} :: ${detail}`);
  };

  try {
    // Fresh context => empty IndexedDB => setup form. Block the PWA service
    // worker so a stale cached bundle can't serve OLD code.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[saved-template-derive-browser][page-console] ${t}`);
      }
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });

    // ── Navigate to the Address Importer, re-unlock after full page load ──
    await page.goto(`${BASE_URL.replace(/\/$/, '')}/import`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    await unlockIfNeeded(page, SETUP_PASSWORD);

    const xpubInput = page.getByTestId('input-xpub');
    await xpubInput.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed two derivation templates via the live module singleton ───────
    // Same Vite URL the app imported ⇒ same Dexie db instance, so the dialog
    // (which reads on open) sees these rows without a reload.
    const seeded = await page.evaluate(
      async ({ wellformed, malformed, gaps, owner, wallet, seed, notes }) => {
        const crud = await import('/src/lib/data/derivation-templates-crud.ts');
        await crud.clearDerivationTemplates();
        const wellId = await crud.addDerivationTemplate({
          fingerprint: 'aaaaaaaa',
          scriptType: 'P2WPKH',
          derivationPath: "m/84'/0'/0'",
          xpub: wellformed,
          gapLimit: gaps.well,
          network: 'mainnet',
          owner,
          walletName: wallet,
          seedName: seed,
          notes: notes,
        });
        const malId = await crud.addDerivationTemplate({
          fingerprint: 'bbbbbbbb',
          scriptType: 'P2WPKH',
          derivationPath: "m/84'/0'/0'",
          xpub: malformed,
          gapLimit: gaps.mal,
          network: 'mainnet',
          walletName: 'Coinomi Legacy',
          notes: 'malformed-header template',
        });
        const count = await crud.countDerivationTemplates();
        return { wellId, malId, count };
      },
      {
        wellformed: WELLFORMED_ZPUB,
        malformed: MALFORMED_ZPUB,
        gaps: { well: WELLFORMED_GAP, mal: MALFORMED_GAP },
        owner: TPL_OWNER,
        wallet: TPL_WALLET,
        seed: TPL_SEED,
        notes: TPL_NOTES,
      },
    );
    record(
      'two derivation templates seeded into Dexie',
      seeded.count === 2 && seeded.wellId > 0 && seeded.malId > 0,
      `count=${seeded.count} ids=${seeded.wellId},${seeded.malId}`,
    );

    // ── Apply the WELL-FORMED template via the dialog ──────────────────────
    await page.getByTestId('button-open-saved-templates').click();
    const dialog = page.getByTestId('dialog-saved-templates');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    const wellRow = page.getByTestId(`template-row-${seeded.wellId}`);
    await wellRow.waitFor({ state: 'visible', timeout: 15_000 });
    const rowText = await wellRow.innerText();
    record(
      'dialog lists the seeded template with wallet name + gap limit badge',
      rowText.includes(TPL_WALLET) && rowText.includes(`Gap limit ${WELLFORMED_GAP}`),
      `row="${rowText.replace(/\s+/g, ' ').slice(0, 120)}"`,
    );
    await page.getByTestId(`button-use-template-${seeded.wellId}`).click();
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 });

    const toastShown = await page
      .getByText('Template Applied')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const xpubValue = (await xpubInput.inputValue()).trim();
    record(
      'applying the template pre-fills the xpub and shows the toast',
      toastShown && xpubValue === WELLFORMED_ZPUB,
      `toast=${toastShown} xpubMatches=${xpubValue === WELLFORMED_ZPUB}`,
    );

    // Key analysis (300ms debounce) must succeed before Next enables.
    await page.waitForTimeout(1200);
    await page.getByTestId('button-next-step1').click();

    // Step 2: the gap limit must have landed as end index 4 on BOTH chains.
    const advToggle = page.getByTestId('button-toggle-advanced');
    await advToggle.waitFor({ state: 'visible', timeout: 15_000 });
    await advToggle.click();
    const endReceiveVal = await page.getByTestId('input-end-index').inputValue();
    const endChangeVal = await page.getByTestId('input-change-end-index').inputValue();
    record(
      `template gap limit ${WELLFORMED_GAP} mapped to end index ${WELLFORMED_GAP - 1} on both chains`,
      endReceiveVal === String(WELLFORMED_GAP - 1) && endChangeVal === String(WELLFORMED_GAP - 1),
      `receiveEnd=${endReceiveVal} changeEnd=${endChangeVal}`,
    );

    // Metadata form: every field the template carries must be pre-filled
    // deterministically (owner + wallet name + seed name selects, notes).
    const ownerText = (await page.getByTestId('select-owner').innerText()).trim();
    const walletText = (await page.getByTestId('select-wallet-name').innerText()).trim();
    const seedText = (await page.getByTestId('select-seed').innerText()).trim();
    const notesValue = (await page.getByTestId('input-notes').inputValue()).trim();
    record(
      'template metadata (owner, wallet name, seed name, notes) pre-filled exactly',
      ownerText.includes(TPL_OWNER) &&
        walletText.includes(TPL_WALLET) &&
        seedText.includes(TPL_SEED) &&
        notesValue === TPL_NOTES,
      `owner="${ownerText}" wallet="${walletText}" seed="${seedText}" notesMatches=${notesValue === TPL_NOTES}`,
    );

    await page.getByTestId('button-next-step2').click();

    // Step 3: 5 receive + 5 change = 10 addresses; known first receive.
    const saveBtn = page.getByTestId('button-save-addresses');
    await saveBtn.waitFor({ state: 'visible', timeout: 60_000 });
    const saveLabel = (await saveBtn.innerText()).trim();
    record(
      `well-formed template derives ${WELLFORMED_GAP * 2} addresses (gap limit honored)`,
      new RegExp(`save\\s+${WELLFORMED_GAP * 2}\\s+addresses`, 'i').test(saveLabel),
      `saveButton="${saveLabel}"`,
    );
    // Change addresses are collapsed by default — expand before asserting.
    await page.getByTestId('toggle-change-addresses').click();
    await page.waitForTimeout(300);
    const previewBody = await page.locator('body').innerText();
    const wellExpected = [
      ...EXPECTED_RECEIVE.slice(0, WELLFORMED_GAP),
      ...EXPECTED_CHANGE.slice(0, WELLFORMED_GAP),
    ];
    const wellMissing = wellExpected.filter((a) => !previewBody.includes(a));
    record(
      `ALL ${wellExpected.length} expected receive+change addresses present in the preview`,
      wellMissing.length === 0,
      wellMissing.length === 0 ? 'every expected address found' : `missing: ${wellMissing.join(', ')}`,
    );

    // ── Back to step 1, apply the MALFORMED (Coinomi-era) template ─────────
    await page.getByTestId('button-back-step3').click();
    await page.getByTestId('button-back').click();
    await xpubInput.waitFor({ state: 'visible', timeout: 15_000 });

    await page.getByTestId('button-open-saved-templates').click();
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    const useMalformed = page.getByTestId(`button-use-template-${seeded.malId}`);
    await useMalformed.waitFor({ state: 'visible', timeout: 15_000 });
    await useMalformed.click();
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 });

    const malXpubValue = (await xpubInput.inputValue()).trim();
    record(
      'malformed-key template pre-fills its stored key',
      malXpubValue === MALFORMED_ZPUB,
      `xpubMatches=${malXpubValue === MALFORMED_ZPUB}`,
    );

    // Lenient parse path: non-standard-header note, no validation error.
    const note = page.getByTestId('text-nonstandard-header-note');
    const noteVisible = await note
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const invalidAlert = await page.getByText('Invalid Key').count().catch(() => 0);
    record(
      'Coinomi-era malformed key from the template is accepted (note shown, no error)',
      noteVisible && invalidAlert === 0,
      `noteVisible=${noteVisible} invalidKeyAlerts=${invalidAlert}`,
    );

    await page.getByTestId('button-next-step1').click();
    const nextStep2 = page.getByTestId('button-next-step2');
    await nextStep2.waitFor({ state: 'visible', timeout: 15_000 });
    await nextStep2.click();

    await saveBtn.waitFor({ state: 'visible', timeout: 60_000 });
    const malSaveLabel = (await saveBtn.innerText()).trim();
    record(
      `malformed template derives ${MALFORMED_GAP * 2} addresses (gap limit ${MALFORMED_GAP} honored)`,
      new RegExp(`save\\s+${MALFORMED_GAP * 2}\\s+addresses`, 'i').test(malSaveLabel),
      `saveButton="${malSaveLabel}"`,
    );
    // showChangeAddresses state persists across derivations — expand only if
    // the change list is currently collapsed.
    if (!(await page.locator('body').innerText()).includes(EXPECTED_CHANGE[0])) {
      await page.getByTestId('toggle-change-addresses').click();
      await page.waitForTimeout(300);
    }
    const malPreviewBody = await page.locator('body').innerText();
    const malExpected = [
      ...EXPECTED_RECEIVE.slice(0, MALFORMED_GAP),
      ...EXPECTED_CHANGE.slice(0, MALFORMED_GAP),
    ];
    const malMissing = malExpected.filter((a) => !malPreviewBody.includes(a));
    record(
      `malformed template derives ALL ${malExpected.length} expected addresses (lenient parse exact)`,
      malMissing.length === 0,
      malMissing.length === 0 ? 'every expected address found' : `missing: ${malMissing.join(', ')}`,
    );
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
  console.log(`[saved-template-derive-browser] ok=${ok}`);

  if (!ok) {
    console.error('\n[saved-template-derive-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[saved-template-derive-browser] PASSED: applying a saved derivation template pre-fills key/gap/metadata and derives the exact expected addresses end-to-end, including a Coinomi-era malformed key.',
  );
}

main().catch((err) => {
  console.error('[saved-template-derive-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
