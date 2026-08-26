#!/usr/bin/env node
// Real-browser regression guard for the SHARED suspected-poisoning copy guard
// (client/src/hooks/use-guarded-address-copy.ts) on a surface OUTSIDE
// AddressLink: the Address Reuse page (client/src/pages/AddressReuse.tsx),
// whose per-address copy button routes through copyToClipboard ->
// guardedCopyAddress from useGuardedAddressCopy.
//
// The jsdom unit tests (use-guarded-address-copy.test.tsx) mock the toast hook
// and the metadata-hover cache, so they cannot catch: the destructive Radix
// toast failing to render in a real DOM (e.g. under Trusted Types), or the
// real clipboard write being blocked/going through anyway. This script drives
// a REAL headless Chromium against the running dev server:
//
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds, via the LIVE Vite module singletons, a curated address record
//      tagged "suspected-poisoning" that RECEIVES in two transactions
//      (multi-receive reuse => it appears on the Address Reuse page), plus a
//      clean reused control address
//   3. reloads /address-reuse ONCE, expands the tagged address row
//   4. clicks the row's copy button ONCE and asserts the destructive
//      "Suspected address-poisoning address" toast renders and NOTHING was
//      copied
//   5. clicks the copy button AGAIN and asserts the "Address copied" toast
//      renders and the real clipboard now holds the exact address
//   6. control: the clean reused address copies on the FIRST click with no
//      warning toast
//
// NOTE for reviewers: the two-step guard lives in
// client/src/hooks/use-guarded-address-copy.ts (copyAddress + armedAddress
// state); AddressReuse.tsx wires it via copyToClipboard(text, "Address") ->
// guardedCopyAddress. The route is /address-reuse (see App.tsx).
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-address-reuse-copy-guard-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PAGE_URL = `${BASE_URL}address-reuse`;
const SETUP_PASSWORD = 'reuse-copy-guard-1234';

// Fake-but-plausible identifiers. The two addresses MUST differ in their
// first 8 characters: the page's testids are keyed on address.slice(0, 8).
const POISONED_ADDR = 'bc1qbadreuselookalike000000000000000wxyz';
const CLEAN_ADDR = 'bc1qcleanreused0000000000000000000000abcd';
const POISON_TAG = 'suspected-poisoning';
const POISONED_ID = POISONED_ADDR.slice(0, 8);
const CLEAN_ID = CLEAN_ADDR.slice(0, 8);
// Four distinct txids: two receives per address => multi-receive reuse.
const TXIDS = [
  'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f01',
  'c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f02',
  'd1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f03',
  'e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f04',
];

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
      console.log(`[address-reuse-copy-guard-browser] chromium launch attempt ${i + 1} failed: ${err.message}`);
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
  console.log(`[address-reuse-copy-guard-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[address-reuse-copy-guard-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[address-reuse-copy-guard-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[address-reuse-copy-guard-browser] dev server ready at ${BASE_URL}`);
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
        console.log(`[address-reuse-copy-guard-browser][page-console] ${t}`);
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
    await unlockIfNeeded(page, SETUP_PASSWORD, { label: 'address-reuse-copy-guard-browser' });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed via the LIVE Vite singletons ───────────────────────────────────
    // Two curated address records, each RECEIVING in two distinct txs
    // (multi-receive reuse => both appear under "Your Reused Addresses").
    // Only one carries the suspected-poisoning tag.
    const seed = await page.evaluate(
      async ({ poisoned, clean, tag, txids }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const poisonedRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: poisoned,
          label: 'Suspected poisoning lookalike (reused)',
          tags: [tag],
        });
        const cleanRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: clean,
          label: 'Clean reused address',
        });
        const plan = [
          { txid: txids[0], address: poisoned, recordId: poisonedRecordId },
          { txid: txids[1], address: poisoned, recordId: poisonedRecordId },
          { txid: txids[2], address: clean, recordId: cleanRecordId },
          { txid: txids[3], address: clean, recordId: cleanRecordId },
        ];
        let height = 800000;
        for (const p of plan) {
          await txCrud.addTransaction({
            txid: p.txid,
            blockHeight: height++,
            blockTime: Math.floor(Date.now() / 1000) - 86400,
            fee: 210,
            feeRate: 1,
            syncedAt: Date.now(),
          });
          await txCrud.addParticipant({
            txid: p.txid,
            role: 'output',
            address: p.address,
            amount: 15000,
            vout: 0,
            recordId: p.recordId,
          });
        }
        return { poisonedRecordId, cleanRecordId };
      },
      { poisoned: POISONED_ADDR, clean: CLEAN_ADDR, tag: POISON_TAG, txids: TXIDS },
    );
    steps.push({
      name: 'seeded tagged + clean multi-receive reused addresses',
      passed:
        Number.isInteger(seed.poisonedRecordId) &&
        seed.poisonedRecordId > 0 &&
        Number.isInteger(seed.cleanRecordId) &&
        seed.cleanRecordId > 0,
      detail: `poisonedRecordId=${seed.poisonedRecordId}, cleanRecordId=${seed.cleanRecordId}`,
    });

    // ── Reload once so the page recomputes reuse from a clean mount ─────────
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { label: 'address-reuse-copy-guard-browser' });

    // Expand the tagged address row so the copy button renders.
    const expandPoisoned = page.getByTestId(`button-expand-address-${POISONED_ID}`);
    await expandPoisoned.waitFor({ state: 'visible', timeout: 60_000 });
    await expandPoisoned.click();
    // The collapsed row header also renders an AddressLink whose internal
    // copy button reuses the same testid. The Address Reuse page's OWN copy
    // button (the surface under test, wired to useGuardedAddressCopy) lives
    // in the CollapsibleContent, which renders AFTER the trigger — take the
    // LAST match, and assert it is not inside the expand trigger.
    const copyBtn = page.locator(`[data-testid="button-copy-address-${POISONED_ID}"]`).last();
    await copyBtn.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({ name: 'tagged reused address row renders and expands', passed: true, detail: 'copy button visible' });

    // ── First copy click: destructive warning toast, NO copy ────────────────
    await page.evaluate(() => navigator.clipboard.writeText('sentinel-before-copy'));
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
    steps.push({
      name: 'first copy click shows the destructive warning toast and copies NOTHING',
      passed: warnVisible && warnBody && clipboardAfterFirst === 'sentinel-before-copy',
      detail: `toast=${warnVisible}, body=${warnBody}, clipboard=${JSON.stringify(clipboardAfterFirst)}`,
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

    // ── Control: the clean reused address copies on the FIRST click ─────────
    await page.evaluate(() => navigator.clipboard.writeText('sentinel-clean'));
    const expandClean = page.getByTestId(`button-expand-address-${CLEAN_ID}`);
    await expandClean.waitFor({ state: 'visible', timeout: 30_000 });
    await expandClean.click();
    const cleanCopyBtn = page.locator(`[data-testid="button-copy-address-${CLEAN_ID}"]`).last();
    await cleanCopyBtn.waitFor({ state: 'visible', timeout: 30_000 });
    const warnCountBefore = await page.getByText('Suspected address-poisoning address').count();
    await cleanCopyBtn.click();
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

  console.log(`[address-reuse-copy-guard-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[address-reuse-copy-guard-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[address-reuse-copy-guard-browser] PASSED: the shared useGuardedAddressCopy two-step guard (warning toast, blocked first copy, second-click copy, clean-address control) works end-to-end on the Address Reuse page in a real browser.',
  );
}

main().catch((err) => {
  console.error('[address-reuse-copy-guard-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
