#!/usr/bin/env node
// Real-browser regression guard for the dust-flag end-to-end flow:
//
//   Dusted page "Mark as dust"  →  UTXOs page Dust badge  →  Privacy Audit
//   annotated LOW ("already marked as dust by you") finding.
//
// Unit tests cover the dust-flag CRUD module and the Privacy Audit downgrade
// logic in isolation, but nothing proves the three surfaces are actually wired
// together in the live Vite bundle: the Dusted page writes through
// markOutpointsAsDust, the UTXOs page subscribes via getDustFlaggedOutpointSet,
// and the audit context loads db.dustFlags itself. A regression in any of that
// wiring (renamed testids, a dropped useLiveQuery, a changed outpoint format)
// passes unit tests but breaks the real app. This script drives a REAL headless
// Chromium against the running dev server:
//
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds one owned address record + one confirmed transaction with a single
//      unspent 800-sat output (dust: <= 1000 sats, above the 546 strict line)
//      via the live Vite module singletons (record-crud / transaction-crud)
//   3. reloads the Dusted page so the scan picks the seed up on mount, clicks
//      the real "Mark as dust" button, and waits for it to flip to "Unmark"
//   4. opens the UTXOs page and asserts the group-level "1 dust" badge AND the
//      per-UTXO "Dust" badge (after expanding the address group)
//   5. opens Reports → Privacy tab, generates the audit, and asserts exactly
//      one DUST finding for the seeded output: severity "Low" with the
//      "already marked as dust by you" annotation — and that NO non-downgraded
//      (Medium/Critical) unspent-dust finding remains.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-dust-badge-audit-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other (SIGTRAP, goto timeouts). Hold the lock for the whole
// script lifetime, including any dev-server spawn.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'dust-badge-audit-check-123';

// Fake-but-plausible identifiers. The dust pipeline matches addresses and
// outpoints by string equality only (no checksum validation on this path), and
// the UTXOs group testid uses the first 8 characters of the address.
const OWNED_ADDR = 'bc1qdustcheckownedaddressxxxxxxxxxxxxxxx';
const DUST_TXID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const DUST_VOUT = 0;
const DUST_SATS = 800; // <= 1000 (dust) but > 546 (so the undowngraded severity would be MEDIUM)

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
 * Handle the auth screen if it is showing: fills the password (and the confirm
 * field when this is the first-run setup form) and submits. No-op when the app
 * is already unlocked.
 */
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
 * The legacy-migration overlay (`legacy-migration-overlay`, z-index 9999) can
 * appear right after unlock — either as a transient progress screen or as a
 * "Data Migration Complete" result card with a Continue button — and it
 * intercepts all pointer events while visible. Wait it out / dismiss it so
 * subsequent clicks are not swallowed. No-op when it never shows.
 */
async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[dust-badge-audit-browser] legacy-migration overlay detected; waiting it out ...');
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
  console.log(`[dust-badge-audit-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dust-badge-audit-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dust-badge-audit-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[dust-badge-audit-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];

  try {
    // Fresh context => empty IndexedDB => first load shows the vault setup
    // form. Block the PWA service worker so it cannot serve a stale bundle or
    // reload the page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (msg.type() === 'error' || t.toLowerCase().includes('buffer is not defined')) {
        console.log(`[dust-badge-audit-browser][page-console] ${t}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}dusted`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: one owned address record + one tx with a single unspent dust
    //    output, via the LIVE Vite module singletons (same URLs the app
    //    imported => same Dexie instance). ────────────────────────────────────
    const seed = await page.evaluate(
      async ({ addr, txid, vout, sats }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const recordId = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'Dust check owned address',
        });
        const blockTime = Math.floor(Date.now() / 1000) - 86400;
        await txCrud.addTransaction({
          txid,
          blockHeight: 800000,
          blockTime,
          fee: 100,
          feeRate: 1,
          syncedAt: Date.now(),
        });
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: addr,
          amount: sats,
          vout,
          recordId,
        });
        return { recordId };
      },
      { addr: OWNED_ADDR, txid: DUST_TXID, vout: DUST_VOUT, sats: DUST_SATS },
    );
    const recordId = seed.recordId;
    steps.push({
      name: 'seeded owned address + unspent dust output',
      passed: Number.isInteger(recordId) && recordId > 0,
      detail: `recordId=${recordId}, ${DUST_SATS} sats at vout ${DUST_VOUT}`,
    });

    // ── Dusted page: reload so the scan picks the seed up on mount, then
    //    click the real "Mark as dust" button. ───────────────────────────────
    await page.goto(`${BASE_URL}dusted`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const markBtn = page.getByTestId(`button-mark-dust-${recordId}`);
    await markBtn.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'Dusted page scan surfaced the seeded address with a Mark as dust action',
      passed: true,
      detail: `button-mark-dust-${recordId} visible`,
    });

    await markBtn.click();
    // The row flips to "Unmark" only after the flag write lands and the live
    // query re-fires — this is the proof the click actually persisted.
    await page
      .getByTestId(`button-unmark-dust-${recordId}`)
      .waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'Mark as dust persisted (button flipped to Unmark via live query)',
      passed: true,
      detail: `button-unmark-dust-${recordId} visible after click`,
    });

    // ── UTXOs page: group-level "1 dust" badge + per-UTXO "Dust" badge ──────
    await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    const groupBadge = page.getByTestId(`badge-dust-group-${OWNED_ADDR.slice(0, 8)}`);
    await groupBadge.waitFor({ state: 'visible', timeout: 30_000 });
    const groupBadgeText = (await groupBadge.textContent()) ?? '';
    steps.push({
      name: 'UTXOs page shows the group-level dust badge',
      passed: /1\s*dust/i.test(groupBadgeText),
      detail: `badge text: "${groupBadgeText.trim()}" (expected "1 dust")`,
    });

    // Expand the address group and assert the per-UTXO Dust badge.
    await page.getByTestId(`row-address-${OWNED_ADDR.slice(0, 8)}`).click();
    const utxoBadge = page
      .locator('[data-testid^="badge-dust-"]:not([data-testid^="badge-dust-group-"])')
      .first();
    const utxoBadgeVisible = await utxoBadge
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const utxoBadgeText = utxoBadgeVisible ? ((await utxoBadge.textContent()) ?? '') : '';
    steps.push({
      name: 'UTXOs page shows the per-UTXO Dust badge after expanding the group',
      passed: utxoBadgeVisible && /dust/i.test(utxoBadgeText),
      detail: utxoBadgeVisible
        ? `per-UTXO badge text: "${utxoBadgeText.trim()}"`
        : 'per-UTXO Dust badge never appeared',
    });

    // ── Reports → Privacy Audit: annotated LOW finding ──────────────────────
    await page.goto(`${BASE_URL}reports`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    await page.getByTestId('tab-privacy-report').click();
    const generateBtn = page.getByTestId('button-generate-privacy-report');
    await generateBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await generateBtn.click();

    await page
      .getByTestId('container-privacy-report-findings')
      .waitFor({ state: 'visible', timeout: 60_000 });

    // Collect every rendered finding's severity + description.
    const findings = await page.evaluate(() => {
      const out = [];
      const descs = document.querySelectorAll('[data-testid^="text-privacy-finding-desc-"]');
      for (const el of descs) {
        const idx = el.getAttribute('data-testid').replace('text-privacy-finding-desc-', '');
        const sevEl = document.querySelector(
          `[data-testid="text-privacy-finding-severity-${idx}"]`,
        );
        out.push({
          index: idx,
          severity: sevEl ? sevEl.textContent.trim() : '',
          description: el.textContent.trim(),
        });
      }
      return out;
    });

    const annotated = findings.filter((f) =>
      f.description.includes('already marked as dust by you'),
    );
    steps.push({
      name: 'Privacy Audit contains the annotated dust finding',
      passed: annotated.length === 1 && annotated[0].description.includes(OWNED_ADDR),
      detail:
        annotated.length === 1
          ? `finding #${annotated[0].index}: "${annotated[0].description.slice(0, 120)}"`
          : `found ${annotated.length} annotated dust finding(s) (expected exactly 1); all findings: ${JSON.stringify(findings)}`,
    });

    steps.push({
      name: 'annotated dust finding is downgraded to Low severity',
      passed: annotated.length === 1 && /^low$/i.test(annotated[0].severity),
      detail:
        annotated.length === 1
          ? `severity badge: "${annotated[0].severity}" (expected "Low")`
          : 'annotated finding missing, cannot check severity',
    });

    // The downgrade must REPLACE the normal finding — an un-downgraded unspent
    // dust finding for the same output must not remain.
    const undowngraded = findings.filter(
      (f) =>
        f.description.includes('Unspent dust UTXO') &&
        !f.description.includes('already marked as dust by you'),
    );
    steps.push({
      name: 'no non-downgraded unspent-dust finding remains',
      passed: undowngraded.length === 0,
      detail:
        undowngraded.length === 0
          ? 'only the annotated Low finding reports this dust output'
          : `unexpected finding(s): ${JSON.stringify(undowngraded)}`,
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

  console.log(`[dust-badge-audit-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dust-badge-audit-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dust-badge-audit-browser] PASSED: Mark as dust → UTXOs badge → annotated LOW audit finding all hold in a real browser.',
  );
}

main().catch((err) => {
  console.error('[dust-badge-audit-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
