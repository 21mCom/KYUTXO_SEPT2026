#!/usr/bin/env node
// Real-browser regression guard for record identifier canonicalization
// (Task: record identifiers stored trimmed/lowercased) and the non-blocking
// paste warnings in the record form.
//
// NOTE for reviewers: the "/" route renders client/src/pages/Dashboard.tsx
// (NOT Records.tsx) — its button-create-record opens the shared
// RecordFormDialog (client/src/components/RecordFormDialog.tsx), and its
// recordLookupMap/handleCheckDuplicate drive the duplicate check; the
// canonical write boundary is client/src/lib/data/record-crud.ts.
//
// jsdom suites cover the warning conditions and the CRUD canonicalization,
// but this repo has shipped jsdom-green browser-broken behavior before; this
// check proves the user-visible surface in real Chromium:
//   1. fresh vault on Dashboard ("/"), open the Create Record dialog
//   2. typing an UPPERCASE 64-hex string shows the non-blocking
//      "saved as a transaction ID" warning (alert-identifier-warning)
//   3. typing a mixed-case bech32 address shows the "saved in lowercase"
//      warning including the canonical (all-lowercase) form
//   4. saving a padded, ALL-UPPERCASE bech32 address stores the canonical
//      lowercase trimmed form, and lookups by any case variant find it
//   5. re-opening the dialog and entering the SAME address in a different
//      form (mixed case) hits the "This record already exists." duplicate
//      check; saving updates the existing record instead of creating a
//      second one
//
// Usage: node scripts/check-canonical-identifiers-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'canonical-id-check-123';

// A real P2WPKH address (BIP-173 test vector) in its canonical form plus the
// pasted variants under test.
const BECH32_CANONICAL = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BECH32_MIXED = 'bc1qW508D6qejXTDG4y5r3Zarvary0c5xw7KV8F3T4';
const BECH32_UPPER_PADDED = `  ${BECH32_CANONICAL.toUpperCase()}  `;
const HEX64_UPPER = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2';
const FIRST_LABEL = 'Canonical bech32 record';
const UPDATED_LABEL = 'Updated via duplicate path';

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

// Retry chromium.launch: under parallel validation load Chromium can fail
// with pthread_create EAGAIN; a short backoff usually recovers.
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
      console.log(`[canonical-identifiers-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function openCreateDialog(page) {
  const createBtn = page.getByTestId('button-create-record');
  await createBtn.waitFor({ state: 'visible', timeout: 30_000 });
  await createBtn.click();
  await page.getByTestId('input-address').waitFor({ state: 'visible', timeout: 15_000 });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[canonical-identifiers-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[canonical-identifiers-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[canonical-identifiers-browser] starting dev server (npm run dev) ...');
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

  try {
    // Fresh context => empty IndexedDB => the "Create Vault" setup form.
    // Block the PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[canonical-identifiers-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault on the Dashboard ("/") ────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'canonical-identifiers-browser' });
    steps.push({ name: 'vault created and app unlocked on Dashboard', passed: true, detail: 'setup form submitted' });

    // ── Open the Create Record dialog ───────────────────────────────────────
    await openCreateDialog(page);
    steps.push({ name: 'Create Record dialog opens from button-create-record', passed: true, detail: 'input-address visible' });

    const input = page.getByTestId('input-address');
    const warning = page.getByTestId('alert-identifier-warning');

    // ── Warning 1: uppercase 64-hex → "saved as a transaction ID" ──────────
    await input.fill(HEX64_UPPER);
    const hexWarnVisible = await warning
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const hexWarnText = hexWarnVisible ? (await warning.textContent()) ?? '' : '';
    steps.push({
      name: '64-hex paste shows the non-blocking "saved as a transaction ID" warning',
      passed: hexWarnVisible && hexWarnText.includes('This will be saved as a transaction ID.'),
      detail: `visible=${hexWarnVisible}, text=${JSON.stringify(hexWarnText.slice(0, 120))}`,
    });

    // The warning is non-blocking: the save button must remain enabled.
    const saveEnabledDuringHexWarn = await page.getByTestId('button-save').isEnabled().catch(() => false);
    steps.push({
      name: 'the 64-hex warning is non-blocking (Save stays enabled)',
      passed: saveEnabledDuringHexWarn,
      detail: `button-save enabled=${saveEnabledDuringHexWarn}`,
    });

    // ── Warning 2: mixed-case bech32 → "saved in lowercase" + canonical ────
    await input.fill(BECH32_MIXED);
    // The warning element re-renders synchronously with the new text.
    const mixedWarnVisible = await warning
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const mixedWarnText = mixedWarnVisible ? (await warning.textContent()) ?? '' : '';
    steps.push({
      name: 'mixed-case bech32 paste shows the "saved in lowercase" warning with the canonical form',
      passed:
        mixedWarnVisible &&
        mixedWarnText.includes('This address will be saved in lowercase.') &&
        mixedWarnText.includes(BECH32_CANONICAL),
      detail: `visible=${mixedWarnVisible}, text=${JSON.stringify(mixedWarnText.slice(0, 200))}`,
    });

    // ── Save a padded, ALL-UPPERCASE bech32 → canonical form stored ────────
    await input.fill(BECH32_UPPER_PADDED);
    await page.getByTestId('input-label').fill(FIRST_LABEL);
    await page.getByTestId('button-save').click();
    await page.getByTestId('input-address').waitFor({ state: 'detached', timeout: 30_000 });

    const stored = await page.evaluate(
      async ({ canonical, mixed, upperPadded }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const byCanonical = await recordCrud.getRecordsByInputString(canonical);
        const byMixed = await recordCrud.getRecordsByInputString(mixed);
        const byUpperPadded = await recordCrud.getRecordsByInputString(upperPadded);
        return {
          byCanonical: byCanonical.map((r) => ({ id: r.id, inputString: r.inputString, label: r.label })),
          byMixedCount: byMixed.length,
          byUpperPaddedCount: byUpperPadded.length,
        };
      },
      { canonical: BECH32_CANONICAL, mixed: BECH32_MIXED, upperPadded: BECH32_UPPER_PADDED },
    );
    steps.push({
      name: 'saving the padded UPPERCASE bech32 stored exactly one record in canonical (trimmed lowercase) form',
      passed:
        stored.byCanonical.length === 1 &&
        stored.byCanonical[0].inputString === BECH32_CANONICAL &&
        stored.byCanonical[0].label === FIRST_LABEL,
      detail: JSON.stringify(stored.byCanonical),
    });
    steps.push({
      name: 'exact-match lookups canonicalize their key (mixed-case and padded-uppercase variants find the record)',
      passed: stored.byMixedCount === 1 && stored.byUpperPaddedCount === 1,
      detail: `byMixed=${stored.byMixedCount}, byUpperPadded=${stored.byUpperPaddedCount}`,
    });

    // ── Duplicate check: same address in a different form ──────────────────
    // Reload once so the Dashboard's recordLookupMap is rebuilt from the
    // persisted vault, then enter the mixed-case variant.
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'canonical-identifiers-browser' });
    await openCreateDialog(page);

    await page.getByTestId('input-address').fill(BECH32_MIXED);
    const dupAlert = page.getByText('This record already exists.');
    const dupVisible = await dupAlert
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'entering the SAME address in mixed case hits the duplicate check',
      passed: dupVisible,
      detail: dupVisible ? 'duplicate alert visible' : 'duplicate alert never appeared',
    });

    // The duplicate check auto-populates the existing record's data.
    const prefillLabel = await page.getByTestId('input-label').inputValue().catch(() => null);
    steps.push({
      name: 'duplicate detection auto-fills the existing record (label prefilled)',
      passed: prefillLabel === FIRST_LABEL,
      detail: `input-label = ${JSON.stringify(prefillLabel)}`,
    });

    // Saving through the duplicate path must UPDATE, never create a second row.
    await page.getByTestId('input-label').fill(UPDATED_LABEL);
    await page.getByTestId('button-save').click();
    await page.getByTestId('input-address').waitFor({ state: 'detached', timeout: 30_000 });

    const afterDup = await page.evaluate(
      async ({ canonical }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const records = await recordCrud.getRecordsByInputString(canonical);
        return records.map((r) => ({ id: r.id, inputString: r.inputString, label: r.label }));
      },
      { canonical: BECH32_CANONICAL },
    );
    steps.push({
      name: 'saving via the duplicate path updated the existing record instead of creating a second one',
      passed:
        afterDup.length === 1 &&
        afterDup[0].inputString === BECH32_CANONICAL &&
        afterDup[0].label === UPDATED_LABEL,
      detail: JSON.stringify(afterDup),
    });

    // Belt-and-braces: the whole vault must contain exactly one record.
    const totalRecords = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      return db.records.count();
    });
    steps.push({
      name: 'the vault holds exactly one record after both save flows',
      passed: totalRecords === 1,
      detail: `db.records.count()=${totalRecords}`,
    });
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

  console.log(`[canonical-identifiers-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[canonical-identifiers-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[canonical-identifiers-browser] PASSED: paste warnings (64-hex → transaction ID, mixed-case bech32 → lowercase) render non-blocking, a padded UPPERCASE bech32 saves in canonical form, and re-entering the same address in a different case hits the duplicate check and updates instead of duplicating — end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[canonical-identifiers-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
