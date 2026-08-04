#!/usr/bin/env node
// Real-browser regression guard for Quick Tagger's bulk apply surviving an
// already-existing vocabulary tag (task: applyMetadata must use the tolerant
// ensure* helpers, never strict create*).
//
// NOTE for reviewers: the page under test is client/src/pages/QuickTagger.tsx
// (route /quick-tagger); the tolerant helpers live in
// client/src/lib/data/vocabulary-crud.ts (ensureTag et al.).
//
// The original bug class (strict createTag throwing "Tag already exists" and
// aborting the whole bulk apply) only reproduces when the page's useTags()
// liveQuery list LAGS the DB: applyMetadata checks `existingTagNames` (the
// stale hook list) and calls ensureTag for any selected tag missing from it —
// even when the tag row already exists in Dexie. jsdom unit tests cover
// ensure* tolerance, but not the live wiring (liveQuery timing, cmdk
// combobox, Radix popovers/toasts) a real browser exercises.
//
// Deterministic duplicate setup (no sleep-based racing):
//   1. fresh vault; seed TWO address records via dynamic import
//   2. /quick-tagger: paste both addresses, Parse, Continue to metadata
//   3. add "brand-new-tag" through the tags combobox UI (genuinely new tag)
//   4. in ONE page.evaluate: await creating "dup-tag" directly in Dexie
//      (vocabulary-crud), then SYNCHRONOUSLY (same task, before any liveQuery
//      re-render can land — its re-query needs an async IDB roundtrip) click
//      the combobox's Add "dup-tag" item (selects the tag; the stale options
//      list can't contain it) and then the Apply Metadata button. At that
//      moment applyMetadata's `existingTagNames` closure cannot contain
//      "dup-tag" while the DB row already exists => ensureTag runs against a
//      duplicate. Strict createTag would throw and abort the run.
//   5. assert the success toast ("Metadata applied", Updated 2 records), NO
//      destructive "Error applying metadata" toast, the complete step, both
//      records carrying both tags in Dexie, and exactly ONE dup-tag row.
//
// Usage: node scripts/check-quick-tagger-duplicate-tag-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}quick-tagger`;
const SETUP_PASSWORD = 'quick-tagger-dup-check-123';

// Known-valid mainnet bech32 addresses (validateBitcoinInput checks checksums).
const ADDR_A = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const ADDR_B = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const DUP_TAG = 'dup-tag';
const NEW_TAG = 'brand-new-tag';

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
  console.log('[quick-tagger-dup-browser] legacy-migration overlay detected; waiting it out ...');
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
      console.log(`[quick-tagger-dup-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[quick-tagger-dup-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[quick-tagger-dup-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[quick-tagger-dup-browser] starting dev server (npm run dev) ...');
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
        console.log(`[quick-tagger-dup-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: two existing address records (bulk apply's update path) ──────
    const seed = await page.evaluate(
      async ({ a, b }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        // Explicit empty tags/categories: this check targets the duplicate-tag
        // path, not the separate records-saved-without-tags crash class.
        const idA = await recordCrud.createRecord({ type: 'address', inputString: a, label: 'Seeded A', tags: [], categories: [] });
        const idB = await recordCrud.createRecord({ type: 'address', inputString: b, label: 'Seeded B', tags: [], categories: [] });
        return { idA, idB };
      },
      { a: ADDR_A, b: ADDR_B },
    );
    steps.push({
      name: 'seed: two existing address records created via Dexie',
      passed: typeof seed.idA === 'number' && typeof seed.idB === 'number',
      detail: JSON.stringify(seed),
    });

    // ── Paste both addresses, Parse, Continue to the metadata step ─────────
    await page.getByTestId('textarea-paste-input').fill(`${ADDR_A}\n${ADDR_B}`);
    await page.getByTestId('button-parse-entries').click();
    const continueBtn = page.getByTestId('button-continue-to-metadata');
    await continueBtn.waitFor({ state: 'visible', timeout: 30_000 });
    // Both entries must be recognized as existing records ("Exists" badges).
    const existsBadges = await page.getByText('Exists', { exact: true }).count();
    steps.push({
      name: 'review step shows both pasted addresses as existing records',
      passed: existsBadges === 2,
      detail: `Exists badges=${existsBadges}`,
    });
    await continueBtn.click();
    const applyBtn = page.getByTestId('button-apply-metadata');
    await applyBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Add the genuinely-new tag through the combobox UI ──────────────────
    const tagsCombobox = page.getByRole('combobox').filter({ hasText: 'Select or create tags' }).first();
    await tagsCombobox.click();
    const searchInput = page.getByPlaceholder('Search or add new...');
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
    await searchInput.fill(NEW_TAG);
    await page.getByText(`Add "${NEW_TAG}"`).first().click();
    steps.push({ name: `selected new tag "${NEW_TAG}" via combobox Add`, passed: true, detail: 'onAddNew path' });

    // ── Arm the duplicate deterministically ────────────────────────────────
    // Open a held rw transaction that inserts the dup-tag row but does NOT
    // commit yet. Until commit, the page's useTags() liveQuery cannot observe
    // the row (Dexie mutation events fire on commit), so applyMetadata's
    // `existingTagNames` list is GUARANTEED to lack the tag; meanwhile any
    // reader (ensureTag's duplicate probe) queues behind the open rw
    // transaction and, once released, sees the committed duplicate row.
    const armed = await page.evaluate(async ({ dupTag }) => {
      const { db } = await import('/src/lib/database.ts');
      const Dexie = db.constructor;
      let inserted;
      const insertedP = new Promise((res) => { inserted = res; });
      window.__dupTxRelease = null;
      const release = new Promise((res) => { window.__dupTxRelease = res; });
      window.__dupTxDone = db.transaction('rw', db.tags, async () => {
        const id = await db.tags.add({ name: dupTag, createdAt: Date.now() });
        inserted(id);
        // Hold the transaction open (uncommitted) until released.
        await Dexie.waitFor(release);
      });
      // Swallow later rejection surfacing as unhandled if something goes wrong.
      window.__dupTxDone.catch(() => {});
      const dupId = await insertedP;
      return { ok: typeof dupId === 'number', dupId };
    }, { dupTag: DUP_TAG });
    steps.push({
      name: 'duplicate armed: dup-tag row inserted in a held (uncommitted) Dexie transaction',
      passed: armed.ok === true,
      detail: JSON.stringify(armed),
    });
    if (!armed.ok) throw new Error(`arming failed: ${JSON.stringify(armed)}`);

    // Select dup-tag in the combobox. The options list cannot contain it
    // (nothing committed), so the Add item is present; onAddNew's own
    // void ensureTag(dup) queues behind the held transaction too.
    await searchInput.fill(DUP_TAG);
    await page.getByText(`Add "${DUP_TAG}"`).first().click();
    // The selected-tag badge renders from React state (no DB involved).
    const dupBadge = page.locator('span, div').filter({ hasText: DUP_TAG }).first();
    await dupBadge.waitFor({ state: 'visible', timeout: 10_000 });

    // Click Apply while the transaction is still held: applyMetadata reads its
    // stale existingTagNames (no dup-tag) and awaits ensureTag(dup-tag), which
    // queues behind the held transaction.
    await applyBtn.click();

    // Now release: the insert commits first, then the queued ensureTag runs
    // against the already-existing row — the exact duplicate the tolerant
    // ensure* helpers must survive (strict createTag would throw and abort).
    const released = await page.evaluate(async () => {
      window.__dupTxRelease();
      await window.__dupTxDone;
      return { ok: true };
    });
    steps.push({
      name: 'transaction released: duplicate row committed ahead of applyMetadata\'s queued ensureTag',
      passed: released.ok === true,
      detail: JSON.stringify(released),
    });

    // ── Assert the run completed (success toast + complete step) ───────────
    // Radix toast text duplicates into aria-live; use .first().
    const successToast = page.getByText('Metadata applied').first();
    const errorToast = page.getByText('Error applying metadata').first();
    const outcome = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'success'),
      errorToast.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'error'),
    ]).catch(() => 'timeout');
    const errorVisible = await errorToast.isVisible().catch(() => false);
    steps.push({
      name: 'bulk apply completed with the success toast and no "Error applying metadata" toast',
      passed: outcome === 'success' && !errorVisible,
      detail: `outcome=${outcome}, errorToastVisible=${errorVisible}`,
    });

    const updatedTwo = await page
      .getByText('Updated 2 records', { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    const completeStep = await page
      .getByTestId('button-tag-more')
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'toast reports "Updated 2 records" and the complete step rendered',
      passed: updatedTwo && completeStep,
      detail: `updatedTwoVisible=${updatedTwo}, completeStep=${completeStep}`,
    });

    // ── Verify in Dexie: both records tagged, exactly one dup-tag row ──────
    const persisted = await page.evaluate(
      async ({ a, b, dupTag, newTag }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');
        const recsA = await recordCrud.getRecordsByInputString(a);
        const recsB = await recordCrud.getRecordsByInputString(b);
        const allTags = await db.tags.toArray();
        return {
          tagsA: recsA[0]?.tags ?? null,
          tagsB: recsB[0]?.tags ?? null,
          dupRows: allTags.filter((t) => t.name.toLowerCase() === dupTag.toLowerCase()).length,
          newRows: allTags.filter((t) => t.name.toLowerCase() === newTag.toLowerCase()).length,
        };
      },
      { a: ADDR_A, b: ADDR_B, dupTag: DUP_TAG, newTag: NEW_TAG },
    );
    const hasBoth = (tags) => Array.isArray(tags) && tags.includes(DUP_TAG) && tags.includes(NEW_TAG);
    steps.push({
      name: 'both records carry both tags; vocabulary has exactly one row per tag (no duplicate rows)',
      passed: hasBoth(persisted.tagsA) && hasBoth(persisted.tagsB) && persisted.dupRows === 1 && persisted.newRows === 1,
      detail: JSON.stringify(persisted),
    });

    const abortErrors = pageErrors.filter((t) => t.includes('already exists'));
    steps.push({
      name: 'no "already exists" errors surfaced in the page console',
      passed: abortErrors.length === 0,
      detail: abortErrors.length ? abortErrors.join(' | ') : 'none',
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

  console.log(`[quick-tagger-dup-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[quick-tagger-dup-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[quick-tagger-dup-browser] PASSED: Quick Tagger bulk apply survived a tag that already existed in the vocabulary (out-of-band Dexie seed) — the run completed, both records were updated with both tags, and no duplicate vocabulary row was created.',
  );
}

main().catch((err) => {
  console.error('[quick-tagger-dup-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
