#!/usr/bin/env node
// Real-browser regression guard for bulk-setting Counterparty Name in the
// Bulk Editor.
//
// Task #1413 made `counterpartyName` a settable text field in the Bulk Editor,
// but nothing proved the end-to-end flow: filter matching address records,
// apply a Set action on Counterparty Name, and verify EVERY matched record's
// stored value changes — and that the write survives a full page reload
// (i.e. it really landed in IndexedDB, not just React state). This script
// drives the actual page in headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons) three
//      address records sharing a label prefix: one WITH an existing
//      counterparty name (proves overwrite), two WITHOUT (proves fill-in).
//   3. Builds a filter in the UI (Label contains the shared prefix) and waits
//      for the preview to show exactly 3 matching records.
//   4. Adds a Set action on Counterparty Name, applies via the confirm
//      dialog, and asserts all three stored records now carry the new value.
//   5. Clicks Undo (task #1915) and asserts every record returns to its exact
//      prior value — the pre-existing name is restored and the empty ones stay
//      empty — then re-applies the Set for the remaining rounds.
//   6. Reloads the page, unlocks the vault again, and re-reads the stored
//      values from Dexie — the Set must survive the reload.
//   7. Rebuilds the same filter and runs a Clear action on Counterparty Name,
//      asserting all three stored values are emptied.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// NOTE for reviewers: the flow under test lives in
// client/src/pages/BulkEditor.tsx (applyChanges -> bulkUpdateRecords in
// client/src/lib/data/record-crud.ts); the field definition is in
// client/src/pages/bulk-editor-types.ts.
//
// Usage: node scripts/check-bulk-editor-counterparty-set-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded, waitForLoginScreenVisible } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}bulk-editor`;
const SETUP_PASSWORD = 'bulk-cp-check-123';

// Shared label prefix used by the UI filter; unique enough to only match our
// three seeded records. First-8-chars of the addresses differ (testid rule).
const LABEL_PREFIX = 'bulkcpcheck';
const ADDR_A = 'bc1qcpaaa000aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = 'bc1qcpbbb111bbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_C = 'bc1qcpccc222ccccccccccccccccccccccccccccc';
const ADDRS = [ADDR_A, ADDR_B, ADDR_C];
const EXISTING_NAME = 'Old Exchange Ltd';
const NEW_NAME = 'Kraken Exchange GmbH';
// Written to record B between Apply and Undo — Undo must not clobber it.
const MANUAL_EDIT_NAME = 'Manual Edit Co';

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

// chromium.launch can fail with pthread_create EAGAIN under validation load.
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
      console.log(`[bulk-editor-counterparty-set-browser] launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

async function pickSelectOption(page, triggerTestId, optionName) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

// Read the seeded records' stored counterpartyName values from live Dexie.
async function readStoredNames(page, addrs) {
  return page.evaluate(async (inputs) => {
    const recordCrud = await import('/src/lib/data/record-crud.ts');
    const rows = await recordCrud.getRecordsByInputStrings(inputs);
    const byInput = {};
    for (const r of rows) byInput[r.inputString] = r.counterpartyName ?? '';
    return inputs.map((a) => byInput[a]);
  }, addrs);
}

async function waitForStoredNames(page, addrs, expected, timeoutMs = 30_000) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    last = await readStoredNames(page, addrs);
    if (last.length === expected.length && expected.every((e, i) => last[i] === e)) {
      return { ok: true, last };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, last };
}

async function main() {
  const exe = resolveChromium();
  console.log(`[bulk-editor-counterparty-set-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[bulk-editor-counterparty-set-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[bulk-editor-counterparty-set-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[bulk-editor-counterparty-set-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => the "Create Vault" setup form.
    // Block the PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[bulk-editor-counterparty-set-browser][page-console] ${t}`);
      }
    });

    // Retry the initial goto + setup-form wait: single-shot waits flake under
    // parallel validation load.
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
        await waitForLoginScreenVisible(page, { timeoutMs: 45_000 });
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        console.log(`[bulk-editor-counterparty-set-browser] initial load attempt ${attempt} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD);

    const addConditionBtn = page.getByTestId('button-add-condition');
    await addConditionBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed: three address records, one with an existing counterparty ─────
    const seedResult = await page.evaluate(
      async ({ addrs, prefix, existingName }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        await recordCrud.createRecord({
          type: 'address',
          inputString: addrs[0],
          label: `${prefix} has-name`,
          counterpartyName: existingName,
        });
        await recordCrud.createRecord({
          type: 'address',
          inputString: addrs[1],
          label: `${prefix} no-name-1`,
        });
        await recordCrud.createRecord({
          type: 'address',
          inputString: addrs[2],
          label: `${prefix} no-name-2`,
        });
        return true;
      },
      { addrs: ADDRS, prefix: LABEL_PREFIX, existingName: EXISTING_NAME },
    );
    steps.push({
      name: 'seed: 3 address records (1 with an existing counterparty name, 2 without)',
      passed: seedResult === true,
      detail: `labels share prefix "${LABEL_PREFIX}"; existing name = ${JSON.stringify(EXISTING_NAME)}`,
    });

    // Filter builder: Label contains LABEL_PREFIX, expect 3 matches.
    async function buildFilter() {
      await page.getByTestId('button-add-condition').click();
      await pickSelectOption(page, 'select-field-0', 'Label');
      await pickSelectOption(page, 'select-operator-0', 'contains');
      await page.getByTestId('input-filter-value-label').fill(LABEL_PREFIX);
      const previewCount = page.getByTestId('text-preview-count');
      const ok = await previewCount
        .filter({ hasText: 'Preview: 3 records' })
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      const text = (await previewCount.textContent().catch(() => null)) ?? '(missing)';
      return { ok, text };
    }

    // Round runner: add a Counterparty Name action, apply via confirm dialog,
    // then wait for the stored values to match.
    async function runCounterpartyActionRound(actionLabel, actionValue, expected) {
      await page.getByTestId('button-add-action').click();
      await pickSelectOption(page, 'select-action-field-0', 'Counterparty Name');
      await pickSelectOption(page, 'select-action-type-0', actionLabel);
      if (actionValue !== null) {
        await page.getByTestId('input-value-counterpartyName').fill(actionValue);
      }

      const applyBtn = page.getByTestId('button-apply');
      await applyBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await applyBtn.click();

      const confirmBtn = page.getByTestId('button-confirm-apply');
      await confirmBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await confirmBtn.click();

      return waitForStoredNames(page, ADDRS, expected);
    }

    // ── Filter + Set round ─────────────────────────────────────────────────
    {
      const { ok, text } = await buildFilter();
      steps.push({
        name: 'filter: Label-contains filter matches exactly the 3 seeded records',
        passed: ok,
        detail: `preview text = ${JSON.stringify(text.trim())}`,
      });
      if (!ok) throw new Error('Filter never matched 3 records — cannot continue.');
    }

    {
      const expected = [NEW_NAME, NEW_NAME, NEW_NAME];
      const { ok, last } = await runCounterpartyActionRound('Set', NEW_NAME, expected);
      steps.push({
        name: 'set: every matched record (existing + empty) now stores the new counterparty name',
        passed: ok,
        detail: `stored = ${JSON.stringify(last)} (expected ${JSON.stringify(expected)})`,
      });
      if (!ok) throw new Error('Set round never produced the expected stored counterparty names.');
    }

    // ── Undo round: restore the mixed prior values (task #1915) ────────────
    // The Undo snapshot captured each record's BEFORE value: record A had an
    // existing counterparty name, B and C were empty. Undo must restore each
    // record's exact prior value — including empties staying empty.
    //
    // Staleness guard (task #1948): before undoing, record B is manually
    // edited (simulating a user edit between Apply and Undo). Undo must SKIP
    // record B — preserving the newer manual edit — while still restoring
    // A and C, and it must surface a skip notice.
    {
      await page.evaluate(async ({ addr, manualName }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const [row] = await recordCrud.getRecordsByInputStrings([addr]);
        if (!row) throw new Error('edited-between round: record not found');
        await recordCrud.updateRecord(row.id, { counterpartyName: manualName });
      }, { addr: ADDR_B, manualName: MANUAL_EDIT_NAME });

      const undoBtn = page.getByTestId('button-undo');
      await undoBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await undoBtn.click();
      const undoConfirm = page.getByRole('button', { name: 'Undo Changes' });
      await undoConfirm.waitFor({ state: 'visible', timeout: 10_000 });
      await undoConfirm.click();

      const expected = [EXISTING_NAME, MANUAL_EDIT_NAME, ''];
      const { ok, last } = await waitForStoredNames(page, ADDRS, expected);
      steps.push({
        name: 'undo: restores untouched records but SKIPS the record edited between apply and undo (manual edit preserved)',
        passed: ok,
        detail: `stored after undo = ${JSON.stringify(last)} (expected ${JSON.stringify(expected)})`,
      });
      if (!ok) throw new Error('Undo did not preserve the mid-flight manual edit / restore the untouched records.');

      // The partial-undo notice must reach the user (toast text duplicates
      // into aria-live, so take .first()).
      const noticeSeen = await page
        .getByText(/Skipped 1 record\(s\) to preserve newer changes/i)
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'undo: a clear skip notice is shown for the record edited since the apply',
        passed: noticeSeen,
        detail: noticeSeen ? 'partial-undo toast visible' : 'skip notice toast never appeared',
      });

      const undoGone = await undoBtn
        .waitFor({ state: 'detached', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      steps.push({
        name: 'undo: the Undo button disappears after a successful undo (snapshot consumed)',
        passed: undoGone,
        detail: undoGone ? 'button-undo detached' : 'button-undo still visible after undo',
      });
    }

    // Re-apply the Set so the reload-survival and Clear rounds below still
    // exercise the original end-to-end flow. The filter conditions persist
    // after apply/undo (only the actions list is cleared).
    {
      const expected = [NEW_NAME, NEW_NAME, NEW_NAME];
      const { ok, last } = await runCounterpartyActionRound('Set', NEW_NAME, expected);
      steps.push({
        name: 're-set (post-undo): applying Set again writes the new name to all 3 records',
        passed: ok,
        detail: `stored = ${JSON.stringify(last)} (expected ${JSON.stringify(expected)})`,
      });
      if (!ok) throw new Error('Post-undo Set round never produced the expected stored counterparty names.');
    }

    // ── Reload + unlock: the Set must survive a full page reload ───────────
    {
      await page.reload({ waitUntil: 'load', timeout: 60_000 });
      await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 45_000 });
      await page.getByTestId('button-add-condition').waitFor({ state: 'visible', timeout: 30_000 });

      const stored = await readStoredNames(page, ADDRS);
      const survived = stored.every((v) => v === NEW_NAME);
      steps.push({
        name: 'reload: all 3 stored counterparty names survive a full page reload + unlock',
        passed: survived,
        detail: `stored after reload = ${JSON.stringify(stored)}`,
      });
      if (!survived) throw new Error('Counterparty names did not survive the reload.');
    }

    // ── Clear round (fresh filter after the reload) ────────────────────────
    {
      const { ok, text } = await buildFilter();
      steps.push({
        name: 'filter (post-reload): matches the 3 seeded records again',
        passed: ok,
        detail: `preview text = ${JSON.stringify(text.trim())}`,
      });
      if (!ok) throw new Error('Post-reload filter never matched 3 records — cannot continue.');
    }

    {
      const expected = ['', '', ''];
      const { ok, last } = await runCounterpartyActionRound('Clear', null, expected);
      steps.push({
        name: 'clear: every matched record\'s counterparty name is emptied',
        passed: ok,
        detail: `stored = ${JSON.stringify(last)} (expected ${JSON.stringify(expected)})`,
      });
    }
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

  console.log(`[bulk-editor-counterparty-set-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[bulk-editor-counterparty-set-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[bulk-editor-counterparty-set-browser] PASSED: bulk Set writes the counterparty name to every matched record, the write survives a reload, and Clear empties the field end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[bulk-editor-counterparty-set-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
