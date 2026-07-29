#!/usr/bin/env node
// Real-browser regression guard for the Descriptor Import BSMS metadata flow.
//
// Root cause history: importing a Nunchuk BSMS file could strand the user on
// Step 1 (metadata card never reachable) and, when derived addresses already
// existed in the vault, user-entered metadata (owner, notes, ...) was
// silently dropped by the "existing || entered" merge. The fix routes all
// inputs through analyzeDescriptorInput (clear errors, BSMS /** wildcard
// support) and reports kept-vs-merged metadata in the Step 3 summary.
//
// This check drives a headless Chromium end-to-end:
//   1. Creates a fresh vault.
//   2. Pastes a REAL Nunchuk-style BSMS (BSMS 1.0, /** wildcard, CRLF,
//      first-address verification line) into Descriptor Import.
//   3. Asserts Step 2 (metadata card) is reached, with NO first-address
//      mismatch warning (proves /** derivation matches the BSMS address).
//   4. Enters owner metadata, imports, and asserts the Step 3 summary.
//   5. Re-imports the same BSMS with a DIFFERENT owner and asserts the
//      "Some existing metadata was kept" alert appears — proving both that
//      the first import persisted the owner AND that merges are no longer
//      silent.
//   6. Pastes a single-sig wpkh BSMS and asserts the actionable error.
//
// Usage: node scripts/check-descriptor-bsms-import-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'bsms-import-check-123';

// Real 2-of-2 sortedmulti wsh built from the two BIP-39 test mnemonics at
// m/48'/0'/0'/2'. Line 4 is the true first receive address, so the app's
// BSMS first-address verification must PASS.
const DESCRIPTOR =
  "wsh(sortedmulti(2,[73c5da0a/48'/0'/0'/2']xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf/**,[b8688df1/48'/0'/0'/2']xpub6FQya7zGhR92kacYsNnjreouvnHJMpXYsUXnW6NJJAJRCKsa26TzDy4LdnGhEurr3d6y1J8PJ7EEMKQp74XTqYvmGJNogYXSKDszYHtF8mX/**))";
const FIRST_ADDRESS =
  'bc1qsks3qr92vdnr80q6y9vv6h4qwlzza9w8ts2pjp74wjj6ahvud5dsc3vhxe';
const NUNCHUK_BSMS =
  ['BSMS 1.0', DESCRIPTOR, '/0/*,/1/*', FIRST_ADDRESS].join('\r\n') + '\r\n';

const SINGLESIG_BSMS = [
  'BSMS 1.0',
  "wpkh([73c5da0a/84'/0'/0']xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf/**)",
  'No path restrictions',
  FIRST_ADDRESS,
].join('\n');

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

async function setOwner(page, name) {
  await page.getByTestId('select-owner').click();
  const input = page.getByPlaceholder('Search or add owner...');
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(name);
  // Either the "Add \"name\"" button (new) or an existing item is shown.
  const addBtn = page.getByRole('button', { name: `Add "${name}"` });
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click();
  } else {
    await page.getByRole('option', { name }).first().click().catch(async () => {
      // Fallback: CommandItem may not expose role=option; click by text.
      await page.getByText(name, { exact: true }).last().click();
    });
  }
  // Popover closes; trigger should now show the name.
  await page.waitForTimeout(300);
}

async function runImportRound(page, steps, { owner, notes, round }) {
  const textarea = page.getByTestId('textarea-descriptor');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await textarea.fill(NUNCHUK_BSMS);

  // Parsed successfully on step 1?
  const parsedOk = await page
    .getByText('Descriptor Parsed Successfully')
    .isVisible({ timeout: 10_000 })
    .catch(() => false);
  steps.push({
    name: `[round ${round}] BSMS paste parses successfully on Step 1`,
    passed: parsedOk,
    detail: `parsed alert visible = ${parsedOk}`,
  });

  // Small ranges for speed.
  await page.getByTestId('input-receive-end').fill('2');
  await page.getByTestId('input-change-end').fill('2');

  await page.getByTestId('button-derive-addresses').click();

  // Step 2 = metadata card reachable.
  const ownerSelect = page.getByTestId('select-owner');
  let reachedStep2 = true;
  try {
    await ownerSelect.waitFor({ state: 'visible', timeout: 60_000 });
  } catch {
    reachedStep2 = false;
  }
  steps.push({
    name: `[round ${round}] Step 2 metadata card is reached after deriving`,
    passed: reachedStep2,
    detail: `metadata owner selector visible = ${reachedStep2}`,
  });
  if (!reachedStep2) return;

  // First-address verification must have passed (no mismatch alert).
  const mismatchVisible = await page
    .getByTestId('alert-bsms-mismatch')
    .isVisible()
    .catch(() => false);
  steps.push({
    name: `[round ${round}] BSMS first-address verification passes (no mismatch alert)`,
    passed: !mismatchVisible,
    detail: `mismatch alert visible = ${mismatchVisible}`,
  });

  await setOwner(page, owner);
  await page.getByTestId('textarea-notes').fill(notes);

  await page.getByTestId('button-import-addresses').click();

  const summary = page.getByTestId('text-import-summary');
  let summaryText = '';
  try {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      if (await summary.isVisible().catch(() => false)) break;
      const body = (await page.textContent('body').catch(() => '')) || '';
      if (/Save failed|Import failed|Error/.test(body)) {
        const idx = body.search(/Save failed|Import failed/);
        if (idx >= 0) console.log(`[bsms-import-browser][debug] failure toast: ${body.slice(idx, idx + 300)}`);
      }
      await page.waitForTimeout(2000);
    }
    await summary.waitFor({ state: 'visible', timeout: 1_000 });
    summaryText = (await summary.textContent()) || '';
  } catch {
    const body = (await page.textContent('body').catch(() => '')) || '';
    console.log(`[bsms-import-browser][debug] step-3 summary missing; body tail: ${body.slice(-800)}`);
    const btn = await page.getByTestId('button-import-addresses').textContent().catch(() => 'n/a');
    console.log(`[bsms-import-browser][debug] import button state: "${btn}"`);
  }
  const expected =
    round === 1 ? /Created 6 new, updated 0 existing/ : /Created 0 new, updated 6 existing/;
  steps.push({
    name: `[round ${round}] Step 3 summary reports the expected counts`,
    passed: expected.test(summaryText),
    detail: `summary = "${summaryText.trim()}"`,
  });

  const keptAlert = await page
    .getByTestId('alert-metadata-kept')
    .isVisible()
    .catch(() => false);
  if (round === 1) {
    steps.push({
      name: '[round 1] no kept-metadata alert on a fresh import',
      passed: !keptAlert,
      detail: `kept alert visible = ${keptAlert}`,
    });
  } else {
    const keptText = keptAlert
      ? (await page.getByTestId('alert-metadata-kept').textContent()) || ''
      : '';
    steps.push({
      name: '[round 2] kept-metadata alert reports the Owner was kept on existing addresses',
      passed: keptAlert && /Owner: kept the existing value on 6 addresses/.test(keptText),
      detail: keptAlert ? `alert text = "${keptText.slice(0, 200)}"` : 'alert not visible',
    });
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[bsms-import-browser] chromium: ${exe}`);

  let devProc = null;

  if (await isServerUp(BASE_URL)) {
    console.log(`[bsms-import-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[bsms-import-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
  }

  // Parallel validation browser checks can kill each other's chromium
  // (resource exhaustion / EAGAIN). Retry the whole session up to 3 times;
  // each attempt uses a fresh profile, so the flow is fully repeatable.
  const MAX_ATTEMPTS = 3;
  let steps = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    steps = [];
    try {
      await runSession(exe, steps);
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[bsms-import-browser] attempt ${attempt} crashed: ${msg.split('\n')[0]}`);
      if (attempt === MAX_ATTEMPTS) {
        if (devProc) {
          try { process.kill(-devProc.pid, 'SIGTERM'); } catch { /* ignore */ }
        }
        throw e;
      }
      await new Promise((r) => setTimeout(r, 15_000 * attempt));
    }
  }

  for (const s of steps) {
    console.log(`[bsms-import-browser] ${s.passed ? 'PASS' : 'FAIL'}: ${s.name} — ${s.detail}`);
  }
  if (devProc) {
    try {
      process.kill(-devProc.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }

  const failed = steps.filter((s) => !s.passed).length;
  if (failed > 0) {
    console.error(`[bsms-import-browser] ${failed}/${steps.length} step(s) FAILED`);
    process.exit(1);
  }
  console.log(`[bsms-import-browser] all ${steps.length} steps passed`);
}

async function runSession(exe, steps) {
  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (err) => {
      console.log(`[bsms-import-browser][pageerror] ${err.message}`);
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (or unlock, if a prior attempt already created it
    // in this profile — not expected with a fresh profile, but harmless) ──
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 60_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    if (await confirmInput.isVisible().catch(() => false)) {
      await confirmInput.fill(SETUP_PASSWORD);
    }
    await page.getByTestId('button-submit').click();
    await page
      .getByTestId('button-dismiss-migration')
      .click({ timeout: 5_000 })
      .catch(() => {});
    // Wait until the app shell is up (vault created & unlocked).
    await page.getByTestId('button-logout').waitFor({ state: 'visible', timeout: 60_000 });

    // ── Round 1: fresh BSMS import with metadata ────────────────────────
    await page.goto(`${BASE_URL}descriptor-import`, { waitUntil: 'load' });
    // A full navigation re-locks the vault; unlock when prompted. Poll for
    // either the import textarea (already unlocked) or the unlock form.
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (await page.getByTestId('textarea-descriptor').isVisible().catch(() => false)) break;
      if (await page.getByTestId('input-password').isVisible().catch(() => false)) {
        await page.getByTestId('input-password').fill(SETUP_PASSWORD);
        await page.getByTestId('button-submit').click();
        await page
          .getByTestId('button-dismiss-migration')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await page.getByTestId('button-logout').waitFor({ state: 'visible', timeout: 60_000 });
      }
      if (Date.now() > deadline) throw new Error('descriptor-import page never became ready');
      await page.waitForTimeout(1000);
    }
    await runImportRound(page, steps, {
      owner: 'Alice Cold Storage',
      notes: 'imported from Nunchuk BSMS',
      round: 1,
    });

    // ── Round 2: same BSMS, different owner → kept-metadata report ──────
    await page.getByTestId('button-import-another').click();
    await runImportRound(page, steps, {
      owner: 'Bob Second Try',
      notes: 'second import attempt',
      round: 2,
    });

    // ── Single-sig BSMS produces an actionable error, not a dead end ────
    await page.getByTestId('button-import-another').click();
    const textarea = page.getByTestId('textarea-descriptor');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });
    await textarea.fill(SINGLESIG_BSMS);
    let errText = '';
    try {
      const alert = page.getByText('Parse Error');
      await alert.waitFor({ state: 'visible', timeout: 10_000 });
      errText =
        (await page
          .locator('[role="alert"], .text-destructive, [data-testid], div')
          .filter({ hasText: 'single-signature' })
          .first()
          .textContent()
          .catch(() => '')) || '';
      if (!errText) errText = (await page.textContent('body')) || '';
    } catch {
      errText = (await page.textContent('body').catch(() => '')) || '';
    }
    steps.push({
      name: 'single-sig wpkh BSMS shows an actionable parse error',
      passed: /single-signature/i.test(errText),
      detail: /single-signature/i.test(errText)
        ? 'error mentions single-signature guidance'
        : `body did not contain guidance (len=${errText.length})`,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[bsms-import-browser] ERROR: ${err.stack || err}`);
  process.exit(1);
});
