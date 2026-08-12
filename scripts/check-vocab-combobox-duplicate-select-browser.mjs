#!/usr/bin/env node
// Real-browser regression guard for the interactive "Add new" duplicate-select
// behavior in VocabularyCombobox (task: handleCreateNew must use
// ensureSelectableVocabularyEntry so a case-insensitive duplicate SELECTS the
// existing canonical entry instead of surfacing a destructive error toast).
//
// NOTE for reviewers: the component under test is
// client/src/components/VocabularyCombobox.tsx, exercised on the Bulk Editor
// page (route /bulk-editor, client/src/pages/BulkEditor.tsx renders it for
// update-action values on vocabulary fields like Owner / Seed Name); the
// tolerant helper is ensureSelectableVocabularyEntry in
// client/src/lib/data/vocabulary-crud.ts.
//
// Why a held Dexie transaction: the combobox hides its Create item whenever
// the (liveQuery-fed) options list already contains a case-insensitive match,
// so the duplicate-create path only fires when the DB row exists while the
// options list is stale. We reproduce that deterministically:
//   1. fresh vault; /bulk-editor; add an update action (field = Owner)
//   2. arm: insert canonical owner "Alice Cold" inside a HELD (uncommitted)
//      rw transaction — the page's useOwners() liveQuery cannot see it
//   3. type the different-case duplicate "alice cold" in the combobox and
//      click its Create item; ensureSelectableVocabularyEntry's createOwner
//      read queues behind the held transaction
//   4. release: the canonical row commits first, createOwner then throws
//      "already exists", the helper resolves the existing row and returns
//      its canonical name
//   5. assert the combobox now shows "Alice Cold" (canonical case), the
//      popover closed, the success toast appeared, NO destructive
//      "Creation failed" toast, and exactly ONE owners row exists
//   6. over-length guard still works: switch the action field to Seed Name,
//      type a 16-char name, click Create — the destructive validation toast
//      ("limited to 15 characters") must appear, the popover stays open,
//      and no seedNames row is created.
//
// Usage: node scripts/check-vocab-combobox-duplicate-select-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}bulk-editor`;
const SETUP_PASSWORD = 'vocab-dup-select-check-123';

const CANONICAL_OWNER = 'Alice Cold';
const DUP_INPUT = 'alice cold'; // same name, different case
const LONG_SEED_NAME = 'abcdefghijklmnop'; // 16 chars > SEED_NAME_MAX_LENGTH (15)

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
  console.log('[vocab-dup-select-browser] legacy-migration overlay detected; waiting it out ...');
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
    .waitFor({ state: 'visible', timeout: 15_000 })
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
      console.log(`[vocab-dup-select-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[vocab-dup-select-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[vocab-dup-select-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[vocab-dup-select-browser] starting dev server (npm run dev) ...');
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
    const pageErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        pageErrors.push(msg.text());
        console.log(`[vocab-dup-select-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault and land on the Bulk Editor ────────────────────────
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked on /bulk-editor', passed: true, detail: 'setup form submitted' });

    // ── Add an update action (default field = Owner) ────────────────────────
    const addActionBtn = page.getByTestId('button-add-action');
    await addActionBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await addActionBtn.click();
    const ownerCombobox = page.getByTestId('combobox-value-owner');
    await ownerCombobox.waitFor({ state: 'visible', timeout: 10_000 });
    steps.push({ name: 'update action added; Owner value combobox rendered', passed: true, detail: 'combobox-value-owner visible' });

    // ── Arm the duplicate deterministically ────────────────────────────────
    // Insert the canonical owner row inside a HELD (uncommitted) rw
    // transaction: the page's useOwners() liveQuery cannot observe it (Dexie
    // mutation events fire on commit), so the combobox options list stays
    // empty and its Create item remains visible for the duplicate input;
    // meanwhile ensureSelectableVocabularyEntry's createOwner read queues
    // behind the open transaction and, once released, sees the committed
    // canonical row => the exact case-insensitive duplicate under test.
    const armed = await page.evaluate(async ({ canonical }) => {
      const { db } = await import('/src/lib/database.ts');
      const Dexie = db.constructor;
      let inserted;
      const insertedP = new Promise((res) => { inserted = res; });
      window.__dupTxRelease = null;
      const release = new Promise((res) => { window.__dupTxRelease = res; });
      window.__dupTxDone = db.transaction('rw', db.owners, async () => {
        const id = await db.owners.add({ name: canonical, createdAt: Date.now() });
        inserted(id);
        await Dexie.waitFor(release);
      });
      window.__dupTxDone.catch(() => {});
      const dupId = await insertedP;
      return { ok: typeof dupId === 'number', dupId };
    }, { canonical: CANONICAL_OWNER });
    steps.push({
      name: 'duplicate armed: canonical owner row inserted in a held (uncommitted) Dexie transaction',
      passed: armed.ok === true,
      detail: JSON.stringify(armed),
    });
    if (!armed.ok) throw new Error(`arming failed: ${JSON.stringify(armed)}`);

    // ── Type the different-case duplicate and click its Create item ────────
    await ownerCombobox.click();
    const ownerInput = page.getByTestId('input-combobox-owner');
    await ownerInput.waitFor({ state: 'visible', timeout: 10_000 });
    await ownerInput.fill(DUP_INPUT);
    const createOwnerItem = page.getByTestId('option-create-new-owner');
    await createOwnerItem.waitFor({ state: 'visible', timeout: 10_000 });
    await createOwnerItem.click();
    steps.push({ name: `clicked Create "${DUP_INPUT}" while the canonical row was pending commit`, passed: true, detail: 'handleCreateNew queued behind the held tx' });

    // ── Release: the canonical row commits ahead of the queued createOwner ──
    const released = await page.evaluate(async () => {
      window.__dupTxRelease();
      await window.__dupTxDone;
      return { ok: true };
    });
    steps.push({
      name: 'transaction released: canonical row committed ahead of the queued duplicate create',
      passed: released.ok === true,
      detail: JSON.stringify(released),
    });

    // ── Assert: existing canonical value selected, popover closed, no error ─
    const destructiveToast = page.getByText('Creation failed').first();
    const successToast = page.getByText(`"${CANONICAL_OWNER}" has been added`).first();
    const outcome = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'success'),
      destructiveToast.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'error'),
    ]).catch(() => 'timeout');
    const destructiveVisible = await destructiveToast.isVisible().catch(() => false);
    steps.push({
      name: 'success toast names the CANONICAL value and no destructive "Creation failed" toast appeared',
      passed: outcome === 'success' && !destructiveVisible,
      detail: `outcome=${outcome}, destructiveToastVisible=${destructiveVisible}`,
    });

    // Popover must have closed (the Command input unmounts with it).
    const popoverClosed = await ownerInput
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    // The combobox trigger must show the canonical stored casing, not the
    // lowercase duplicate the user typed.
    const triggerText = (await ownerCombobox.innerText()).trim();
    steps.push({
      name: 'popover closed and the combobox shows the existing canonical value',
      passed: popoverClosed && triggerText === CANONICAL_OWNER,
      detail: `popoverClosed=${popoverClosed}, triggerText=${JSON.stringify(triggerText)} (expected ${JSON.stringify(CANONICAL_OWNER)})`,
    });

    // Exactly one owners row, canonical casing (no duplicate row created).
    const ownersState = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      const rows = await db.owners.toArray();
      return rows.map((r) => r.name);
    });
    steps.push({
      name: 'vocabulary has exactly one owner row with the canonical casing',
      passed: ownersState.length === 1 && ownersState[0] === CANONICAL_OWNER,
      detail: JSON.stringify(ownersState),
    });

    // ── Over-length seed name must still surface the validation toast ──────
    // Switch the same action's field to Seed Name via the Radix select.
    await page.getByTestId('select-action-field-0').click();
    await page.getByRole('option', { name: 'Seed Name', exact: true }).click();
    const seedCombobox = page.getByTestId('combobox-value-seedName');
    await seedCombobox.waitFor({ state: 'visible', timeout: 10_000 });
    await seedCombobox.click();
    const seedInput = page.getByTestId('input-combobox-seedName');
    await seedInput.waitFor({ state: 'visible', timeout: 10_000 });
    await seedInput.fill(LONG_SEED_NAME);
    const createSeedItem = page.getByTestId('option-create-new-seedName');
    await createSeedItem.waitFor({ state: 'visible', timeout: 10_000 });
    await createSeedItem.click();

    const seedToast = page.getByText('limited to 15 characters', { exact: false }).first();
    const seedToastShown = await seedToast
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const seedFailTitle = await page.getByText('Creation failed').first().isVisible().catch(() => false);
    // The popover must stay open on a validation error (handleCreateNew only
    // closes it on success).
    const seedPopoverStillOpen = await seedInput.isVisible().catch(() => false);
    steps.push({
      name: 'over-length seed name surfaced the destructive validation toast and kept the popover open',
      passed: seedToastShown && seedFailTitle && seedPopoverStillOpen,
      detail: `toastShown=${seedToastShown}, failTitle=${seedFailTitle}, popoverOpen=${seedPopoverStillOpen}`,
    });

    const seedRows = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      return (await db.seedNames.toArray()).map((r) => r.name);
    });
    steps.push({
      name: 'no seedNames row was created for the rejected over-length name',
      passed: seedRows.length === 0,
      detail: JSON.stringify(seedRows),
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

  console.log(`[vocab-dup-select-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[vocab-dup-select-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[vocab-dup-select-browser] PASSED: the VocabularyCombobox "Add new" path selected the existing canonical entry on a case-insensitive duplicate (popover closed, no destructive toast, no duplicate row), and the over-length seed-name validation toast still fires.',
  );
}

main().catch((err) => {
  console.error('[vocab-dup-select-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
