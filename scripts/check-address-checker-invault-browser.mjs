#!/usr/bin/env node
// Task 1876 real-browser check: the Address Checker "Saved" (In Vault) badge
// is a click target that opens the matching record in the GLOBAL record
// detail panel. jsdom tests cover the wiring, but detail-panel opening +
// click behavior inside the virtualized, page-scrolled table are exactly the
// class of thing that only a real browser exercises (portal mount, layout
// shifts stealing coordinate clicks, native title tooltips).
//
// Flow (all offline; Electrum is shimmed via window.electronAPI):
//   1. fresh vault (fresh browser context => empty IndexedDB)
//   2. seed TWO saved `type: 'address'` records for ONE address (unlabeled
//      duplicate first, labeled second) via the Vite-singleton CRUD module;
//      a second generated address stays record-less — this exercises the
//      getSavedAddressRecordLookup labeled-preference path end-to-end
//   3. paste both addresses into the Address Checker and run a check
//      (vault membership is snapshotted per run at Check click)
//   4. assert the saved row shows the clickable Saved badge, the unsaved
//      row shows no button/click target
//   5. click the badge and assert the global preview panel opens showing
//      the saved record's identifier + label
//
// Usage: node scripts/check-address-checker-invault-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import * as secp from '@bitcoinerlab/secp256k1';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts).
await acquireBrowserCheckLock();

const require = createRequire(import.meta.url);
const bitcoin = require('bitcoinjs-lib');

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const CHECKER_URL = `${BASE_URL}address-checker`;
const SETUP_PASSWORD = 'invault-badge-check-123';
const SAVED_LABEL = 'Cold storage badge target';

// Real (randomly generated) mainnet p2wpkh addresses so the checker's
// validation accepts them.
function genAddresses(n) {
  bitcoin.initEccLib(secp);
  const out = [];
  while (out.length < n) {
    const priv = crypto.randomBytes(32);
    if (!secp.isPrivate(priv)) continue;
    const pub = Buffer.from(secp.pointFromScalar(priv, true));
    const { address } = bitcoin.payments.p2wpkh({ pubkey: pub, network: bitcoin.networks.bitcoin });
    // Detail-panel/testid conventions elsewhere slice identifiers to 8 chars;
    // keep prefixes distinct just in case (bc1q + 4 more chars are random).
    if (!out.some((a) => a.slice(0, 12) === address.slice(0, 12))) out.push(address);
  }
  return out;
}

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

async function launchWithRetry(exe, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      lastErr = e;
      console.log(`[invault-badge] chromium launch failed (attempt ${i + 1}): ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
  throw lastErr;
}

// window.electronAPI shim: the checker refuses to run without a reachable
// provider. Deterministic fast responses; unknown methods resolve to a
// generic failure so unrelated Electron-only probes stay non-fatal.
const SHIM = `
(() => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = {
    isElectron: true,
    electrumTest: async () => { await delay(20); return { success: true, serverVersion: 'shim 1.4', blockHeight: 900000, latency: 20 }; },
    electrumGetHistory: async () => { await delay(15); return { success: true, history: [] }; },
    electrumBatchGetHistory: async ({ addresses }) => {
      await delay(10);
      return { success: true, results: addresses.map((address) => ({ address, success: true, history: [] })) };
    },
    electrumGetUtxos: async () => { await delay(10); return { success: true, utxos: [] }; },
  };
  window.electronAPI = new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== 'string') return undefined;
      return async () => ({ success: false, error: 'not implemented in shim' });
    },
  });
})();
`;

async function main() {
  const exe = resolveChromium();
  const [savedAddr, unsavedAddr] = genAddresses(2);
  console.log(`[invault-badge] chromium: ${exe}`);
  console.log(`[invault-badge] saved=${savedAddr} unsaved=${unsavedAddr}`);

  let devProc = null;
  if (!(await isServerUp(BASE_URL))) {
    console.log('[invault-badge] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    if (!(await waitForServer(BASE_URL, 90_000))) throw new Error('Dev server not ready in 90s');
  }

  const browser = await launchWithRetry(exe);
  const steps = [];
  const step = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(SHIM);
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`[invault-badge][page-console] ${msg.text()}`);
    });

    // ── Create the vault (retry initial load under parallel-validation load)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
        await page.getByTestId('input-password').waitFor({ state: 'visible', timeout: 45_000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`[invault-badge] initial load failed (attempt ${attempt}): ${e.message}; retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    await unlockIfNeeded(page);
    step('vault created and app unlocked', true);

    // ── Seed: TWO saved records for the same address (unlabeled duplicate
    // first, labeled second) + Electrum node settings. This exercises the
    // getSavedAddressRecordLookup labeled-preference path end-to-end: the
    // badge must carry the LABELED record's label and open THAT record.
    const seed = await page.evaluate(
      async ({ saved, unsaved, label }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const nodeCrud = await import('/src/lib/data/node-settings-crud.ts');
        const unlabeledRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: saved,
        });
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: saved,
          label,
        });
        await nodeCrud.putNodeSettings({
          id: 'default',
          providerType: 'mempool-space',
          useTor: false,
          requestTimeout: 30000,
          network: 'mainnet',
          allowLocalNetwork: false,
          trustedLocalHosts: [],
          useElectrum: true,
          electrumHost: 'shim.local',
          electrumPort: 50001,
          electrumSSL: false,
        });
        const unsavedRecords = await recordCrud.getRecordsByInputString(unsaved);
        // Fixture guard: both duplicates must exist as separate address rows,
        // otherwise the labeled-preference branch isn't exercised at all.
        const savedRows = (await recordCrud.getRecordsByInputString(saved)).filter(
          (r) => r.type === 'address',
        );
        return {
          recordId,
          unlabeledRecordId,
          savedAddressRows: savedRows.length,
          unsavedCount: unsavedRecords.length,
        };
      },
      { saved: savedAddr, unsaved: unsavedAddr, label: SAVED_LABEL },
    );
    step(
      'seed: TWO saved records (unlabeled + labeled) share the address; unsaved address has NO record',
      typeof seed.recordId === 'number' &&
        typeof seed.unlabeledRecordId === 'number' &&
        seed.recordId !== seed.unlabeledRecordId &&
        seed.savedAddressRows === 2 &&
        seed.unsavedCount === 0,
      `labeledId=${seed.recordId}, unlabeledId=${seed.unlabeledRecordId}, savedAddressRows=${seed.savedAddressRows}, records for unsaved addr=${seed.unsavedCount}`,
    );

    // ── Navigate to the Address Checker (reload; unlock again if needed) ──
    await page.goto(CHECKER_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Paste saved (row 0) + unsaved (row 1) and run the check ──────────
    await textarea.fill(`${savedAddr}\n${unsavedAddr}`);
    await page.getByTestId('button-run-check').click();

    // Both rows finish quickly against the shim; the Saved badge appears once
    // the membership snapshot resolves.
    const badge = page.getByTestId('badge-invault-0');
    await badge.waitFor({ state: 'visible', timeout: 30_000 });
    step('saved row shows the clickable Saved badge', true);

    const badgeInfo = await badge.evaluate((el) => ({
      tag: el.tagName,
      title: el.getAttribute('title') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
    }));
    step(
      'badge is a real button carrying the saved label',
      badgeInfo.tag === 'BUTTON' && badgeInfo.title.includes(SAVED_LABEL) && badgeInfo.ariaLabel.includes(SAVED_LABEL),
      JSON.stringify(badgeInfo),
    );

    // ── Unmatched row: no button / click target ───────────────────────────
    const unsavedCell = await page.getByTestId('cell-invault-1').evaluate((el) => ({
      text: el.textContent?.trim() || '',
      buttons: el.querySelectorAll('button, [role="button"], a').length,
      badgeTestIds: el.querySelectorAll('[data-testid^="badge-invault-"]').length,
    }));
    step(
      'unsaved row has no button/click target (dash only)',
      unsavedCell.buttons === 0 && unsavedCell.badgeTestIds === 0 && unsavedCell.text === '—',
      JSON.stringify(unsavedCell),
    );

    // ── Click the badge → global record preview panel opens ──────────────
    // Async row updates (status badges/results flushing) can shift layout
    // mid-click and steal a coordinate click; dispatchEvent avoids the race
    // (memory: detail-panel click races).
    await badge.dispatchEvent('click');

    const identifier = page.getByTestId('text-panel-identifier');
    const panelOpened = await identifier
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    step('clicking the Saved badge opens the record detail panel', panelOpened);

    if (panelOpened) {
      const shownIdentifier = (await identifier.textContent())?.trim();
      step(
        'panel shows the SAVED record identifier (right record)',
        shownIdentifier === savedAddr,
        `panel identifier=${JSON.stringify(shownIdentifier)}, expected=${savedAddr}`,
      );
      const labelVisible = await page
        .getByText(SAVED_LABEL, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      step('panel shows the saved record label', labelVisible, `label "${SAVED_LABEL}" visible=${labelVisible}`);
    }
  } finally {
    await browser.close().catch(() => {});
    if (devProc) {
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch {}
    }
  }

  const failed = steps.filter((s) => !s.passed);
  if (failed.length) {
    console.error(`[invault-badge] ${failed.length}/${steps.length} steps FAILED`);
    process.exit(1);
  }
  console.log(`[invault-badge] all ${steps.length} steps passed`);
}

main().catch((e) => {
  console.error('[invault-badge] FAILED:', e);
  process.exit(1);
});
