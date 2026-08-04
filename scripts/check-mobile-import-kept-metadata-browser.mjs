#!/usr/bin/env node
// Real-browser regression guard for the Mobile Wallet Import kept-metadata
// notice: when an imported address already exists in the vault with an owner
// set, running the wizard with a DIFFERENT owner must keep the existing value
// and surface `alert-metadata-kept` ("Owner: kept the existing value on ...")
// on the Import Complete step.
//
// The merge policy + kept/applied reporting is unit-tested
// (merge-utils.keptFields.test.ts), but the wizard wiring — file dropzone,
// owner combobox, executeImport -> importResult.keptFieldCounts ->
// describeKeptFieldCounts rendering — only breaks in a real browser.
//
// Flow (all offline, IndexedDB only):
//   1. fresh vault (fresh browser context => empty IndexedDB)
//   2. seed one existing address record with owner "Alice" + ensure owner
//      "Bob" exists in the vocabulary; reload so live queries pick both up
//   3. upload a small Mycelium CSV whose Destination Address is that same
//      address (Mycelium is the mobile adapter that emits address records)
//   4. pick owner "Bob" on the Setup step, run Preview -> Start Import
//   5. assert the Import Complete step shows alert-metadata-kept listing
//      "Owner: kept the existing value on 1 address"
//   6. assert the record's owner in the vault is STILL "Alice"
//
// Usage: node scripts/check-mobile-import-kept-metadata-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const IMPORT_URL = `${BASE_URL}mobile-wallet-import`;
const SETUP_PASSWORD = 'kept-metadata-check-123';

const EXISTING_ADDR = 'bc1qkeptownerexistingaddresszzzzzzzzzzzz';
const EXISTING_OWNER = 'Alice';
const IMPORT_OWNER = 'Bob';
const TXID = 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5';

// Mycelium CSV: filename containing "mycelium" + these headers get detected
// as mycelium/csv; the row's Destination Address becomes an address record.
const CSV_CONTENT = [
  'Account,Transaction ID,Destination Address,Timestamp,Value,Currency,Transaction Label',
  `Main,${TXID},${EXISTING_ADDR},2024-05-01T12:00:00Z,0.5,BTC,Test deposit`,
].join('\n');

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

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[mobile-import-kept-browser] legacy-migration overlay detected; waiting it out ...');
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
      console.log(`[mobile-import-kept-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[mobile-import-kept-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[mobile-import-kept-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[mobile-import-kept-browser] starting dev server (npm run dev) ...');
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
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[mobile-import-kept-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(IMPORT_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: existing address record with a DIFFERENT owner already set ────
    const seed = await page.evaluate(
      async ({ addr, existingOwner, importOwner }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const vocab = await import('/src/lib/data/vocabulary-crud.ts');
        await vocab.ensureOwner(existingOwner);
        await vocab.ensureOwner(importOwner);
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'Existing cold storage',
          owner: existingOwner,
        });
        const rows = await recordCrud.getRecordsByInputString(addr);
        return { recordId, owner: rows[0]?.owner };
      },
      { addr: EXISTING_ADDR, existingOwner: EXISTING_OWNER, importOwner: IMPORT_OWNER },
    );
    steps.push({
      name: `seed: existing address record has owner "${EXISTING_OWNER}"`,
      passed: typeof seed.recordId === 'number' && seed.owner === EXISTING_OWNER,
      detail: `recordId=${seed.recordId}, owner=${JSON.stringify(seed.owner)}`,
    });

    // ── Reload so the wizard's live vocabulary queries see the owners ──────
    await page.goto(IMPORT_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    // ── Upload the Mycelium CSV via the dropzone's file input ──────────────
    await page.getByTestId('dropzone-mobile-wallet').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('input-file-mobile-wallet').setInputFiles({
      name: 'mycelium-export.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(CSV_CONTENT, 'utf8'),
    });

    // Detection (filename contains "mycelium") should auto-select Mycelium.
    const selectedBadge = page
      .getByTestId('wallet-option-mycelium')
      .getByText('Selected');
    const detected = await selectedBadge
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'CSV upload auto-detects Mycelium wallet type',
      passed: detected,
      detail: detected ? 'wallet-option-mycelium shows Selected' : 'Mycelium not auto-selected',
    });

    // ── Proceed to Setup and choose the conflicting owner "Bob" ────────────
    await page.getByTestId('button-proceed-setup').click();
    const ownerSelect = page.getByTestId('select-owner');
    await ownerSelect.waitFor({ state: 'visible', timeout: 30_000 });
    await ownerSelect.click();
    const ownerOption = page.locator('[cmdk-item]', { hasText: IMPORT_OWNER });
    await ownerOption.first().waitFor({ state: 'visible', timeout: 15_000 });
    await ownerOption.first().click();
    const ownerShown = ((await ownerSelect.textContent().catch(() => '')) ?? '').trim();
    steps.push({
      name: `setup step: owner "${IMPORT_OWNER}" selected for the import`,
      passed: ownerShown.includes(IMPORT_OWNER),
      detail: `select-owner shows ${JSON.stringify(ownerShown)}`,
    });

    // ── Preview then run the import ─────────────────────────────────────────
    await page.getByTestId('button-proceed-preview').click();
    const startBtn = page.getByTestId('button-start-import');
    await startBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await startBtn.click();

    // ── Import Complete: the kept-metadata notice must appear ──────────────
    const keptAlert = page.getByTestId('alert-metadata-kept');
    const alertVisible = await keptAlert
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    const alertText = alertVisible ? ((await keptAlert.textContent()) ?? '') : '';
    steps.push({
      name: 'Import Complete step shows the alert-metadata-kept notice',
      passed: alertVisible,
      detail: alertVisible ? 'alert visible' : 'alert-metadata-kept never appeared',
    });
    steps.push({
      name: 'notice lists "Owner: kept the existing value on 1 address"',
      passed: alertText.includes('Owner: kept the existing value on 1 address'),
      detail: `alert text=${JSON.stringify(alertText.trim().slice(0, 300))}`,
    });

    // ── The vault record's owner must be unchanged ("Alice", not "Bob") ────
    const after = await page.evaluate(
      async ({ addr }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const rows = await recordCrud.getRecordsByInputString(addr);
        return rows.map((r) => ({ owner: r.owner, label: r.label }));
      },
      { addr: EXISTING_ADDR },
    );
    steps.push({
      name: `existing owner "${EXISTING_OWNER}" survived the merge (not overwritten by "${IMPORT_OWNER}")`,
      passed: after.length === 1 && after[0].owner === EXISTING_OWNER,
      detail: JSON.stringify(after),
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

  console.log(`[mobile-import-kept-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[mobile-import-kept-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[mobile-import-kept-browser] PASSED: a real mobile-wallet import over an existing owned address keeps the existing owner and surfaces the kept-metadata notice on the Import Complete step — end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[mobile-import-kept-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
