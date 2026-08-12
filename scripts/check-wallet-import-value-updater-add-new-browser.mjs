#!/usr/bin/env node
// Real-browser regression guard for the page-local "Add new" vocabulary
// buttons on Wallet Import and the Value Updater (task: both surfaces call
// ensureSelectableVocabularyEntry directly — a case-insensitive duplicate
// must SELECT the existing canonical entry instead of surfacing a
// destructive error toast or creating a duplicate row).
//
// NOTE for reviewers: the components under test are
//   - client/src/pages/WalletImport.tsx (route /wallet-import): the setup
//     step's Owner popover ("select-owner") with its own inline Add "<name>"
//     CommandItem calling addNewOwner -> ensureSelectableVocabularyEntry.
//   - client/src/pages/ValueUpdaterPage.tsx (route /value-updater): the
//     per-field "Add New" header button (button-add-walletName /
//     input-new-walletName / button-save-new-walletName) calling
//     handleAddItem -> ensureSelectableVocabularyEntry.
// The tolerant helper is ensureSelectableVocabularyEntry in
// client/src/lib/data/vocabulary-crud.ts.
//
// Wallet Import needs the held-Dexie-transaction trick (like
// check-vocab-combobox-duplicate-select-browser.mjs): its inline Add item is
// hidden whenever the useOwners() options list already contains a
// case-insensitive match, so the duplicate-create path only fires when the
// DB row exists while the options list is stale. The Value Updater's "Add
// New" button is always available, so there a plain committed duplicate is
// exercised.
//
// Flow:
//   1. fresh vault; /wallet-import; upload a BIP-329 .jsonl fixture; Next ->
//      setup step (Ownership section renders the Owner popover)
//   2. arm: insert canonical owner "Alice Cold" in a HELD (uncommitted) rw
//      transaction; type "alice cold" in the Owner popover; click its
//      Add "alice cold" item; release the transaction
//   3. assert the Owner trigger shows the canonical "Alice Cold", the
//      popover closed, NO destructive error toast, exactly ONE owners row
//   4. /value-updater; seed committed walletName "Ledger Main"; Wallet Name
//      tab -> Add New -> type "ledger main" -> Add
//   5. assert the success toast names the CANONICAL "Ledger Main", no
//      destructive "Creation Failed" toast, the inline add form closed, and
//      exactly ONE walletNames row exists
//
// Usage: node scripts/check-wallet-import-value-updater-add-new-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'addnew-dup-select-check-123';

const CANONICAL_OWNER = 'Alice Cold';
const DUP_OWNER_INPUT = 'alice cold'; // same name, different case
const CANONICAL_WALLET = 'Ledger Main';
const DUP_WALLET_INPUT = 'ledger main';

const BIP329_FIXTURE = [
  '{"type":"addr","ref":"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4","label":"Fixture addr one"}',
  '{"type":"addr","ref":"bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3","label":"Fixture addr two"}',
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
  console.log('[addnew-dup-select-browser] legacy-migration overlay detected; waiting it out ...');
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
      console.log(`[addnew-dup-select-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[addnew-dup-select-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[addnew-dup-select-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[addnew-dup-select-browser] starting dev server (npm run dev) ...');
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
        console.log(`[addnew-dup-select-browser][page-console] ${msg.text()}`);
      }
    });

    // ══ Part A: Wallet Import Owner "Add new" ══════════════════════════════
    await page.goto(`${BASE_URL}wallet-import`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked on /wallet-import', passed: true, detail: 'setup form submitted' });

    // Upload a BIP-329 .jsonl fixture and advance to the setup step (the
    // Ownership section with the Owner popover only renders there).
    const fileInput = page.getByTestId('input-file-upload');
    await fileInput.waitFor({ state: 'attached', timeout: 30_000 });
    await fileInput.setInputFiles({
      name: 'labels.jsonl',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(BIP329_FIXTURE, 'utf8'),
    });
    const detectedToast = page.getByText('File loaded').first();
    const detected = await detectedToast
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    await page.getByTestId('button-next-step').click();
    const ownerTrigger = page.getByTestId('select-owner');
    const setupShown = await ownerTrigger
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'BIP-329 fixture uploaded and setup step reached (Owner popover rendered)',
      passed: detected && setupShown,
      detail: `fileLoadedToast=${detected}, ownerTriggerVisible=${setupShown}`,
    });
    if (!setupShown) throw new Error('setup step did not render the Owner popover');

    // Arm the duplicate deterministically: insert the canonical owner row in
    // a HELD (uncommitted) rw transaction. The page's useOwners() liveQuery
    // cannot observe it (Dexie mutation events fire on commit), so the
    // popover's options list stays empty and its inline Add item remains
    // visible for the duplicate input; addNewOwner's createOwner read queues
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

    // Type the different-case duplicate and click the inline Add item.
    await ownerTrigger.click();
    const ownerSearch = page.getByPlaceholder('Search or add new...').first();
    await ownerSearch.waitFor({ state: 'visible', timeout: 10_000 });
    await ownerSearch.fill(DUP_OWNER_INPUT);
    const addItem = page.getByText(`Add "${DUP_OWNER_INPUT}"`).first();
    await addItem.waitFor({ state: 'visible', timeout: 10_000 });
    await addItem.click();
    steps.push({ name: `clicked Add "${DUP_OWNER_INPUT}" while the canonical row was pending commit`, passed: true, detail: 'addNewOwner queued behind the held tx' });

    // Release: the canonical row commits ahead of the queued createOwner.
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

    // Assert: popover closed and the trigger shows the CANONICAL casing.
    const popoverClosed = await ownerSearch
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const triggerText = (await ownerTrigger.innerText()).trim();
    const errorToastVisible = await page.getByText('Failed to add owner').first().isVisible().catch(() => false);
    steps.push({
      name: 'Wallet Import: popover closed, Owner shows the existing canonical value, no destructive toast',
      passed: popoverClosed && triggerText === CANONICAL_OWNER && !errorToastVisible,
      detail: `popoverClosed=${popoverClosed}, triggerText=${JSON.stringify(triggerText)} (expected ${JSON.stringify(CANONICAL_OWNER)}), errorToastVisible=${errorToastVisible}`,
    });

    const ownersState = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      return (await db.owners.toArray()).map((r) => r.name);
    });
    steps.push({
      name: 'vocabulary has exactly one owner row with the canonical casing',
      passed: ownersState.length === 1 && ownersState[0] === CANONICAL_OWNER,
      detail: JSON.stringify(ownersState),
    });

    // ══ Part B: Value Updater walletName "Add New" ═════════════════════════
    await page.goto(`${BASE_URL}value-updater`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    // Seed the committed canonical wallet name (the Value Updater's Add New
    // button is always available, so a plain committed duplicate suffices).
    const seeded = await page.evaluate(async ({ canonical }) => {
      const vocab = await import('/src/lib/data/vocabulary-crud.ts');
      await vocab.createWalletName(canonical);
      const { db } = await import('/src/lib/database.ts');
      return { rows: (await db.walletNames.toArray()).map((r) => r.name) };
    }, { canonical: CANONICAL_WALLET });
    steps.push({
      name: 'canonical wallet name seeded (committed) on /value-updater',
      passed: seeded.rows.length === 1 && seeded.rows[0] === CANONICAL_WALLET,
      detail: JSON.stringify(seeded),
    });

    const walletTab = page.getByTestId('tab-walletName');
    await walletTab.waitFor({ state: 'visible', timeout: 30_000 });
    await walletTab.click();
    const addBtn = page.getByTestId('button-add-walletName');
    await addBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await addBtn.click();
    const newInput = page.getByTestId('input-new-walletName');
    await newInput.waitFor({ state: 'visible', timeout: 10_000 });
    await newInput.fill(DUP_WALLET_INPUT);
    await page.getByTestId('button-save-new-walletName').click();
    steps.push({ name: `clicked Add with the different-case duplicate "${DUP_WALLET_INPUT}"`, passed: true, detail: 'handleAddItem invoked' });

    // Assert: success toast names the CANONICAL value; no destructive toast.
    const successToast = page.getByText(`"${CANONICAL_WALLET}" has been created`).first();
    const failToast = page.getByText('Creation Failed').first();
    const outcome = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'success'),
      failToast.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'error'),
    ]).catch(() => 'timeout');
    const failVisible = await failToast.isVisible().catch(() => false);
    // The inline add form closes on success (setNewItemField(null)).
    const formClosed = await newInput
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'Value Updater: success toast names the CANONICAL value, no "Creation Failed" toast, add form closed',
      passed: outcome === 'success' && !failVisible && formClosed,
      detail: `outcome=${outcome}, failToastVisible=${failVisible}, formClosed=${formClosed}`,
    });

    const walletState = await page.evaluate(async () => {
      const { db } = await import('/src/lib/database.ts');
      return (await db.walletNames.toArray()).map((r) => r.name);
    });
    steps.push({
      name: 'vocabulary has exactly one wallet-name row with the canonical casing',
      passed: walletState.length === 1 && walletState[0] === CANONICAL_WALLET,
      detail: JSON.stringify(walletState),
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

  console.log(`[addnew-dup-select-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[addnew-dup-select-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[addnew-dup-select-browser] PASSED: the Wallet Import Owner "Add new" and Value Updater "Add New" paths both selected the existing canonical entry on a case-insensitive duplicate (no destructive toast, no duplicate vocabulary row).',
  );
}

main().catch((err) => {
  console.error('[addnew-dup-select-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
