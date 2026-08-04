#!/usr/bin/env node
// Real-browser check for the Database Doctor guided duplicate Resolve dialog
// (task: "Confirm the guided duplicate Resolve dialog works end-to-end in a
// real browser").
//
// NOTE for reviewers: the flow under test lives in
// client/src/pages/DatabaseDoctor.tsx (ResolveDuplicateDialog + the
// "Duplicate identifier records" card), reached via /database-doctor.
//
// The jsdom test (DatabaseDoctor.duplicateIdentifiers.test.tsx) covers the
// component logic, but Radix Dialog portal focus traps, RadioGroup keyboard/
// pointer handling, and toast timing can differ in a real browser. This
// script:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds ONE collision group: a canonical keeper record plus a duplicate
//      sibling whose inputString is raw-updated to a padded/UPPERCASE variant
//      of the same address (pre-canonicalization row shape); the duplicate
//      carries a distinct label + tag + notes so the lost-metadata preview has
//      something real to show
//   3. runs the health check on /database-doctor and waits for the
//      "Duplicate identifier records" card
//   4. opens the group's Resolve… dialog, asserts both records render as
//      radio options and the lost-metadata warning lists the duplicate's
//      label/tags/notes
//   5. explicitly selects the canonical record as the keeper (real Radix
//      RadioGroup click), confirms the delete button labels the right ids,
//      and clicks it
//   6. asserts the "Duplicate resolved" toast appears, the dialog closes, and
//      the group row disappears from the card without a re-scan
//   7. re-reads IndexedDB: the duplicate record is gone, the keeper survives
//      with its metadata intact
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-database-doctor-resolve-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const DOCTOR_URL = `${BASE_URL}database-doctor`;
const SETUP_PASSWORD = 'dbdoctor-resolve-check-123';

const ADDR = `bc1qresolvedoctor00${'q'.repeat(24)}check`;
const DUP_LABEL = 'Dup label to lose';
const DUP_TAG = 'dup-only-tag';
const DUP_NOTES = 'Notes only on the duplicate record';
const KEEP_LABEL = 'Keeper record';

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

async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await dismissMigrationOverlayIfPresent(page);
    return false;
  }
  await pwInput.fill(SETUP_PASSWORD);
  const confirmInput = page.getByTestId('input-confirm-password');
  const hasConfirm = await confirmInput.isVisible().catch(() => false);
  if (hasConfirm) {
    await confirmInput.fill(SETUP_PASSWORD);
  }
  await page.getByTestId('button-submit').click();
  await pwInput.waitFor({ state: 'detached', timeout: 30_000 });
  await dismissMigrationOverlayIfPresent(page);
  return true;
}

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[dbdoctor-resolve-browser] legacy-migration overlay detected; waiting it out ...');
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

async function main() {
  const exe = resolveChromium();
  console.log(`[dbdoctor-resolve-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dbdoctor-resolve-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dbdoctor-resolve-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[dbdoctor-resolve-browser] dev server ready at ${BASE_URL}`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel
  // validation load.
  let browser = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(
        `[dbdoctor-resolve-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[dbdoctor-resolve-browser][page-console] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      console.log(`[dbdoctor-resolve-browser][page-error] ${err.message}`);
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed one collision group ────────────────────────────────────────────
    // Keeper via the CRUD layer; the duplicate sibling is created via CRUD
    // with a placeholder identifier and then raw-updated to a padded/UPPERCASE
    // variant of the same address (createRecord canonicalizes on save, so this
    // emulates a pre-canonicalization row). The duplicate carries metadata the
    // keeper lacks so the lost-metadata preview has real content.
    const seed = await page.evaluate(
      async ({ addr, dupLabel, dupTag, dupNotes, keepLabel }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');
        const keeperId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: keepLabel,
        });
        const placeholder = `bc1qresolveplaceholder00${'p'.repeat(18)}x`;
        const dupId = await recordCrud.createRecord({
          type: 'address',
          inputString: placeholder,
          label: dupLabel,
          tags: [dupTag],
          notes: dupNotes,
        });
        const nonCanonical = `  ${addr.toUpperCase()}  `;
        await db.records.update(dupId, {
          inputString: nonCanonical,
          inputStringLower: nonCanonical.toLowerCase(),
        });
        const stored = await db.records.get(dupId);
        return {
          keeperId,
          dupId,
          dupStored: stored?.inputString ?? null,
          dupTags: stored?.tags ?? [],
          dupNotes: stored?.notes ?? '',
        };
      },
      { addr: ADDR, dupLabel: DUP_LABEL, dupTag: DUP_TAG, dupNotes: DUP_NOTES, keepLabel: KEEP_LABEL },
    );
    const seedOk =
      seed.dupStored === `  ${ADDR.toUpperCase()}  ` &&
      seed.dupTags.includes(DUP_TAG) &&
      seed.dupNotes === DUP_NOTES;
    steps.push({
      name: 'seeded one collision group (keeper + metadata-bearing duplicate)',
      passed: seedOk,
      detail: `keeperId=${seed.keeperId} dupId=${seed.dupId} dupStored=${JSON.stringify(seed.dupStored)}`,
    });
    if (!seedOk) throw new Error('seeding failed; aborting');

    // ── Run the health check ────────────────────────────────────────────────
    await page.goto(DOCTOR_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    await page.getByTestId('button-run-check').click();

    const card = page.getByTestId('card-duplicate-identifiers');
    const cardVisible = await card
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'health check surfaces the Duplicate identifier records card',
      passed: cardVisible,
      detail: cardVisible ? 'card visible after scan' : 'card never appeared',
    });
    if (!cardVisible) throw new Error('duplicate card missing; aborting');

    // ── Open the Resolve… dialog ────────────────────────────────────────────
    await page.getByTestId('button-resolve-duplicate-0').click();
    const dialog = page.getByTestId('dialog-resolve-duplicate');
    await dialog.waitFor({ state: 'visible', timeout: 30_000 });

    // Both records render as radio options (records load async in the dialog).
    const keeperRadio = page.getByTestId(`radio-keeper-${seed.keeperId}`);
    const dupRadio = page.getByTestId(`radio-keeper-${seed.dupId}`);
    await keeperRadio.waitFor({ state: 'visible', timeout: 30_000 });
    await dupRadio.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'Resolve dialog opens with both group records as radio options',
      passed: true,
      detail: `radio-keeper-${seed.keeperId} and radio-keeper-${seed.dupId} visible`,
    });

    // ── Select the keeper explicitly (real Radix RadioGroup interaction) ────
    await keeperRadio.click();
    const keeperChecked = await keeperRadio.getAttribute('data-state');
    steps.push({
      name: 'clicking the keeper radio selects it',
      passed: keeperChecked === 'checked',
      detail: `radio data-state=${JSON.stringify(keeperChecked)}`,
    });

    // ── Lost-metadata preview lists the duplicate's label/tags/notes ────────
    const lostBox = page.getByTestId('text-resolve-lost-metadata');
    const lostVisible = await lostBox
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const lostText = lostVisible ? ((await lostBox.textContent()) ?? '') : '';
    steps.push({
      name: "lost-metadata preview shows the duplicate's label, tag, and notes",
      passed:
        lostVisible &&
        lostText.includes(DUP_LABEL) &&
        lostText.includes(DUP_TAG) &&
        lostText.includes(DUP_NOTES),
      detail: lostVisible ? `preview text=${JSON.stringify(lostText)}` : 'preview never appeared',
    });

    // ── Confirm button names the right record ids ───────────────────────────
    const confirmBtn = page.getByTestId('button-resolve-confirm');
    const confirmText = ((await confirmBtn.textContent()) ?? '').trim();
    steps.push({
      name: 'confirm button says it deletes 1 record and keeps the keeper id',
      passed: confirmText.includes('Delete 1 record') && confirmText.includes(`#${seed.keeperId}`),
      detail: `button text=${JSON.stringify(confirmText)}`,
    });

    // ── Confirm the delete ──────────────────────────────────────────────────
    await confirmBtn.click();

    // Toast text duplicates into aria-live; use .first() (Radix + Playwright
    // strict mode).
    const toast = page.getByText('Duplicate resolved').first();
    const toastVisible = await toast
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: '"Duplicate resolved" toast appears after confirming',
      passed: toastVisible,
      detail: toastVisible ? 'toast visible' : 'toast never appeared',
    });

    // Dialog closes and the group row disappears from the card immediately
    // (no re-scan needed).
    const dialogGone = await dialog
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const groupGone = await page
      .getByTestId('duplicate-group-0')
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'dialog closes and the resolved group disappears from the card',
      passed: dialogGone && groupGone,
      detail: `dialogGone=${dialogGone} groupGone=${groupGone}`,
    });

    // ── Verify IndexedDB: duplicate deleted, keeper intact ──────────────────
    const dbState = await page.evaluate(
      async ({ keeperId, dupId }) => {
        const { db } = await import('/src/lib/database.ts');
        const keeper = await db.records.get(keeperId);
        const dup = await db.records.get(dupId);
        return {
          keeperExists: !!keeper,
          keeperLabel: keeper?.label ?? null,
          keeperInput: keeper?.inputString ?? null,
          dupExists: !!dup,
        };
      },
      { keeperId: seed.keeperId, dupId: seed.dupId },
    );
    steps.push({
      name: 'IndexedDB: redundant record deleted, keeper survives with its metadata',
      passed:
        !dbState.dupExists &&
        dbState.keeperExists &&
        dbState.keeperLabel === KEEP_LABEL &&
        dbState.keeperInput === ADDR,
      detail: JSON.stringify(dbState),
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

  console.log(`[dbdoctor-resolve-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dbdoctor-resolve-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dbdoctor-resolve-browser] PASSED: the guided duplicate Resolve dialog deletes the redundant record, keeps the chosen keeper, and clears the group from the card in a real browser.',
  );
}

main().catch((err) => {
  console.error('[dbdoctor-resolve-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
