#!/usr/bin/env node
// Real-browser regression guard for the "click to add metadata" flow:
// clicking an address link with NO existing record must open the shared
// Create New Record dialog (create mode) prefilled with that identifier,
// and saving it must land the user in the detail panel for the new record.
//
// jsdom unit tests cover the RecordPreviewContext branch logic, but not the
// live wiring a real browser exercises: Radix Dialog portals/focus traps,
// the metadata-hover resolve cache, and the create -> preview handoff.
//
// Flow (all offline, IndexedDB only):
//   1. fresh vault (fresh browser context => empty IndexedDB)
//   2. seed one OWNED input address record + one confirmed tx whose output
//      participant is an UNKNOWN address with no record (the counterparty
//      link under test); reload once so the curated tx mounts (the page's
//      liveQuery ignores runtime dynamic-import writes)
//   3. expand the tx card and click the unknown output address link
//   4. assert the "Create New Record" dialog opens with the identifier
//      prefilled in the input field
//   5. fill a label, save, and assert the detail panel opens showing the
//      new record's identifier
//
// Usage: node scripts/check-add-metadata-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const TX_URL = `${BASE_URL}transactions`;
const SETUP_PASSWORD = 'add-metadata-check-123';

// First-8-chars prefixes must differ (testids are identifier.slice(0,8)).
const OWNED_ADDR = 'bc1qmetaownedinputaddressxxxxxxxxxxxxxxx';
const UNKNOWN_ADDR = 'bc1qunknownclicktargetaddressyyyyyyyyyyy';
const FUND_TXID = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4';
const NEW_LABEL = 'Added via click-to-add';
const TX_LABEL = 'Txid added via click-to-add';

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
  console.log('[add-metadata-browser] legacy-migration overlay detected; waiting it out ...');
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
      console.log(`[add-metadata-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[add-metadata-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[add-metadata-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[add-metadata-browser] starting dev server (npm run dev) ...');
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
        console.log(`[add-metadata-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(TX_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: owned input record + curated tx; unknown output stays record-less
    const seed = await page.evaluate(
      async ({ owned, unknown, txid }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: owned,
          label: 'Owned input (curates the tx)',
        });
        const blockTime = Math.floor(Date.now() / 1000) - 86400;
        await txCrud.addTransaction({
          txid,
          blockHeight: 800000,
          blockTime,
          fee: 100,
          feeRate: 1,
          syncedAt: Date.now(),
        });
        await txCrud.addParticipant({
          txid,
          role: 'input',
          address: owned,
          amount: 50_000,
          vout: 0,
          recordId,
        });
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: unknown,
          amount: 49_900,
          vout: 0,
        });
        const unknownRecords = await recordCrud.getRecordsByInputString(unknown);
        return { recordId, unknownCount: unknownRecords.length };
      },
      { owned: OWNED_ADDR, unknown: UNKNOWN_ADDR, txid: FUND_TXID },
    );
    steps.push({
      name: 'seed: owned input record + tx; clicked output address has NO record',
      passed: typeof seed.recordId === 'number' && seed.unknownCount === 0,
      detail: `recordId=${seed.recordId}, records for unknown addr=${seed.unknownCount}`,
    });

    // ── Reload once so the page's curated-tx liveQuery mounts the seeded tx ─
    await page.goto(TX_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const card = page.getByTestId(`card-transaction-${FUND_TXID.slice(0, 8)}`);
    await card.waitFor({ state: 'visible', timeout: 30_000 });

    // Expand cards so the participant address links render.
    const link = page.getByTestId(`link-address-${UNKNOWN_ADDR.slice(0, 8)}`);
    if (!(await link.isVisible().catch(() => false))) {
      await page.getByTestId('button-expand-collapse-all').click();
    }
    await link.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'transactions page renders the unknown output address link',
      passed: true,
      detail: `link-address-${UNKNOWN_ADDR.slice(0, 8)} visible`,
    });

    // ── Click the unknown address: Create New Record dialog, prefilled ─────
    await link.click();

    const dialogTitle = page.getByRole('heading', { name: 'Create New Record' });
    const titleVisible = await dialogTitle
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'clicking the record-less address opens the Create New Record dialog',
      passed: titleVisible,
      detail: titleVisible ? 'dialog title visible' : 'dialog did not open (or opened in edit mode)',
    });

    const prefill = await page.getByTestId('input-address').inputValue().catch(() => null);
    steps.push({
      name: 'identifier field is prefilled with the clicked address',
      passed: prefill === UNKNOWN_ADDR,
      detail: `input-address = ${JSON.stringify(prefill)}`,
    });

    // ── Fill a label and save ───────────────────────────────────────────────
    await page.getByTestId('input-label').fill(NEW_LABEL);
    await page.getByTestId('button-save').click();

    // ── Detail panel opens showing the new record's identifier ─────────────
    const panelId = page.getByTestId('text-panel-identifier');
    const panelVisible = await panelId
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const panelText = panelVisible ? (await panelId.textContent()) ?? '' : '';
    steps.push({
      name: 'after save, the detail panel opens showing the new record identifier',
      passed: panelVisible && panelText.includes(UNKNOWN_ADDR),
      detail: `panel visible=${panelVisible}, identifier=${JSON.stringify(panelText.trim())}`,
    });

    // ── The record actually persisted with the entered label ───────────────
    const persisted = await page.evaluate(
      async ({ unknown }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const records = await recordCrud.getRecordsByInputString(unknown);
        return records.map((r) => ({ label: r.label, inputString: r.inputString }));
      },
      { unknown: UNKNOWN_ADDR },
    );
    steps.push({
      name: 'the new record persisted in the vault with the entered label',
      passed: persisted.length === 1 && persisted[0].label === NEW_LABEL,
      detail: JSON.stringify(persisted),
    });

    // ═══ Part 2: txid variant — clicking a record-less TRANSACTION ID ═══════
    // TxidLink funnels through the same openRecordPreviewByAddress path, but
    // the txid branch exercises different wiring: validateBitcoinInput must
    // detect "transaction", and the dialog renders tx-specific sections
    // (Fetch Data button). Reload first so the detail panel from Part 1 is
    // gone and the hover-resolve cache is fresh.
    await page.goto(TX_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    // Sanity: the txid itself must have NO record (Part 1 only created one
    // for the unknown address).
    const txidRecordsBefore = await page.evaluate(
      async ({ txid }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        return (await recordCrud.getRecordsByInputString(txid)).length;
      },
      { txid: FUND_TXID },
    );
    steps.push({
      name: 'seeded txid has NO record before the click',
      passed: txidRecordsBefore === 0,
      detail: `records for txid=${txidRecordsBefore}`,
    });

    const txidLink = page.getByTestId(`link-txid-${FUND_TXID.slice(0, 8)}`);
    await txidLink.waitFor({ state: 'visible', timeout: 30_000 });
    await txidLink.click();

    const txDialogTitle = page.getByRole('heading', { name: 'Create New Record' });
    const txTitleVisible = await txDialogTitle
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'clicking the record-less txid opens the Create New Record dialog',
      passed: txTitleVisible,
      detail: txTitleVisible ? 'dialog title visible' : 'dialog did not open (or opened in edit mode)',
    });

    const txPrefill = await page.getByTestId('input-address').inputValue().catch(() => null);
    steps.push({
      name: 'identifier field is prefilled with the clicked txid (64-hex)',
      passed: txPrefill === FUND_TXID,
      detail: `input-address = ${JSON.stringify(txPrefill)}`,
    });

    // Detected type must be "transaction": the type select shows "Transaction"
    // and the tx-only Fetch Data button renders (enabled, since the prefilled
    // identifier is a valid 64-hex txid).
    const typeText = (await page.getByTestId('select-type').textContent().catch(() => '')) ?? '';
    steps.push({
      name: 'type is auto-detected as "transaction"',
      passed: typeText.trim() === 'Transaction',
      detail: `select-type shows ${JSON.stringify(typeText.trim())}`,
    });

    const fetchBtn = page.getByTestId('button-fetch-tx');
    const fetchVisible = await fetchBtn.isVisible().catch(() => false);
    const fetchEnabled = fetchVisible && (await fetchBtn.isEnabled().catch(() => false));
    steps.push({
      name: 'tx-specific Fetch Data button is visible and enabled for the valid txid',
      passed: fetchVisible && fetchEnabled,
      detail: `visible=${fetchVisible}, enabled=${fetchEnabled}`,
    });

    // ── Fill a label and save (no fetch — stay offline) ────────────────────
    await page.getByTestId('input-label').fill(TX_LABEL);
    await page.getByTestId('button-save').click();

    const txPanelId = page.getByTestId('text-panel-identifier');
    const txPanelVisible = await txPanelId
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const txPanelText = txPanelVisible ? (await txPanelId.textContent()) ?? '' : '';
    steps.push({
      name: 'after save, the detail panel opens showing the txid',
      passed: txPanelVisible && txPanelText.includes(FUND_TXID),
      detail: `panel visible=${txPanelVisible}, identifier=${JSON.stringify(txPanelText.trim())}`,
    });

    const txPersisted = await page.evaluate(
      async ({ txid }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const records = await recordCrud.getRecordsByInputString(txid);
        return records.map((r) => ({ label: r.label, type: r.type, inputString: r.inputString }));
      },
      { txid: FUND_TXID },
    );
    steps.push({
      name: 'the txid record persisted with type "transaction" and the entered label',
      passed:
        txPersisted.length === 1 &&
        txPersisted[0].label === TX_LABEL &&
        txPersisted[0].type === 'transaction',
      detail: JSON.stringify(txPersisted),
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

  console.log(`[add-metadata-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[add-metadata-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[add-metadata-browser] PASSED: clicking a record-less address OR txid opens the prefilled Create New Record dialog (txid detected as type "transaction" with Fetch Data), saving creates the record, and the detail panel shows it — end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[add-metadata-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
