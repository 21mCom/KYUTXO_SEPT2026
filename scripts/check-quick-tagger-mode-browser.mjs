#!/usr/bin/env node
// Real-browser regression guard for the Quick Tagger's single-mode toggle.
//
// The Quick Tagger operates in ONE mode at a time (Addresses OR Transactions)
// with mismatched entries flagged and un-selectable. jsdom unit tests cover
// the pure helpers and page logic, but the review step's virtualized entry
// table (per-row checkbox disabling and "wrong mode" badges) cannot render in
// jsdom, so this script drives the real page in headless Chromium:
//   1. Creates a fresh vault via the setup form and opens /quick-tagger.
//   2. Pastes a mixed list (1 address + 1 TXID) in the default Addresses mode.
//   3. Review step: the mismatch alert renders; the address row shows an
//      enabled checked checkbox with an "Address" badge; the TXID row shows a
//      DISABLED unchecked checkbox with a "TXID — wrong mode" badge.
//   4. Clicks the alert's "Switch to Transactions" button and asserts the
//      roles flip: TXID row enabled+checked ("TXID"), address row disabled+
//      unchecked ("Address — wrong mode").
//   5. Bulk select buttons: Deselect All clears the selectable TXID row and
//      disables Continue (count 0); Select All re-checks ONLY the same-mode
//      TXID row — the wrong-mode address row stays disabled+unchecked — and
//      the summary counts exactly 1 valid transaction (mismatches excluded).
//   6. Continues to metadata in Transactions mode, applies a label, and
//      verifies in IndexedDB that exactly ONE record was created — a
//      transaction record for the TXID — and no address record leaked through.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-quick-tagger-mode-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const TAGGER_URL = `${BASE_URL}quick-tagger`;
const SETUP_PASSWORD = 'quick-tagger-check-123';

// Entry 0: a bech32 address (valid under the app's lenient address check).
// Entry 1: a 64-hex transaction ID. Pasted in this order, so review-table row
// indexes are stable: checkbox-entry-0 = address, checkbox-entry-1 = txid.
const ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const TXID = 'ab12'.repeat(16); // 64 hex chars
const APPLIED_LABEL = 'quick-tagger-mode-check';

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

/** Read a review-table row's state: checkbox disabled/checked + badge text. */
async function rowState(page, index) {
  const checkbox = page.getByTestId(`checkbox-entry-${index}`);
  const badge = page.getByTestId(`badge-type-${index}`);
  await checkbox.waitFor({ state: 'visible', timeout: 10_000 });
  const disabled = await checkbox.isDisabled();
  const checked = (await checkbox.getAttribute('data-state')) === 'checked';
  const badgeText = ((await badge.textContent()) ?? '').trim();
  return { disabled, checked, badgeText };
}

async function main() {
  const exe = resolveChromium();
  console.log(`[quick-tagger-mode-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[quick-tagger-mode-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[quick-tagger-mode-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[quick-tagger-mode-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    // Fresh context => empty IndexedDB => the "Create Vault" setup form.
    // Block the PWA service worker so it cannot reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[quick-tagger-mode-browser][page-console] ${t}`);
      }
    });

    await page.goto(TAGGER_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });

    // ── Step 1: paste a mixed list in the default Addresses mode ──────────
    const textarea = page.getByTestId('textarea-paste-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });

    // Addresses mode is the default; assert the toggle reflects it (the
    // active mode button uses the 'default' variant, i.e. not 'ghost').
    const addrModeBtn = page.getByTestId('button-mode-address');
    await addrModeBtn.waitFor({ state: 'visible', timeout: 10_000 });

    await textarea.fill(`${ADDRESS}\n${TXID}`);
    await page.getByTestId('button-parse-entries').click();

    // ── Step 2: review — mismatch alert + per-row states in Addresses mode ─
    const alert = page.getByTestId('alert-mismatched-entries');
    const alertVisible = await alert
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const alertText = alertVisible ? ((await alert.textContent()) ?? '') : '';
    steps.push({
      name: 'review: mismatched-entries alert renders in Addresses mode',
      passed: alertVisible && /1 transaction ID ignored/i.test(alertText),
      detail: alertVisible
        ? `alert text: ${JSON.stringify(alertText.trim().slice(0, 90))}`
        : 'alert-mismatched-entries never appeared',
    });
    if (!alertVisible) throw new Error('Mismatch alert missing — cannot continue.');

    {
      const addr = await rowState(page, 0);
      const tx = await rowState(page, 1);
      steps.push({
        name: 'review (Addresses mode): address row selectable with "Address" badge',
        passed: !addr.disabled && addr.checked && addr.badgeText === 'Address',
        detail: `disabled=${addr.disabled} checked=${addr.checked} badge=${JSON.stringify(addr.badgeText)}`,
      });
      steps.push({
        name: 'review (Addresses mode): TXID row disabled+unchecked with "TXID — wrong mode" badge',
        passed: tx.disabled && !tx.checked && tx.badgeText === 'TXID — wrong mode',
        detail: `disabled=${tx.disabled} checked=${tx.checked} badge=${JSON.stringify(tx.badgeText)}`,
      });
    }

    // ── Step 3: switch modes via the alert button; roles must flip ─────────
    await page.getByTestId('button-switch-mode').click();

    // The alert re-renders for the other direction (now 1 address ignored).
    const flippedAlertText = (await alert.textContent().catch(() => null)) ?? '';
    steps.push({
      name: 'switch: alert flips to "1 address ignored" in Transactions mode',
      passed: /1 address ignored/i.test(flippedAlertText),
      detail: `alert text: ${JSON.stringify(flippedAlertText.trim().slice(0, 90))}`,
    });

    {
      const addr = await rowState(page, 0);
      const tx = await rowState(page, 1);
      steps.push({
        name: 'switch (Transactions mode): TXID row now selectable with "TXID" badge',
        passed: !tx.disabled && tx.checked && tx.badgeText === 'TXID',
        detail: `disabled=${tx.disabled} checked=${tx.checked} badge=${JSON.stringify(tx.badgeText)}`,
      });
      steps.push({
        name: 'switch (Transactions mode): address row disabled+unchecked with "Address — wrong mode" badge',
        passed: addr.disabled && !addr.checked && addr.badgeText === 'Address — wrong mode',
        detail: `disabled=${addr.disabled} checked=${addr.checked} badge=${JSON.stringify(addr.badgeText)}`,
      });
    }

    // ── Step 4: bulk select buttons only affect same-mode rows ────────────
    // Deselect All: clears the selectable TXID row; the wrong-mode address
    // row stays unchecked+disabled; Continue disables (selected count 0).
    await page.getByTestId('button-deselect-all').click();
    {
      const addr = await rowState(page, 0);
      const tx = await rowState(page, 1);
      const continueDisabled = await page
        .getByTestId('button-continue-to-metadata')
        .isDisabled();
      steps.push({
        name: 'deselect-all (Transactions mode): TXID row unchecked, address row untouched, Continue disabled',
        passed:
          !tx.checked && !tx.disabled && !addr.checked && addr.disabled && continueDisabled,
        detail: `tx checked=${tx.checked} disabled=${tx.disabled}; addr checked=${addr.checked} disabled=${addr.disabled}; continueDisabled=${continueDisabled}`,
      });
    }

    // Select All: must re-check ONLY the same-mode TXID row. The wrong-mode
    // address row must remain disabled+unchecked, and the summary count must
    // exclude it ("Found 1 valid transactions").
    await page.getByTestId('button-select-all').click();
    {
      const addr = await rowState(page, 0);
      const tx = await rowState(page, 1);
      const continueDisabled = await page
        .getByTestId('button-continue-to-metadata')
        .isDisabled();
      const bodyText = (await page.locator('body').textContent()) ?? '';
      const countOk = /Found 1 valid transactions\./.test(bodyText);
      steps.push({
        name: 'select-all (Transactions mode): only TXID row re-checked; wrong-mode address row stays unchecked+disabled',
        passed: tx.checked && !tx.disabled && !addr.checked && addr.disabled,
        detail: `tx checked=${tx.checked} disabled=${tx.disabled}; addr checked=${addr.checked} disabled=${addr.disabled}`,
      });
      steps.push({
        name: 'select-all: valid count excludes mismatched rows and Continue re-enables',
        passed: countOk && !continueDisabled,
        detail: `foundCountText=${countOk} continueDisabled=${continueDisabled}`,
      });
    }

    // ── Step 5: apply metadata in Transactions mode ────────────────────────
    await page.getByTestId('button-continue-to-metadata').click();
    const labelInput = page.getByTestId('input-label');
    await labelInput.waitFor({ state: 'visible', timeout: 15_000 });

    // Mode-gating sanity: address-only metadata fields must not render.
    const walletSelectCount = await page.getByTestId('select-wallet-name').count();
    const importanceCount = await page.getByTestId('select-address-importance').count();
    const flowTypeCount = await page.getByTestId('select-flow-type').count();
    steps.push({
      name: 'metadata (Transactions mode): address-only fields hidden, transaction fields shown',
      passed: walletSelectCount === 0 && importanceCount === 0 && flowTypeCount === 1,
      detail: `select-wallet-name=${walletSelectCount} select-address-importance=${importanceCount} select-flow-type=${flowTypeCount}`,
    });

    await labelInput.fill(APPLIED_LABEL);
    await page.getByTestId('button-apply-metadata').click();
    await page.getByTestId('button-tag-more').waitFor({ state: 'visible', timeout: 30_000 });

    // ── Step 6: exactly one record — a transaction — was created ──────────
    // Vite serves a singleton module graph, so the dynamically-imported db is
    // the exact same Dexie instance the page wrote to.
    const dbCheck = await page.evaluate(
      async ({ address, txid, label }) => {
        const { db } = await import('/src/lib/database.ts');
        const records = await db.records.toArray();
        return {
          total: records.length,
          txRecords: records.filter((r) => r.type === 'transaction' && r.inputString === txid && r.label === label).length,
          addrRecords: records.filter((r) => r.inputString === address).length,
        };
      },
      { address: ADDRESS, txid: TXID, label: APPLIED_LABEL },
    );
    steps.push({
      name: 'apply: exactly one transaction record created, no address record',
      passed: dbCheck.total === 1 && dbCheck.txRecords === 1 && dbCheck.addrRecords === 0,
      detail: `total=${dbCheck.total} txRecords=${dbCheck.txRecords} addrRecords=${dbCheck.addrRecords}`,
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

  console.log(`[quick-tagger-mode-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[quick-tagger-mode-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[quick-tagger-mode-browser] PASSED: Quick Tagger mode toggle, per-row wrong-mode flagging, and mode-restricted apply work end-to-end in a real browser.',
  );
}

main().catch((err) => {
  console.error('[quick-tagger-mode-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
