#!/usr/bin/env node
// Real-browser end-to-end check for Coinomi-era malformed xpub imports.
//
// Old Coinomi exports carry a malformed BIP32 header: depth byte 0 while the
// parent-fingerprint / child-number fields are nonzero. Strict bip32 parsing
// rejects these keys; the Address Importer now falls back to a lenient parse
// (client/src/lib/xpub.ts fromBase58Lenient) and shows an informational note
// (testid: text-nonstandard-header-note) that the key was treated as
// account-level. Unit tests cover the derivation math
// (client/src/lib/xpub.lenient.test.ts); this drives a headless Chromium
// through the full UI flow:
//   1. Creates a fresh vault via the setup form.
//   2. Navigates to /import, pastes a WELL-FORMED zpub (same key material,
//      corrected depth-3 header) and asserts the note does NOT appear.
//   3. Pastes the synthetic MALFORMED zpub and asserts:
//      - no validation error is shown
//      - the "non-standard header" note appears
//   4. Continues through the wizard (small index range), derives addresses,
//      asserts the first receive address matches the known-good derivation,
//      and saves; asserts the "Import Complete" toast fires.
//
// Fixture keys are deterministic (seed = 32x 0x07, account m/84'/0'/0'),
// mirroring client/src/lib/xpub.lenient.test.ts.
//
// Usage: node scripts/check-coinomi-xpub-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'coinomi-xpub-check-123';

// Same key material; malformed = depth 0 + nonzero fingerprint/index,
// wellformed = corrected depth-3 header. Generated from seed 32x0x07 at
// m/84'/0'/0' (see xpub.lenient.test.ts encodeExtendedKey).
const MALFORMED_ZPUB =
  'zpub6mJpY7S2CZR4STqt5d8fHXojAnu13HGAppiXeVQ8zS6c9nmFHzb3fTXBe5kb7bnXX8Cv5T3mW5br2aXKVvEutuwQGmG1jdcP1wkM54eMafM';
const WELLFORMED_ZPUB =
  'zpub6rxE7Tz5qUS41mjHBbWxDw6kZTdq9TbX2X6jn5291FBKSXbgQr752WFytoa7LQzvMDWMzevuHCE34zzF6zXo5AFCWijnpdVzV8khE5cgT1A';
// First receive address (chain 0, index 0) both headers must derive.
const EXPECTED_FIRST_RECEIVE = 'bc1qvx4y0qycukdpmg0ftrz9zjt377ra8nfpgdqk9c';

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
  console.log(`[coinomi-xpub-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[coinomi-xpub-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[coinomi-xpub-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[coinomi-xpub-browser] dev server ready at ${BASE_URL}`);
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
        console.log(`[coinomi-xpub-browser][page-console] ${t}`);
      }
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // Best-effort: dismiss the legacy-migration overlay if it appears after
    // unlock, otherwise it swallows clicks / covers the page.
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    // ── Address Importer ────────────────────────────────────────────────────
    // Full page navigation drops the in-memory session key and re-locks the
    // vault, so unlock again on /import before looking for the importer.
    await page.goto(`${BASE_URL.replace(/\/$/, '')}/import`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    const relockPw = page.getByTestId('input-password');
    const relocked = await relockPw
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (relocked) {
      await relockPw.fill(SETUP_PASSWORD);
      await page.getByTestId('button-submit').click();
    }
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    const xpubInput = page.getByTestId('input-xpub');
    await xpubInput.waitFor({ state: 'visible', timeout: 30_000 });

    const note = page.getByTestId('text-nonstandard-header-note');

    // 1. Well-formed key: analysis succeeds, NO non-standard-header note.
    await xpubInput.fill(WELLFORMED_ZPUB);
    await page
      .getByTestId('button-next-step1')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    // Wait past the 300ms analysis debounce, then check the note stayed away.
    await page.waitForTimeout(1200);
    const wellformedNoteCount = await note.count();
    const wellformedDetected = await page
      .getByText('Key Detected')
      .count()
      .catch(() => 0);
    record(
      'well-formed key is analyzed with NO non-standard-header note',
      wellformedNoteCount === 0 && wellformedDetected > 0,
      `noteCount=${wellformedNoteCount} keyDetected=${wellformedDetected}`,
    );

    // 2. Malformed key: no validation error + note appears.
    await xpubInput.fill('');
    await page.waitForTimeout(600);
    await xpubInput.fill(MALFORMED_ZPUB);
    let noteVisible = true;
    try {
      await note.waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      noteVisible = false;
    }
    const noteText = noteVisible ? (await note.innerText()).trim() : '';
    record(
      'malformed (Coinomi-era) key shows the non-standard-header note',
      noteVisible && /non-standard header/i.test(noteText),
      noteVisible ? `note="${noteText.slice(0, 90)}..."` : 'note never appeared',
    );
    const invalidAlert = await page.getByText('Invalid Key').count().catch(() => 0);
    record(
      'malformed key does NOT show a validation error',
      invalidAlert === 0,
      `invalidKeyAlerts=${invalidAlert}`,
    );

    // ── Continue the wizard ────────────────────────────────────────────────
    await page.getByTestId('button-next-step1').click();

    // Step 2: shrink the derivation range so it's fast (0..4 both chains).
    // The index inputs live inside the Advanced Settings collapsible.
    const advToggle = page.getByTestId('button-toggle-advanced');
    await advToggle.waitFor({ state: 'visible', timeout: 15_000 });
    await advToggle.click();
    const endReceive = page.getByTestId('input-end-index');
    await endReceive.waitFor({ state: 'visible', timeout: 15_000 });
    await endReceive.fill('4');
    await page.getByTestId('input-change-end-index').fill('4');
    await page.getByTestId('button-next-step2').click();

    // Step 3: addresses derive; the save button shows the selected count.
    const saveBtn = page.getByTestId('button-save-addresses');
    await saveBtn.waitFor({ state: 'visible', timeout: 60_000 });
    const saveLabel = (await saveBtn.innerText()).trim();
    record(
      'addresses derived from the malformed key (save button enabled with a count)',
      /save\s+10\s+addresses/i.test(saveLabel) && (await saveBtn.isEnabled()),
      `saveButton="${saveLabel}"`,
    );

    const pageBody = await page.locator('body').innerText();
    record(
      'first receive address matches the corrected-header derivation',
      pageBody.includes(EXPECTED_FIRST_RECEIVE),
      `expected ${EXPECTED_FIRST_RECEIVE} ${pageBody.includes(EXPECTED_FIRST_RECEIVE) ? 'found' : 'NOT found'} in preview`,
    );

    // Save and confirm the import completes.
    await saveBtn.click();
    let importComplete = true;
    try {
      await page
        .getByText('Import Complete')
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 });
    } catch {
      importComplete = false;
    }
    record(
      'import saves successfully ("Import Complete" toast)',
      importComplete,
      importComplete ? 'toast shown' : 'toast never appeared',
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
  console.log(`[coinomi-xpub-browser] ok=${ok}`);

  if (!ok) {
    console.error('\n[coinomi-xpub-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[coinomi-xpub-browser] PASSED: a Coinomi-era malformed zpub imports end-to-end in a real browser (note shown, addresses derived + saved; well-formed key shows no note).',
  );
}

main().catch((err) => {
  console.error('[coinomi-xpub-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
