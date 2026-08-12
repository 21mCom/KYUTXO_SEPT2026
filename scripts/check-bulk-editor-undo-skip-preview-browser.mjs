#!/usr/bin/env node
// Real-browser regression guard for the Bulk Editor Undo skip preview.
//
// Unit tests lock in buildUndoSkipPreview, but nothing proved the popover
// wiring end to end: onOpenChange fetch, loading state, stale/missing
// rendering, and the undo-skip-preview / undo-skip-preview-clean testids.
// This script drives the actual page in headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons) three
//      address records sharing a label prefix.
//   3. Builds a Label-contains filter in the UI, applies an Append-on-Notes
//      bulk action via the confirm dialog (3 records modified).
//   4. CLEAN PATH: opens the Undo popover and asserts
//      undo-skip-preview-clean says "All 3 records can be restored."
//   5. Closes the popover, then edits one record's notes and deletes another
//      via the live CRUD singletons.
//   6. SKIP PATH: reopens the popover and asserts undo-skip-preview lists
//      the edited record (identifier + "notes" changed field), the deleted
//      record ("Record #<id> — deleted since apply"), reports "2 records
//      will be skipped" and the reduced restore count ("Only 1 record will
//      be restored").
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-bulk-editor-undo-skip-preview-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts).
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}bulk-editor`;
const SETUP_PASSWORD = 'undo-skip-check-123';

// Shared label prefix used by the UI filter; addresses differ in their first
// 8 chars (testid rule).
const LABEL_PREFIX = 'undoskipcheck';
const ADDR_KEEP = 'bc1qskpaaa0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_EDIT = 'bc1qskpbbb1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_DELETE = 'bc1qskpccc2cccccccccccccccccccccccccccccc';
const APPEND_TEXT = 'APPENDED-BY-UNDO-SKIP-CHECK';
const POST_APPLY_EDIT = 'edited after the bulk apply';

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
      console.log(`[undo-skip-preview-browser] launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

// Radix Select helper: open the trigger, then click the option by exact name.
async function pickSelectOption(page, triggerTestId, optionName) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

async function readStoredNotes(page, addrs) {
  return page.evaluate(async (inputs) => {
    const recordCrud = await import('/src/lib/data/record-crud.ts');
    const rows = await recordCrud.getRecordsByInputStrings(inputs);
    const byInput = {};
    for (const r of rows) byInput[r.inputString] = r.notes ?? '';
    return inputs.map((a) => byInput[a]);
  }, addrs);
}

async function waitForStoredNotes(page, addrs, expected, timeoutMs = 30_000) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    last = await readStoredNotes(page, addrs);
    if (last.length === expected.length && expected.every((e, i) => last[i] === e)) {
      return { ok: true, last };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, last };
}

async function main() {
  const exe = resolveChromium();
  console.log(`[undo-skip-preview-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[undo-skip-preview-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[undo-skip-preview-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[undo-skip-preview-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => the "Create Vault" setup form.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[undo-skip-preview-browser][page-console] ${t}`);
      }
    });

    // Retry the initial goto + setup-form wait under validation load.
    let pwInput;
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
        pwInput = page.getByTestId('input-password');
        await pwInput.waitFor({ state: 'visible', timeout: 45_000 });
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        console.log(`[undo-skip-preview-browser] initial load attempt ${attempt} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    // ── Create the vault ───────────────────────────────────────────────────
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // Dismiss the legacy-migration overlay if it appears (it swallows clicks).
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    const addConditionBtn = page.getByTestId('button-add-condition');
    await addConditionBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed three records sharing the label prefix ────────────────────────
    const seedResult = await page.evaluate(
      async ({ addrs, prefix }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        for (let i = 0; i < addrs.length; i++) {
          await recordCrud.createRecord({
            type: 'address',
            inputString: addrs[i],
            label: `${prefix} rec-${i}`,
          });
        }
        return true;
      },
      { addrs: [ADDR_KEEP, ADDR_EDIT, ADDR_DELETE], prefix: LABEL_PREFIX },
    );
    steps.push({
      name: 'seed: three records sharing the label prefix',
      passed: seedResult === true,
      detail: `prefix "${LABEL_PREFIX}"`,
    });

    // ── Filter: Label contains prefix, expect 3 matches ────────────────────
    await addConditionBtn.click();
    await pickSelectOption(page, 'select-field-0', 'Label');
    await pickSelectOption(page, 'select-operator-0', 'contains');
    await page.getByTestId('input-filter-value-label').fill(LABEL_PREFIX);

    const previewCount = page.getByTestId('text-preview-count');
    const previewOk = await previewCount
      .filter({ hasText: 'Preview: 3 records' })
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'filter: matches exactly the 3 seeded records',
      passed: previewOk,
      detail: `preview text = ${JSON.stringify(((await previewCount.textContent().catch(() => null)) ?? '(missing)').trim())}`,
    });
    if (!previewOk) throw new Error('Filter never matched 3 records — cannot continue.');

    // ── Apply an Append-on-Notes bulk action ───────────────────────────────
    await page.getByTestId('button-add-action').click();
    await pickSelectOption(page, 'select-action-field-0', 'Notes');
    await pickSelectOption(page, 'select-action-type-0', 'Append');
    await page.getByTestId('input-value-notes').fill(APPEND_TEXT);

    const applyBtn = page.getByTestId('button-apply');
    await applyBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await applyBtn.click();
    const confirmBtn = page.getByTestId('button-confirm-apply');
    await confirmBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await confirmBtn.click();

    const applied = await waitForStoredNotes(
      page,
      [ADDR_KEEP, ADDR_EDIT, ADDR_DELETE],
      [APPEND_TEXT, APPEND_TEXT, APPEND_TEXT],
    );
    steps.push({
      name: 'apply: bulk Append wrote all 3 notes',
      passed: applied.ok,
      detail: `stored = ${JSON.stringify(applied.last)}`,
    });
    if (!applied.ok) throw new Error('Bulk apply never landed — cannot continue.');

    const undoBtn = page.getByTestId('button-undo');
    await undoBtn.waitFor({ state: 'visible', timeout: 15_000 });

    // ── CLEAN PATH: open the popover, expect the clean message ─────────────
    await undoBtn.click();
    const cleanEl = page.getByTestId('undo-skip-preview-clean');
    const cleanOk = await cleanEl
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const cleanText = ((await cleanEl.textContent().catch(() => null)) ?? '(missing)').trim();
    steps.push({
      name: 'clean path: undo-skip-preview-clean says all 3 records can be restored',
      passed: cleanOk && cleanText.includes('All 3 records can be restored'),
      detail: `text = ${JSON.stringify(cleanText)}`,
    });
    // Also confirm the skip box did NOT render on the clean path.
    steps.push({
      name: 'clean path: undo-skip-preview (skip box) is absent',
      passed: (await page.getByTestId('undo-skip-preview').count()) === 0,
      detail: 'no stale/missing entries expected yet',
    });

    // Close the popover (onOpenChange(false) clears the preview state).
    await page.keyboard.press('Escape');
    await cleanEl.waitFor({ state: 'hidden', timeout: 10_000 });

    // ── Mutate: edit one record's notes, delete another ────────────────────
    const { editedId, deletedId } = await page.evaluate(
      async ({ editAddr, deleteAddr, newNotes }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const rows = await recordCrud.getRecordsByInputStrings([editAddr, deleteAddr]);
        const byInput = {};
        for (const r of rows) byInput[r.inputString] = r;
        const editedId = byInput[editAddr].id;
        const deletedId = byInput[deleteAddr].id;
        await recordCrud.updateRecord(editedId, { notes: newNotes });
        await recordCrud.deleteRecord(deletedId);
        return { editedId, deletedId };
      },
      { editAddr: ADDR_EDIT, deleteAddr: ADDR_DELETE, newNotes: POST_APPLY_EDIT },
    );
    steps.push({
      name: 'mutate: edited one record + deleted another after the apply',
      passed: Number.isFinite(editedId) && Number.isFinite(deletedId),
      detail: `editedId=${editedId} deletedId=${deletedId}`,
    });

    // ── SKIP PATH: reopen the popover, expect stale + missing entries ──────
    await undoBtn.click();
    const skipBox = page.getByTestId('undo-skip-preview');
    const skipOk = await skipBox
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const skipText = ((await skipBox.textContent().catch(() => null)) ?? '(missing)').trim();
    steps.push({
      name: 'skip path: undo-skip-preview box renders after reopening',
      passed: skipOk,
      detail: `text = ${JSON.stringify(skipText)}`,
    });
    if (!skipOk) throw new Error('Skip preview box never rendered — cannot continue.');

    steps.push({
      name: 'skip path: header counts 2 records will be skipped',
      passed: skipText.includes('2 records will be skipped'),
      detail: `text = ${JSON.stringify(skipText)}`,
    });
    steps.push({
      name: 'skip path: reduced restore count (Only 1 record will be restored)',
      passed: skipText.includes('Only 1 record will be restored'),
      detail: `text = ${JSON.stringify(skipText)}`,
    });

    const staleRow = page.getByTestId(`undo-skip-stale-${editedId}`);
    const staleText = ((await staleRow.textContent().catch(() => null)) ?? '(missing)').trim();
    steps.push({
      name: 'skip path: stale row shows the edited record identifier + changed field',
      passed:
        staleText.includes(ADDR_EDIT.substring(0, 24)) &&
        staleText.includes('edited since apply') &&
        staleText.includes('notes'),
      detail: `row = ${JSON.stringify(staleText)}`,
    });

    const missingRow = page.getByTestId(`undo-skip-missing-${deletedId}`);
    const missingText = ((await missingRow.textContent().catch(() => null)) ?? '(missing)').trim();
    steps.push({
      name: 'skip path: missing row shows the deleted record id',
      passed:
        missingText.includes(`Record #${deletedId}`) &&
        missingText.includes('deleted since apply'),
      detail: `row = ${JSON.stringify(missingText)}`,
    });

    // Clean-path testid must not render alongside the skip box.
    steps.push({
      name: 'skip path: undo-skip-preview-clean is absent',
      passed: (await page.getByTestId('undo-skip-preview-clean').count()) === 0,
      detail: 'clean message must not show when records will be skipped',
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

  console.log(`[undo-skip-preview-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[undo-skip-preview-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[undo-skip-preview-browser] PASSED: the Undo popover skip preview shows the clean message when nothing changed, and lists edited (identifier + changed fields) and deleted records with the reduced restore count after post-apply mutations.',
  );
}

main().catch((err) => {
  console.error('[undo-skip-preview-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
