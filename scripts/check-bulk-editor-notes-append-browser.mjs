#!/usr/bin/env node
// Real-browser regression guard for the Bulk Editor Append/Prepend-on-Notes flow.
//
// Unit tests lock in the joining rules of the shared helper `applyTextJoin`
// (client/src/pages/bulk-editor-types.ts), but nothing proved the full flow
// end to end: pick a filter, choose Append on Notes, confirm the dialog, and
// verify the STORED note actually has the newline-joined value. This script
// drives the actual page in headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds (via Vite dynamic imports of the live CRUD singletons) two
//      address records with a shared label prefix: one WITH an existing note,
//      one WITHOUT any note.
//   3. Builds a filter in the UI (Label contains the shared prefix) and waits
//      for the preview to show exactly 2 matching records.
//   4. Adds an Append action on Notes, applies it via the confirm dialog, and
//      asserts the stored notes read back from Dexie:
//        - existing note  ->  "<existing>\n<appended>"  (newline-joined)
//        - empty note     ->  "<appended>"              (NO stray blank line)
//   5. Runs a second round with a Prepend action on Notes and asserts both
//      stored notes gained "<prepended>\n" at the start.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-bulk-editor-notes-append-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}bulk-editor`;
const SETUP_PASSWORD = 'bulk-notes-check-123';

// Shared label prefix used by the UI filter; unique enough to only match our
// two seeded records. First-8-chars of the addresses differ (testid rule).
const LABEL_PREFIX = 'bulknotecheck';
const ADDR_WITH_NOTE = 'bc1qnoteaaa0aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_NO_NOTE = 'bc1qnotebbb1bbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const EXISTING_NOTE = 'Existing first line';
const APPEND_TEXT = 'APPENDED-BY-BULK-EDITOR';
const PREPEND_TEXT = 'PREPENDED-BY-BULK-EDITOR';

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

// chromium.launch can fail with pthread_create EAGAIN under validation load;
// retry a few times before giving up.
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
      console.log(`[bulk-editor-notes-append-browser] launch attempt ${i + 1} failed: ${err.message}`);
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

// Poll the live Dexie singleton for the two seeded records' stored notes.
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
  console.log(`[bulk-editor-notes-append-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[bulk-editor-notes-append-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[bulk-editor-notes-append-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[bulk-editor-notes-append-browser] dev server ready at ${BASE_URL}`);
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
        console.log(`[bulk-editor-notes-append-browser][page-console] ${t}`);
      }
    });

    // Retry the initial goto + setup-form wait: single-shot waits flake
    // under parallel validation load.
    let pwInput;
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
        pwInput = page.getByTestId('input-password');
        await pwInput.waitFor({ state: 'visible', timeout: 45_000 });
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        console.log(`[bulk-editor-notes-append-browser] initial load attempt ${attempt} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // Best-effort: dismiss the legacy-migration overlay if it appears after
    // unlock, otherwise it swallows subsequent clicks.
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});

    // ── Wait for the Bulk Editor page to render ────────────────────────────
    const addConditionBtn = page.getByTestId('button-add-condition');
    await addConditionBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed: one record WITH a note, one WITHOUT ──────────────────────────
    // Vite serves a singleton module graph, so the dynamically-imported CRUD
    // module writes to the exact same Dexie instance the page reads.
    const seedResult = await page.evaluate(
      async ({ withNote, noNote, prefix, note }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        await recordCrud.createRecord({
          type: 'address',
          inputString: withNote,
          label: `${prefix} has-note`,
          notes: note,
        });
        await recordCrud.createRecord({
          type: 'address',
          inputString: noNote,
          label: `${prefix} no-note`,
        });
        return true;
      },
      { withNote: ADDR_WITH_NOTE, noNote: ADDR_NO_NOTE, prefix: LABEL_PREFIX, note: EXISTING_NOTE },
    );
    steps.push({
      name: 'seed: one record with an existing note + one with no note',
      passed: seedResult === true,
      detail: `labels share prefix "${LABEL_PREFIX}"; existing note = ${JSON.stringify(EXISTING_NOTE)}`,
    });

    // ── Build the filter: Label contains "bulknotecheck" ───────────────────
    await addConditionBtn.click();
    await pickSelectOption(page, 'select-field-0', 'Label');
    await pickSelectOption(page, 'select-operator-0', 'contains');
    await page.getByTestId('input-filter-value-label').fill(LABEL_PREFIX);

    const previewCount = page.getByTestId('text-preview-count');
    const previewOk = await previewCount
      .filter({ hasText: 'Preview: 2 records' })
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const previewText = (await previewCount.textContent().catch(() => null)) ?? '(missing)';
    steps.push({
      name: 'filter: Label-contains filter matches exactly the 2 seeded records',
      passed: previewOk,
      detail: `preview text = ${JSON.stringify(previewText.trim())}`,
    });
    if (!previewOk) throw new Error('Filter never matched 2 records — cannot continue.');

    // Round runner: add a Notes action of the given type, apply via the
    // confirm dialog, then wait for the stored notes to match.
    async function runNotesActionRound(actionLabel, actionValue, expectedNotes) {
      await page.getByTestId('button-add-action').click();
      await pickSelectOption(page, 'select-action-field-0', 'Notes');
      await pickSelectOption(page, 'select-action-type-0', actionLabel);
      await page.getByTestId('input-value-notes').fill(actionValue);

      const applyBtn = page.getByTestId('button-apply');
      await applyBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await applyBtn.click();

      const confirmBtn = page.getByTestId('button-confirm-apply');
      await confirmBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await confirmBtn.click();

      return waitForStoredNotes(page, [ADDR_WITH_NOTE, ADDR_NO_NOTE], expectedNotes);
    }

    // ── Round 1: Append on Notes ───────────────────────────────────────────
    {
      const expected = [
        `${EXISTING_NOTE}\n${APPEND_TEXT}`, // newline-joined onto the existing note
        APPEND_TEXT, // previously-empty note: NO stray leading blank line
      ];
      const { ok, last } = await runNotesActionRound('Append', APPEND_TEXT, expected);
      steps.push({
        name: 'append: existing note gains "\\n<text>" at the end',
        passed: ok && last[0] === expected[0],
        detail: `stored = ${JSON.stringify(last[0])} (expected ${JSON.stringify(expected[0])})`,
      });
      steps.push({
        name: 'append: previously-empty note becomes exactly the appended text (no blank line)',
        passed: ok && last[1] === expected[1],
        detail: `stored = ${JSON.stringify(last[1])} (expected ${JSON.stringify(expected[1])})`,
      });
      if (!ok) throw new Error('Append round never produced the expected stored notes.');
    }

    // ── Round 2: Prepend on Notes ──────────────────────────────────────────
    // applyChanges clears the actions list but keeps the filter, so we can
    // immediately add a fresh action (index 0 again).
    {
      const expected = [
        `${PREPEND_TEXT}\n${EXISTING_NOTE}\n${APPEND_TEXT}`,
        `${PREPEND_TEXT}\n${APPEND_TEXT}`,
      ];
      const { ok, last } = await runNotesActionRound('Prepend', PREPEND_TEXT, expected);
      steps.push({
        name: 'prepend: both stored notes gain "<text>\\n" at the start',
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

  console.log(`[bulk-editor-notes-append-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[bulk-editor-notes-append-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[bulk-editor-notes-append-browser] PASSED: Append/Prepend on Notes save the newline-joined values end-to-end in a real browser, with no stray blank line for previously-empty notes.',
  );
}

main().catch((err) => {
  console.error('[bulk-editor-notes-append-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
