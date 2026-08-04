#!/usr/bin/env node
// Real-browser regression guard for the suspected-poisoning copy guard on
// AddressLink (client/src/components/AddressLink.tsx), rendered on the live
// Transactions page (client/src/pages/Transactions.tsx).
//
// The jsdom unit tests (AddressLink.poisoningGuard.test.tsx) mock the toast
// hook, the record-preview context, and the metadata-hover cache, so they
// cannot catch: the destructive Radix toast failing to render under Trusted
// Types in a real DOM, the red ShieldAlert icon not actually painting, or the
// real clipboard write being blocked. This script drives a REAL headless
// Chromium against the running dev server:
//
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds, via the LIVE Vite module singletons, an owned address record
//      tagged "suspected-poisoning" plus a transaction whose input is that
//      address (recordId set => the tx is user-curated and visible on the
//      default Transactions list) and whose output is a clean counterparty
//   3. reloads /transactions ONCE (the page's liveQuery picks curated txs up
//      on mount, not from runtime dynamic-import writes), expands the card,
//      and asserts the red shield icon is visible next to the tagged address
//   4. clicks the copy button ONCE and asserts the destructive
//      "Suspected address-poisoning address" toast renders, the copy button
//      flips to the armed ShieldAlert icon, and NOTHING was copied
//   5. clicks the copy button AGAIN and asserts the "Address copied" toast
//      renders and the real clipboard now holds the exact address
//   6. control: the clean counterparty address copies on the FIRST click with
//      no warning toast
//
// NOTE for reviewers: the two-step guard lives in AddressLink.tsx
// (handleCopy + copyArmed state); the tag predicate is
// isSuspectedPoisoningTag in client/src/lib/address-poisoning.ts. The
// Transactions page renders AddressLink for each expanded participant row.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-poisoning-copy-guard-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}transactions`;
const SETUP_PASSWORD = 'poisoning-copy-guard-123';

// Fake-but-plausible identifiers. The two addresses MUST differ in their
// first 8 characters: AddressLink testids are keyed on address.slice(0, 8).
const POISONED_ADDR = 'bc1qbadlookalike00000000000000000000wxyz';
const CLEAN_ADDR = 'bc1qcleancounterparty000000000000000abcd';
const POISON_TAG = 'suspected-poisoning';
const TXID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const POISONED_ID = POISONED_ADDR.slice(0, 8);
const CLEAN_ID = CLEAN_ADDR.slice(0, 8);

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

/**
 * Handle the auth screen if it is showing: fills the password (and the
 * confirm field when this is the first-run setup form) and submits. No-op
 * when the app is already unlocked.
 */
async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const showing = await pwInput
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!showing) {
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

/**
 * The legacy-migration overlay (z-index 9999) can appear right after unlock
 * and intercepts all pointer events while visible. Wait it out / dismiss it.
 */
async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[poisoning-copy-guard-browser] legacy-migration overlay detected; waiting it out ...');
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

/** chromium.launch can EAGAIN under parallel validation load — retry. */
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
      console.log(`[poisoning-copy-guard-browser] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function readClipboard(page) {
  return page
    .evaluate(() => navigator.clipboard.readText())
    .catch(() => '');
}

async function main() {
  const exe = resolveChromium();
  console.log(`[poisoning-copy-guard-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[poisoning-copy-guard-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[poisoning-copy-guard-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[poisoning-copy-guard-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    // Fresh context => empty IndexedDB => first load shows the vault setup
    // form. Block the PWA service worker so it cannot serve a stale bundle.
    // Grant clipboard permissions so we can assert against the REAL clipboard.
    const context = await browser.newContext({
      serviceWorkers: 'block',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (msg.type() === 'error' || t.toLowerCase().includes('buffer is not defined')) {
        console.log(`[poisoning-copy-guard-browser][page-console] ${t}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    let landed = false;
    for (let i = 0; i < 3 && !landed; i++) {
      landed = await page
        .goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!landed) await page.waitForTimeout(3000);
    }
    if (!landed) throw new Error(`Could not load ${PAGE_URL}`);
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed via the LIVE Vite singletons ───────────────────────────────────
    // Owned input record (user-curated `manual` tier) tagged
    // suspected-poisoning => the tx is visible on the default Transactions
    // list AND the AddressLink guard has a tagged record to resolve.
    const seed = await page.evaluate(
      async ({ poisoned, clean, tag, txid }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: poisoned,
          label: 'Suspected poisoning lookalike',
          tags: [tag],
        });
        await txCrud.addTransaction({
          txid,
          blockHeight: 800000,
          blockTime: Math.floor(Date.now() / 1000) - 86400,
          fee: 210,
          feeRate: 1,
          syncedAt: Date.now(),
        });
        await txCrud.addParticipant({
          txid,
          role: 'input',
          address: poisoned,
          amount: 15000,
          vout: 0,
          recordId,
        });
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: clean,
          amount: 12000,
          vout: 0,
        });
        return { recordId };
      },
      { poisoned: POISONED_ADDR, clean: CLEAN_ADDR, tag: POISON_TAG, txid: TXID },
    );
    steps.push({
      name: 'seeded suspected-poisoning record + curated transaction',
      passed: Number.isInteger(seed.recordId) && seed.recordId > 0,
      detail: `recordId=${seed.recordId}`,
    });

    // ── Reload once so the page picks the curated tx up on mount ────────────
    // (The page's liveQuery does not react to writes from dynamically
    // imported singletons; the one reload happens BEFORE the link renders.)
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const card = page.getByTestId(`card-transaction-${TXID.slice(0, 8)}`);
    await card.waitFor({ state: 'visible', timeout: 60_000 });

    // Expand the card so the participant AddressLinks render.
    await page.getByTestId('button-expand-collapse-all').click();
    const poisonedLink = page.getByTestId(`link-address-${POISONED_ID}`);
    await poisonedLink.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({ name: 'transaction card renders and expands', passed: true, detail: 'participant links visible' });

    // ── Red shield icon on the tagged address, none on the clean one ────────
    // The icon renders once the metadata-hover cache resolves the record
    // (preload or hover). Hover the link to trigger the tooltip resolve path
    // — this also exercises the tooltip's red warning text in a real DOM.
    await poisonedLink.hover();
    const tooltipWarn = await page
      .getByTestId('text-poisoning-warning')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const shieldIcon = page.getByTestId(`icon-poisoning-warning-${POISONED_ID}`);
    const shieldVisible = await shieldIcon
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const cleanShieldCount = await page
      .locator(`[data-testid="icon-poisoning-warning-${CLEAN_ID}"]`)
      .count();
    steps.push({
      name: 'tooltip warning text + red ShieldAlert icon render on the tagged address only',
      passed: tooltipWarn && shieldVisible && cleanShieldCount === 0,
      detail: `tooltip warning=${tooltipWarn}, tagged shield visible=${shieldVisible}, clean shields=${cleanShieldCount}`,
    });
    // Move the pointer away so the tooltip closes before the copy clicks.
    await page.mouse.move(0, 0);

    // ── First copy click: destructive warning toast, NO copy, armed icon ────
    await page.evaluate(() => navigator.clipboard.writeText('sentinel-before-copy'));
    const copyBtn = page.getByTestId(`button-copy-address-${POISONED_ID}`);
    await copyBtn.click();

    // Radix toast text also duplicates into an aria-live region — use .first().
    const warnToast = page.getByText('Suspected address-poisoning address').first();
    const warnVisible = await warnToast
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const warnBody = await page
      .getByText('Click copy again to copy anyway', { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    const clipboardAfterFirst = await readClipboard(page);
    const armedIcon = await copyBtn
      .locator('svg.lucide-shield-alert')
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'first copy click shows the destructive warning toast and copies NOTHING',
      passed:
        warnVisible &&
        warnBody &&
        clipboardAfterFirst === 'sentinel-before-copy' &&
        armedIcon,
      detail: `toast=${warnVisible}, body=${warnBody}, clipboard=${JSON.stringify(clipboardAfterFirst)}, armed shield icon=${armedIcon}`,
    });

    // ── Second copy click (within the 6s arm window): copies for real ───────
    await copyBtn.click();
    const copiedToast = page.getByText('Address copied').first();
    const copiedVisible = await copiedToast
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const clipboardAfterSecond = await readClipboard(page);
    steps.push({
      name: 'second copy click copies the address to the real clipboard',
      passed: copiedVisible && clipboardAfterSecond === POISONED_ADDR,
      detail: `toast=${copiedVisible}, clipboard=${JSON.stringify(clipboardAfterSecond)}`,
    });

    // ── Control: the clean counterparty copies on the FIRST click ───────────
    await page.evaluate(() => navigator.clipboard.writeText('sentinel-clean'));
    // Give any prior toasts a moment to auto-dismiss layering, then count
    // warning toasts before/after to prove no new warning appears.
    const warnCountBefore = await page.getByText('Suspected address-poisoning address').count();
    await page.getByTestId(`button-copy-address-${CLEAN_ID}`).click();
    const clipboardClean = await page
      .waitForFunction(
        (expected) => navigator.clipboard.readText().then((t) => t === expected),
        CLEAN_ADDR,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    const warnCountAfter = await page.getByText('Suspected address-poisoning address').count();
    steps.push({
      name: 'clean address copies on the first click with no warning toast',
      passed: clipboardClean && warnCountAfter <= warnCountBefore,
      detail: `copied=${clipboardClean}, warning toasts before=${warnCountBefore} after=${warnCountAfter}`,
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

  console.log(`[poisoning-copy-guard-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[poisoning-copy-guard-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[poisoning-copy-guard-browser] PASSED: shield icon, destructive warning toast, two-step copy, and clean-address control all work end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[poisoning-copy-guard-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
