#!/usr/bin/env node
// Real-browser regression guard for the Privacy Audit **Adversary Knowledge
// Scenarios** feature ("what if they knew?").
//
// The unit tests cover the engine (adversary-scenario.test.ts,
// adversary-scenario.extend.test.ts) and persistence round-trips, but nothing
// proves the real page wiring: creating a scenario in the dialog with the
// searchable address/txid pickers, running it, and seeing the delta panel
// (narrative + badges + newly-linked addresses) render against the live
// audit data — plus that scenarios SURVIVE a reload and can be deleted.
//
// Seed design (deterministic delta):
//   - Two owned address records: A1 and B2 (both with chainType ground truth,
//     so no degradation banner).
//   - ONE transaction T3: inputs [A1, U1(unknown)] and outputs [CP(small,
//     external), B2(large, owned)].
//   - A blind analyst guesses the SMALL external output CP is change and
//     co-inputs A1 only with the unknown U1 → baseline exposure is EMPTY.
//   - The scenario assumes TestExchange knows address B2 and transaction T3.
//     T3's participant graph becomes adversary-visible evidence: the owned
//     large output B2 is attributable by elimination (the counterparty knows
//     CP is their own payment), and B2's known-ownership collapses everything
//     into one certain-tier cluster → delta = 2 newly linked addresses
//     (A1 and B2), both "certain".
//
// The script drives the actual page in headless Chromium:
//   1. Creates a fresh vault via the setup form.
//   2. Seeds records + the transaction via Vite dynamic imports of the live
//      CRUD singletons (same module graph the app uses).
//   3. Creates a scenario through the real dialog (address + txid pickers).
//   4. Runs it and asserts the delta panel: badge counts, narrative text, and
//      the newly-linked address list with confidence badges.
//   5. Reloads (proving persistence) and deletes the scenario.
//
// Everything runs offline against local IndexedDB — no network requests.
//
// Usage: node scripts/check-adversary-scenario-browser.mjs
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
const AUDIT_URL = `${BASE_URL}privacy-audit`;
const SETUP_PASSWORD = 'adversary-scenario-check-123';

// Owned records. 42-char bc1q so getScriptType classifies them (short fakes
// degrade every heuristic's confidence tier).
const ADDR_A1 = 'bc1qscenowna' + 'a'.repeat(30); // 42-char P2WPKH
const ADDR_B2 = 'bc1qscenownb' + 'b'.repeat(30); // 42-char P2WPKH
// Unknown co-input + external payment output (no records for these).
const ADDR_U1 = 'bc1qscenunk1' + 'c'.repeat(30); // 42-char P2WPKH
const ADDR_CP = 'bc1qscenextp' + 'd'.repeat(30); // 42-char P2WPKH
const T3 = 'b35c'.repeat(16); // 64 hex-ish chars

for (const [name, addr] of [
  ['ADDR_A1', ADDR_A1],
  ['ADDR_B2', ADDR_B2],
  ['ADDR_U1', ADDR_U1],
  ['ADDR_CP', ADDR_CP],
]) {
  if (addr.length !== 42) {
    throw new Error(`${name} must be 42 chars (got ${addr.length}) or getScriptType returns "unknown"`);
  }
}

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
  console.log(`[adversary-scenario-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[adversary-scenario-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[adversary-scenario-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[adversary-scenario-browser] dev server ready at ${BASE_URL}`);
  }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const steps = [];
  const record = (name, passed, detail) => steps.push({ name, passed, detail });

  try {
    // Fresh context => empty IndexedDB => the login screen shows the "Create
    // Vault" setup form. Block the PWA service worker so it cannot reload the
    // page mid-flow.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[adversary-scenario-browser][page-console] ${t}`);
      }
    });

    await page.goto(AUDIT_URL, { waitUntil: 'load', timeout: 60_000 });

    // ── Create the vault (setup flow) ──────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    // ── Wait for the Privacy Audit page to render ──────────────────────────
    await page.getByTestId('button-run-audit').waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed records + transaction (live CRUD singletons) ─────────────────
    await page.evaluate(
      async ({ a1, b2, u1, cp, txid }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        await recordCrud.createRecord({
          type: 'address',
          inputString: a1,
          label: 'Scenario check A1',
          chainType: 'receive',
        });
        await recordCrud.createRecord({
          type: 'address',
          inputString: b2,
          label: 'Scenario check B2',
          chainType: 'receive',
        });

        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({
          txid,
          blockHeight: 800_000,
          blockTime: now - 3600,
          fee: 1000,
          feeRate: 5,
          syncedAt: Date.now(),
        });
        // Inputs: one owned, one unknown (no record).
        await txCrud.addParticipant({ txid, role: 'input', address: a1, amount: 8_000, vout: 0 });
        await txCrud.addParticipant({ txid, role: 'input', address: u1, amount: 6_000, vout: 1 });
        // Outputs: SMALL external payment (the counterparty's own address —
        // a blind analyst guesses it is change) and LARGE owned output.
        await txCrud.addParticipant({ txid, role: 'output', address: cp, amount: 1_000, vout: 0 });
        await txCrud.addParticipant({ txid, role: 'output', address: b2, amount: 9_000, vout: 1 });
        return true;
      },
      { a1: ADDR_A1, b2: ADDR_B2, u1: ADDR_U1, cp: ADDR_CP, txid: T3 },
    );
    record('seed', true, 'records + transaction seeded');

    // ── The scenarios panel is present with an empty state ─────────────────
    await page.getByTestId('container-adversary-scenarios').waitFor({ state: 'visible', timeout: 15_000 });
    const emptyVisible = await page.getByTestId('text-no-scenarios').isVisible();
    record('empty-state', emptyVisible, 'scenarios panel renders with the empty state before any scenario exists');

    // ── Create a scenario through the real dialog ──────────────────────────
    await page.getByTestId('button-new-scenario').click();
    await page.getByTestId('dialog-scenario-editor').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('input-scenario-name').fill('Exchange KYC leak');
    await page.getByTestId('input-scenario-counterparty').fill('TestExchange');

    // Address picker: search for B2 (prefix search over vault records).
    await page.getByTestId('input-scenario-address-search').fill(ADDR_B2);
    const addAddrBtn = page.getByTestId(`button-add-known-address-${ADDR_B2.slice(0, 10)}`);
    await addAddrBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await addAddrBtn.click();

    // Txid picker: prefix search over synced history.
    await page.getByTestId('input-scenario-txid-search').fill(T3.slice(0, 16));
    const addTxBtn = page.getByTestId(`button-add-known-txid-${T3.slice(0, 10)}`);
    await addTxBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await addTxBtn.click();

    await page.getByTestId('button-save-scenario').click();
    await page.getByTestId('dialog-scenario-editor').waitFor({ state: 'hidden', timeout: 10_000 });

    const scenarioId = await page.evaluate(async () => {
      const crud = await import('/src/lib/data/adversary-scenarios-crud.ts');
      const rows = await crud.getAllAdversaryScenarios();
      return rows.length === 1 ? rows[0].id : null;
    });
    record(
      'scenario-created',
      typeof scenarioId === 'number',
      `scenario saved via dialog (id=${scenarioId})`,
    );
    if (typeof scenarioId !== 'number') throw new Error('Scenario was not persisted');

    const card = page.getByTestId(`card-scenario-${scenarioId}`);
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    const cpBadge = await card.getByTestId('badge-scenario-counterparty').textContent();
    record(
      'scenario-card',
      (cpBadge || '').trim() === 'TestExchange',
      `scenario card lists the counterparty badge ("${(cpBadge || '').trim()}")`,
    );

    // ── Run the scenario and assert the delta panel ────────────────────────
    await card.getByTestId(`button-run-scenario-${scenarioId}`).click();
    const delta = card.getByTestId('container-scenario-delta');
    await delta.waitFor({ state: 'visible', timeout: 60_000 });

    const newlyBadge = await delta.getByTestId('badge-scenario-newly-exposed-count').textContent();
    record(
      'delta-newly-linked-badge',
      (newlyBadge || '').includes('2 newly linked'),
      `newly-linked badge reads "${(newlyBadge || '').trim()}"`,
    );

    const narrative = await delta.getByTestId('text-scenario-narrative').textContent();
    record(
      'delta-narrative',
      (narrative || '').includes('lets TestExchange connect 2 more of your addresses') &&
        (narrative || '').includes('with certainty'),
      `narrative: "${(narrative || '').trim()}"`,
    );

    const deltaText = (await delta.textContent()) || '';
    record(
      'delta-baseline-vs-scenario',
      deltaText.includes('baseline exposed: 0') && deltaText.includes('with knowledge: 2'),
      'summary compares blind baseline (0 exposed) with the informed view (2 exposed)',
    );

    // Details default to expanded: both newly linked addresses render with a
    // "certain" confidence badge.
    const confBadges = await delta.getByTestId('badge-scenario-address-confidence').allTextContents();
    record(
      'delta-address-list',
      confBadges.length === 2 && confBadges.every((t) => t.trim() === 'certain'),
      `newly-linked addresses listed with confidence badges [${confBadges.join(', ')}]`,
    );
    record(
      'delta-address-links',
      deltaText.includes(ADDR_A1.slice(0, 8)) && deltaText.includes(ADDR_B2.slice(0, 8)),
      'newly-linked addresses render as record links',
    );

    // ── Delete a referenced record: the live missing-assumptions notice ────
    // The scenario's saved assumptions reference record B2 + transaction T3.
    // Deleting B2's record must surface the "no longer match anything in this
    // vault" notice via the live useLiveQuery wiring — WITHOUT a re-run.
    const noticeBefore = await card.getByTestId('notice-scenario-unresolved-refs').count();
    record(
      'unresolved-notice-absent-before-delete',
      noticeBefore === 0,
      'no missing-assumptions notice while every reference resolves',
    );

    await page.evaluate(async ({ b2 }) => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const rows = await recordCrud.getRecordsByInputStrings([b2]);
      if (rows.length !== 1 || rows[0].id == null) {
        throw new Error(`Expected exactly one record for B2, got ${rows.length}`);
      }
      await recordCrud.deleteRecord(rows[0].id);
    }, { b2: ADDR_B2 });

    const notice = card.getByTestId('notice-scenario-unresolved-refs');
    await notice.waitFor({ state: 'visible', timeout: 15_000 });
    const noticeText = (await notice.textContent()) || '';
    record(
      'unresolved-notice-appears-live',
      noticeText.includes('1 saved assumption no longer matches anything in this vault') &&
        noticeText.includes('1 address'),
      `notice appears live after deleting the referenced record: "${noticeText.trim()}"`,
    );

    // The scenario must still run with the unresolved reference excluded.
    await card.getByTestId(`button-run-scenario-${scenarioId}`).click();
    // The delta hides while the run is in flight; wait for it to settle back.
    const deltaAfterDelete = card.getByTestId('container-scenario-delta');
    try {
      await deltaAfterDelete.waitFor({ state: 'hidden', timeout: 3_000 });
    } catch {
      /* run may complete faster than the hidden state is observable */
    }
    await deltaAfterDelete.waitFor({ state: 'visible', timeout: 60_000 });
    const runFailedToast = await page.getByText('Scenario Run Failed').count();
    const noticeStill = await card.getByTestId('notice-scenario-unresolved-refs').isVisible();
    record(
      'scenario-still-runs',
      noticeStill && runFailedToast === 0,
      'scenario re-runs to a delta (no failure toast) while the missing-assumptions notice stays visible',
    );

    // ── Reload: the scenario persists (it rides the local database) ────────
    await page.reload({ waitUntil: 'load' });
    const unlockInput = page.getByTestId('input-password');
    await unlockInput.waitFor({ state: 'visible', timeout: 30_000 });
    await unlockInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();
    await page.getByTestId('button-run-audit').waitFor({ state: 'visible', timeout: 30_000 });

    const cardAfterReload = page.getByTestId(`card-scenario-${scenarioId}`);
    await cardAfterReload.waitFor({ state: 'visible', timeout: 15_000 });
    record('scenario-persists', true, 'scenario survives a reload + re-unlock');

    // ── Delete the scenario ────────────────────────────────────────────────
    await cardAfterReload.getByTestId(`button-delete-scenario-${scenarioId}`).click();
    await page.getByTestId('dialog-delete-scenario').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('button-confirm-delete-scenario').click();
    await page.getByTestId('text-no-scenarios').waitFor({ state: 'visible', timeout: 10_000 });
    record('scenario-delete', true, 'delete confirmation removes the scenario');
  } catch (err) {
    record('fatal', false, String(err && err.stack ? err.stack : err));
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

  console.log(`[adversary-scenario-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[adversary-scenario-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[adversary-scenario-browser] PASSED: scenario create → run → delta panel (newly-linked badges, narrative, confidence) → persistence → delete all work in a real browser.',
  );
}

main().catch((err) => {
  console.error('[adversary-scenario-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
