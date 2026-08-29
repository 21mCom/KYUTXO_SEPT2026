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
//   2. seeds one owned address record + one confirmed transaction with two
//      unspent dust outputs (dust: <= 1000 sats, above the 546 strict line)
//      via the live Vite module singletons (record-crud / transaction-crud)
//   3. reloads the Dusted page so the scan picks the seed up on mount, proves
//      the bulk toolbar round-trip (Mark all flags everything and Unmark all
//      clears every flag, with the toolbar buttons swapping via the live flag
//      subscription), verifies the partially flagged state shows both bulk
//      buttons with the correct counts, then flags both outputs for the
//      downstream badge/audit checks
//   4. opens the UTXOs page and asserts the group-level "2 dust" badge AND the
//      per-UTXO "Dust" badge (after expanding the address group)
//   5. opens Reports → Privacy tab, generates the audit, and asserts exactly
//      two DUST findings for the seeded outputs: severity "Low" with the
//      "already marked as dust by you" annotation — and that NO non-downgraded
//      (Medium/Critical) unspent-dust finding remains.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-dust-badge-audit-browser.mjs
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
const SETUP_PASSWORD = 'dust-badge-audit-check-123';

// Fake-but-plausible identifiers. The dust pipeline matches addresses and
// outpoints by string equality only (no checksum validation on this path), and
// the UTXOs group testid uses the first 8 characters of the address.
const OWNED_ADDR = 'bc1qdustcheckownedaddressxxxxxxxxxxxxxxx';
const DUST_TXID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const DUST_VOUT = 0;
const DUST_SATS = 800; // <= 1000 (dust) but > 546 (so the undowngraded severity would be MEDIUM)
const SECOND_DUST_VOUT = 1;
const SECOND_DUST_SATS = 700;

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
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'dust-badge-audit-browser' });
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: one owned address record + one tx with two unspent dust
    //    outputs, via the LIVE Vite module singletons (same URLs the app
    //    imported => same Dexie instance). ────────────────────────────────────
    const seed = await page.evaluate(
      async ({ addr, txid, vout, sats, secondVout, secondSats }) => {
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
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: addr,
          amount: secondSats,
          vout: secondVout,
          recordId,
        });
        return { recordId };
      },
      {
        addr: OWNED_ADDR,
        txid: DUST_TXID,
        vout: DUST_VOUT,
        sats: DUST_SATS,
        secondVout: SECOND_DUST_VOUT,
        secondSats: SECOND_DUST_SATS,
      },
    );
    const recordId = seed.recordId;
    steps.push({
      name: 'seeded owned address + two unspent dust outputs',
      passed: Number.isInteger(recordId) && recordId > 0,
      detail: `recordId=${recordId}, ${DUST_SATS} sats at vout ${DUST_VOUT} + ${SECOND_DUST_SATS} sats at vout ${SECOND_DUST_VOUT}`,
    });

    // ── Dusted page: reload so the scan picks the seed up on mount. ──────────
    await page.goto(`${BASE_URL}dusted`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'dust-badge-audit-browser' });

    const markBtn = page.getByTestId(`button-mark-dust-${recordId}`);
    await markBtn.waitFor({ state: 'visible', timeout: 30_000 });
    steps.push({
      name: 'Dusted page scan surfaced the seeded address with two unspent dust outputs',
      passed: true,
      detail: `button-mark-dust-${recordId} visible; expected ${DUST_SATS} and ${SECOND_DUST_SATS} sats`,
    });

    const markAllBtn = page.getByTestId('button-mark-all-dust');
    const unmarkAllBtn = page.getByTestId('button-unmark-all-dust');

    const output0MarkBtn = page.getByTestId(
      `button-mark-output-${recordId}-${DUST_TXID}-${DUST_VOUT}`,
    );
    const output1MarkBtn = page.getByTestId(
      `button-mark-output-${recordId}-${DUST_TXID}-${SECOND_DUST_VOUT}`,
    );
    await page.getByTestId(`button-toggle-outputs-${recordId}`).click();
    await output0MarkBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await output1MarkBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Partially flagged toolbar: both bulk actions together ───────────────
    // Flag exactly one of the two outputs through the real per-output action.
    // A mixed scan must show both Mark all (one remaining output) and Unmark all
    // (one flagged output) at the same time.
    await output0MarkBtn.click();
    const output0UnmarkBtn = page.getByTestId(
      `button-unmark-output-${recordId}-${DUST_TXID}-${DUST_VOUT}`,
    );
    await output0UnmarkBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await markAllBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await unmarkAllBtn.waitFor({ state: 'visible', timeout: 30_000 });
    const mixedMarkAllText = ((await markAllBtn.textContent()) ?? '').trim();
    const mixedUnmarkAllText = ((await unmarkAllBtn.textContent()) ?? '').trim();
    const flagsAfterPartialMark = await page.evaluate(async () => {
      const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
      return (await dustCrud.getAllDustFlags()).length;
    });
    steps.push({
      name: 'Partially flagged scan shows Mark all and Unmark all together',
      passed:
        /Mark all as dust\s*\(1\)/i.test(mixedMarkAllText) &&
        /Unmark all\s*\(1\)/i.test(mixedUnmarkAllText) &&
        flagsAfterPartialMark === 1,
      detail: `markAll="${mixedMarkAllText}" unmarkAll="${mixedUnmarkAllText}" dustFlags=${flagsAfterPartialMark} (expected both counts 1, flags 1)`,
    });

    // Clear the mixed state through Unmark all before exercising the original
    // all-flagged bulk round trip.
    await unmarkAllBtn.click();
    const unmarkAllGone = await unmarkAllBtn
      .waitFor({ state: 'detached', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const markAllBack = await page
      .getByTestId('button-mark-all-dust')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const perRowBackToMark = await markBtn
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const flagsAfterUnmarkAll = await page.evaluate(async () => {
      const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
      return (await dustCrud.getAllDustFlags()).length;
    });
    steps.push({
      name: 'Unmark all cleared the partially flagged output',
      passed: unmarkAllGone && markAllBack && perRowBackToMark && flagsAfterUnmarkAll === 0,
      detail: `unmarkAllGone=${unmarkAllGone} markAllBack=${markAllBack} perRowMarkVisible=${perRowBackToMark} dustFlags=${flagsAfterUnmarkAll} (expected 0)`,
    });

    // ── Bulk toolbar: Mark all → Unmark all round-trip ─────────────────────
    await markAllBtn.click();
    await unmarkAllBtn.waitFor({ state: 'visible', timeout: 30_000 });
    // Mark all flagged every unspent output, so nothing markable remains and
    // the Mark-all button must have left the toolbar.
    const markAllGoneAfterBulk = await markAllBtn
      .waitFor({ state: 'detached', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const perRowFlippedToUnmark = await page
      .getByTestId(`button-unmark-dust-${recordId}`)
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const flagsAfterMarkAll = await page.evaluate(async () => {
      const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
      return (await dustCrud.getAllDustFlags()).length;
    });
    steps.push({
      name: 'Mark all flagged every unspent output (Unmark all appeared, Mark all left)',
      passed: markAllGoneAfterBulk && perRowFlippedToUnmark && flagsAfterMarkAll === 2,
      detail: `markAllGone=${markAllGoneAfterBulk} perRowUnmarkVisible=${perRowFlippedToUnmark} dustFlags=${flagsAfterMarkAll} (expected 2)`,
    });

    await unmarkAllBtn.click();
    const unmarkAllGoneAfterBulk = await unmarkAllBtn
      .waitFor({ state: 'detached', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const markAllBackAfterBulk = await markAllBtn
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const flagsAfterBulkUnmark = await page.evaluate(async () => {
      const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
      return (await dustCrud.getAllDustFlags()).length;
    });
    steps.push({
      name: 'Bulk Unmark all cleared both output flags',
      passed: unmarkAllGoneAfterBulk && markAllBackAfterBulk && flagsAfterBulkUnmark === 0,
      detail: `unmarkAllGone=${unmarkAllGoneAfterBulk} markAllBack=${markAllBackAfterBulk} dustFlags=${flagsAfterBulkUnmark} (expected 0)`,
    });

    // Flag both outputs for the downstream UTXOs and Privacy Audit checks.
    await markAllBtn.click();
    // The row flips to "Unmark" only after the flag write lands and the live
    // query re-fires — this is the proof the click actually persisted.
    await page
      .getByTestId(`button-unmark-dust-${recordId}`)
      .waitFor({ state: 'visible', timeout: 30_000 });
    const flagsForDownstreamChecks = await page.evaluate(async () => {
      const dustCrud = await import('/src/lib/data/dust-flags-crud.ts');
      return (await dustCrud.getAllDustFlags()).length;
    });
    steps.push({
      name: 'Both outputs marked as dust persisted for downstream checks',
      passed: flagsForDownstreamChecks === 2,
      detail: `button-unmark-dust-${recordId} visible after click; dustFlags=${flagsForDownstreamChecks} (expected 2)`,
    });

    // ── UTXOs page: group-level "2 dust" badge + per-UTXO "Dust" badge ──────
    await page.goto(`${BASE_URL}utxos`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'dust-badge-audit-browser' });

    const groupBadge = page.getByTestId(`badge-dust-group-${OWNED_ADDR.slice(0, 8)}`);
    await groupBadge.waitFor({ state: 'visible', timeout: 30_000 });
    const groupBadgeText = (await groupBadge.textContent()) ?? '';
    steps.push({
      name: 'UTXOs page shows the group-level dust badge',
      passed: /2\s*dust/i.test(groupBadgeText),
      detail: `badge text: "${groupBadgeText.trim()}" (expected "2 dust")`,
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
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'dust-badge-audit-browser' });

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
      name: 'Privacy Audit contains both annotated dust findings',
      passed:
        annotated.length === 2 &&
        annotated.every((f) => f.description.includes(OWNED_ADDR)),
      detail:
        annotated.length === 2
          ? `finding #${annotated.map((f) => f.index).join(', #')}: both include the seeded address`
          : `found ${annotated.length} annotated dust finding(s) (expected exactly 2); all findings: ${JSON.stringify(findings)}`,
    });

    steps.push({
      name: 'both annotated dust findings are downgraded to Low severity',
      passed: annotated.length === 2 && annotated.every((f) => /^low$/i.test(f.severity)),
      detail:
        annotated.length === 2
          ? `severity badges: ${annotated.map((f) => `"${f.severity}"`).join(', ')} (expected all "Low")`
          : 'annotated findings missing, cannot check severity',
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
          ? 'only the annotated Low findings report these dust outputs'
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
