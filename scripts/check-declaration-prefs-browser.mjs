#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds **declaration
// preference persistence** (client/src/pages/proof-of-funds/declaration-prefs.ts,
// consumed by client/src/pages/ProofOfFundsDeclaration.tsx).
//
// The unit tests cover the load/save helpers in isolation; this script proves
// the whole loop end-to-end in headless Chromium:
//
//   1. creates a vault, seeds ONE funded address via the CRUD modules, runs
//      the OFFLINE balance check so the QR-explorer selector is visible
//   2. toggles/sets every persisted preference away from its default:
//        includeQr        -> ON,   qrExplorerId          -> blockstream
//        includeProvenance-> ON,   provenanceFiatCurrency -> GBP
//        fiatCurrency     -> EUR,  fiatRate               -> 65000
//        includeAml       -> ON
//      and fills sensitive identity free-text (declarant name + tax ID)
//   3. RELOADS the page (real navigation), unlocks the vault again, re-runs
//      the offline balance check, and asserts:
//        - every preference above is restored exactly
//        - the declarant name and tax ID inputs are BLANK
//        - the persisted localStorage value contains NO identity strings
//
// NOTE for reviewers: the page under test is /proof-of-funds →
// client/src/pages/ProofOfFundsDeclaration.tsx (prefs restored via
// loadDeclarationPrefs initializers, saved via the saveDeclarationPrefs effect).
//
// Usage: node scripts/check-declaration-prefs-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PROOF_URL = `${BASE_URL}proof-of-funds`;
const SETUP_PASSWORD = 'decl-prefs-check-123';
const PREFS_KEY = 'kyutxo.proofOfFunds.declarationPrefs';

const DECLARANT_NAME = 'Alice Prefs Example';
const DECLARANT_TAX_ID = 'TAX-ID-9876543';
const FIAT_RATE = '65000';
const FUNDED_SATS = 250_000;
const FUNDED_TXID =
  'a1b2c3d4e5f6071829304152637485960718293041526374859607182930a1b2';

// Derive a valid P2PKH address at runtime (fixed test-only key) so the
// offline balance check always accepts it.
const PRIV_KEY = Uint8Array.from(
  Buffer.from(
    '2222222222222222222222222222222222222222222222222222222222222222',
    'hex',
  ),
);
const FUNDED_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: secp256k1.getPublicKey(PRIV_KEY, true),
  network: bitcoin.networks.bitcoin,
}).address;

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

async function gotoWithRetry(page, url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      return;
    } catch (err) {
      lastErr = err;
      console.log(
        `[decl-prefs] goto ${url} failed (attempt ${i + 1}/${attempts}): ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 3_000 * (i + 1)));
    }
  }
  throw lastErr;
}

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
      console.log(
        `[decl-prefs] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 3_000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Dismiss the legacy-migration overlay if it appears after unlock. */
async function dismissMigrationOverlay(page) {
  await page
    .getByTestId('button-dismiss-migration')
    .click({ timeout: 3_000 })
    .catch(() => {});
}

/** Run the offline balance check and wait for the first result row. */
async function runOfflineBalanceCheck(page) {
  const textarea = page.getByTestId('textarea-address-input');
  await textarea.waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByTestId('button-source-offline').click();
  await textarea.fill(FUNDED_ADDRESS);
  await page.getByTestId('button-check-balances').click();
  await page
    .locator('[data-testid="row-address-0"]')
    .waitFor({ state: 'visible', timeout: 30_000 });
}

/** Return the data-state ("checked"/"unchecked") of a Radix switch. */
async function switchState(page, testid) {
  return page.getByTestId(testid).getAttribute('data-state');
}

/** Pick an option from a Radix Select by trigger testid + option regex. */
async function pickSelectOption(page, triggerTestid, optionRe) {
  const trigger = page.getByTestId(triggerTestid);
  await trigger.scrollIntoViewIfNeeded({ timeout: 10_000 });
  await trigger.click();
  await page.getByRole('option', { name: optionRe }).click();
}

async function main() {
  const exe = resolveChromium();
  console.log(`[decl-prefs] chromium: ${exe}`);
  console.log(`[decl-prefs] funded address: ${FUNDED_ADDRESS}`);

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[decl-prefs] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[decl-prefs] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[decl-prefs] dev server ready at ${BASE_URL}`);
  }

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const browser = await launchWithRetry(exe);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    // Fully offline: nothing but the dev server is reachable.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE_URL) || url.startsWith('data:')) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[decl-prefs][page-console] ${t}`);
      }
    });

    await gotoWithRetry(page, PROOF_URL);

    // ── Create the vault ─────────────────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 60_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await dismissMigrationOverlay(page);

    // ── Seed the funded address (offline balance source reads these rows) ─
    await page
      .getByTestId('textarea-address-input')
      .waitFor({ state: 'visible', timeout: 60_000 });
    await page.evaluate(
      async ({ addr, sats, txid }) => {
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({
          txid,
          blockHeight: 800_000,
          blockTime: now - 3600,
          fee: 1000,
          feeRate: 5,
          syncedAt: Date.now(),
        });
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: addr,
          amount: sats,
          vout: 0,
        });
        return true;
      },
      { addr: FUNDED_ADDRESS, sats: FUNDED_SATS, txid: FUNDED_TXID },
    );

    await runOfflineBalanceCheck(page);
    console.log('[decl-prefs] offline balance check complete (run 1)');

    // ── Sanity: defaults before any toggling ───────────────────────────────
    step(
      'defaults: QR / provenance / AML switches start unchecked',
      (await switchState(page, 'switch-include-qr')) === 'unchecked' &&
        (await switchState(page, 'switch-include-provenance')) === 'unchecked' &&
        (await switchState(page, 'switch-include-aml')) === 'unchecked',
    );

    // ── Set every persisted preference away from its default ─────────────
    await page.getByTestId('switch-include-qr').click();
    await pickSelectOption(page, 'select-qr-explorer', /blockstream/i);

    await page.getByTestId('switch-include-provenance').click();
    await pickSelectOption(page, 'select-provenance-currency', /GBP/);

    await pickSelectOption(page, 'select-fiat-currency', /EUR/);
    await page.getByTestId('input-fiat-rate').fill(FIAT_RATE);

    const amlSwitch = page.getByTestId('switch-include-aml');
    await amlSwitch.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await amlSwitch.click();

    // Sensitive identity free-text — must NOT survive the reload.
    await page.getByTestId('input-declarant-name').fill(DECLARANT_NAME);
    await page.getByTestId('input-declarant-tax-id').fill(DECLARANT_TAX_ID);

    // Wait until the save effect has flushed the new prefs to localStorage.
    await page.waitForFunction(
      (key) => {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return false;
          const p = JSON.parse(raw);
          return (
            p.includeQr === true &&
            p.qrExplorerId === 'blockstream' &&
            p.includeProvenance === true &&
            p.provenanceFiatCurrency === 'GBP' &&
            p.fiatCurrency === 'EUR' &&
            p.fiatRate === '65000' &&
            p.includeAml === true
          );
        } catch {
          return false;
        }
      },
      PREFS_KEY,
      { timeout: 20_000 },
    );
    step('prefs persisted to localStorage after toggling', true);

    // ── RELOAD: real navigation, then unlock again ────────────────────────
    await gotoWithRetry(page, PROOF_URL);
    const pw2 = page.getByTestId('input-password');
    await pw2.waitFor({ state: 'visible', timeout: 60_000 });
    await pw2.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await dismissMigrationOverlay(page);

    // Re-run the offline check (records persisted in the vault) so the
    // QR-explorer selector — only rendered once results exist — is visible.
    await runOfflineBalanceCheck(page);
    console.log('[decl-prefs] offline balance check complete (run 2, after reload)');

    // ── Assert every preference was restored ─────────────────────────────
    step(
      'restored: includeQr switch is checked',
      (await switchState(page, 'switch-include-qr')) === 'checked',
    );
    {
      const txt = (await page.getByTestId('select-qr-explorer').textContent()) ?? '';
      step(
        'restored: QR explorer selection is blockstream',
        /blockstream/i.test(txt),
        `trigger text: ${JSON.stringify(txt)}`,
      );
    }
    step(
      'restored: includeProvenance switch is checked',
      (await switchState(page, 'switch-include-provenance')) === 'checked',
    );
    {
      const txt =
        (await page.getByTestId('select-provenance-currency').textContent()) ?? '';
      step(
        'restored: provenance fiat currency is GBP',
        /GBP/.test(txt),
        `trigger text: ${JSON.stringify(txt)}`,
      );
    }
    {
      const txt = (await page.getByTestId('select-fiat-currency').textContent()) ?? '';
      step(
        'restored: fiat currency is EUR',
        /EUR/.test(txt),
        `trigger text: ${JSON.stringify(txt)}`,
      );
    }
    {
      const val = await page.getByTestId('input-fiat-rate').inputValue();
      step('restored: fiat rate is 65000', val === FIAT_RATE, `value: ${JSON.stringify(val)}`);
    }
    step(
      'restored: includeAml switch is checked',
      (await switchState(page, 'switch-include-aml')) === 'checked',
    );

    // ── Assert sensitive identity fields are NOT restored ────────────────
    {
      const name = await page.getByTestId('input-declarant-name').inputValue();
      const taxId = await page.getByTestId('input-declarant-tax-id').inputValue();
      step(
        'identity: declarant name input is blank after reload',
        name === '',
        `value: ${JSON.stringify(name)}`,
      );
      step(
        'identity: declarant tax ID input is blank after reload',
        taxId === '',
        `value: ${JSON.stringify(taxId)}`,
      );
    }
    {
      // Belt-and-braces: the persisted blob itself must not carry identity data.
      const raw = await page.evaluate((key) => localStorage.getItem(key) ?? '', PREFS_KEY);
      step(
        'identity: persisted prefs blob contains no identity strings',
        !raw.includes(DECLARANT_NAME) && !raw.includes(DECLARANT_TAX_ID),
        `blob: ${raw}`,
      );
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
  console.log(`[decl-prefs] ok=${ok}`);
  if (!ok) {
    console.error('\n[decl-prefs] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log(
    '[decl-prefs] PASSED: declaration preferences survive a real reload and identity fields do not.',
  );
}

main().catch((err) => {
  console.error('[decl-prefs] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
