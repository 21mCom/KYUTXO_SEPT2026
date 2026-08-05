#!/usr/bin/env node
// Real-browser check for the Database Doctor "Clear stale type fields" repair
// (task: "Confirm the new 'Clear stale type fields' repair works end-to-end in
// a real browser").
//
// Node-level vitest already proves repairStaleTypeSpecificFields deletes only
// the stale fields (record-crud.staleTypeFields.test.ts). What it cannot see
// is the end-to-end wiring in a real Chromium against real IndexedDB: the
// health-check scan counting the rows (stat-stale-type-fields), the repair
// button (button-repair-type-fields) invoking the repair, the automatic
// re-scan, and the structured-clone behavior that must truly DROP the stale
// keys from the stored rows. This script:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds four records:
//      - STALE address carrying transaction-only flowType + dispositionType
//      - STALE transaction carrying address-only counterpartyType/-Name
//      - STALE 'other' carrying costBasisUsd (number 0 counts as present)
//      - HEALTHY address with a legitimate counterpartyName + costBasisUsd
//        (both valid on addresses) that the repair must NOT touch
//   3. on /database-doctor, runs the health check and asserts
//      stat-stale-type-fields shows 3
//   4. clicks "Clear stale type fields" (button-repair-type-fields) and waits
//      for the automatic re-scan to show 0
//   5. asserts in IndexedDB that the stale keys are GONE from the stored rows
//      (key absence via `in`, not just undefined), updatedAt was bumped on
//      the three repaired rows, and the healthy row kept its fields AND its
//      original updatedAt
//
// NOTE for reviewers: the stat line and repair button live in
// client/src/pages/DatabaseDoctor.tsx (RecordStats.staleTypeFields /
// RepairToolsCard); the repair is repairStaleTypeSpecificFields in
// client/src/lib/data/record-crud.ts, sharing the mapping in
// client/src/lib/record-type-clears.ts.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-database-doctor-type-fields-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const DOCTOR_URL = `${BASE_URL}database-doctor`;
const SETUP_PASSWORD = 'dbdoctor-typefields-check-123';

const STALE_ADDR = 'bc1qddtypefieldsstaleaddr00000001check';
const STALE_TXID = 'ddf1'.padEnd(64, 'a');
const STALE_OTHER = 'stale-other-note-typefields-check';
const HEALTHY_ADDR = 'bc1qddtypefieldshealthyaddr000001check';

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

async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 30_000 })
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

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[dbdoctor-typefields] legacy-migration overlay detected; waiting it out ...');
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

async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(
        `[dbdoctor-typefields] goto ${url} failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dbdoctor-typefields] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dbdoctor-typefields] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dbdoctor-typefields] starting dev server (npm run dev) ...`);
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
    console.log(`[dbdoctor-typefields] dev server ready at ${BASE_URL}`);
  }

  // Retry launch: chromium can hit pthread_create EAGAIN under parallel
  // validation load.
  let browser = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(
        `[dbdoctor-typefields] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[dbdoctor-typefields][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await gotoWithRetry(page, BASE_URL);
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed: three stale-typed records + one healthy record ───────────────
    const seed = await page.evaluate(
      async ({ staleAddr, staleTxid, staleOther, healthyAddr }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');

        // Seeded with an OLD updatedAt so the repair's fresh stamp is
        // unambiguously "bumped" and the healthy row's is unambiguously
        // "unchanged".
        const oldStamp = Date.now() - 86_400_000;
        const ids = await recordCrud.bulkCreateRecords(
          [
            {
              // Address carrying transaction-only metadata → stale.
              type: 'address',
              inputString: staleAddr,
              label: 'DD stale address',
              flowType: 'incoming',
              dispositionType: 'sold',
              updatedAt: oldStamp,
            },
            {
              // Transaction carrying address-only metadata → stale.
              type: 'transaction',
              inputString: staleTxid,
              label: 'DD stale transaction',
              counterpartyType: 'exchange',
              counterpartyName: 'Old Exchange',
              updatedAt: oldStamp,
            },
            {
              // 'other' renders no type-specific metadata at all; a numeric 0
              // cost basis still counts as present → stale.
              type: 'other',
              inputString: staleOther,
              label: 'DD stale other',
              costBasisUsd: 0,
              updatedAt: oldStamp,
            },
            {
              // Healthy address: counterpartyName + costBasisUsd are BOTH
              // legitimate on addresses — must never be touched.
              type: 'address',
              inputString: healthyAddr,
              label: 'DD healthy address',
              counterpartyType: 'exchange',
              counterpartyName: 'Kept Exchange',
              costBasisUsd: 123.45,
              updatedAt: oldStamp,
            },
          ],
          { skipVocabularySync: true, skipNotification: true },
        );

        const rows = await db.records.where('id').anyOf(ids).toArray();
        return {
          ids,
          seeded: rows.map((r) => ({
            id: r.id,
            type: r.type,
            updatedAt: r.updatedAt,
            hasFlowType: 'flowType' in r,
            hasDisposition: 'dispositionType' in r,
            hasCpType: 'counterpartyType' in r,
            hasCpName: 'counterpartyName' in r,
            hasCostBasis: 'costBasisUsd' in r,
          })),
        };
      },
      {
        staleAddr: STALE_ADDR,
        staleTxid: STALE_TXID,
        staleOther: STALE_OTHER,
        healthyAddr: HEALTHY_ADDR,
      },
    );
    const [staleAddrId, staleTxId, staleOtherId, healthyId] = seed.ids;
    const seededById = new Map(seed.seeded.map((r) => [r.id, r]));
    steps.push({
      name: 'seeded 3 stale-typed records and 1 healthy record',
      passed:
        seed.ids.length === 4 &&
        seededById.get(staleAddrId)?.hasFlowType === true &&
        seededById.get(staleTxId)?.hasCpName === true &&
        seededById.get(staleOtherId)?.hasCostBasis === true &&
        seededById.get(healthyId)?.hasCostBasis === true,
      detail: JSON.stringify(seed.seeded),
    });

    // ── Database Doctor: run the health check ──────────────────────────────
    await gotoWithRetry(page, DOCTOR_URL);
    await unlockIfNeeded(page);

    await page.getByTestId('button-run-check').click();
    const stat = page.getByTestId('stat-stale-type-fields');
    await stat.waitFor({ state: 'visible', timeout: 120_000 });
    const beforeCount = ((await stat.textContent()) ?? '').trim();
    steps.push({
      name: 'health check counts the 3 stale-typed records',
      passed: beforeCount === '3',
      detail: `stat-stale-type-fields="${beforeCount}"`,
    });

    // ── Click the repair button (the real UI control under test) ───────────
    const repairBtn = page.getByTestId('button-repair-type-fields');
    await repairBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await repairBtn.click();

    // The card re-runs the full health check after the repair; wait for the
    // stat to drop to 0.
    await page
      .getByTestId('stat-stale-type-fields')
      .filter({ hasText: /^0$/ })
      .waitFor({ state: 'visible', timeout: 120_000 })
      .catch(() => {});
    // Poll as a fallback (filter+hasText on an exact "0" can be finicky).
    let afterCount = '';
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      afterCount = ((await page.getByTestId('stat-stale-type-fields').textContent().catch(() => '')) ?? '').trim();
      if (afterCount === '0') break;
      await page.waitForTimeout(500);
    }
    steps.push({
      name: 'repair ran and the automatic re-scan reports 0 stale-typed records',
      passed: afterCount === '0',
      detail: `stat-stale-type-fields="${afterCount}"`,
    });

    // ── DB-level assertions after the UI-driven repair ──────────────────────
    const after = await page.evaluate(
      async ({ ids }) => {
        const { db } = await import('/src/lib/database.ts');
        const rows = await db.records.where('id').anyOf(ids).toArray();
        return rows.map((r) => ({
          id: r.id,
          type: r.type,
          updatedAt: r.updatedAt,
          // Key ABSENCE (structured-clone truth), not merely undefined.
          hasFlowType: 'flowType' in r,
          hasDisposition: 'dispositionType' in r,
          hasCpType: 'counterpartyType' in r,
          hasCpName: 'counterpartyName' in r,
          hasCostBasis: 'costBasisUsd' in r,
          cpName: r.counterpartyName ?? null,
          costBasisUsd: r.costBasisUsd ?? null,
        }));
      },
      { ids: seed.ids },
    );
    const afterById = new Map(after.map((r) => [r.id, r]));
    const a = afterById.get(staleAddrId);
    const t = afterById.get(staleTxId);
    const o = afterById.get(staleOtherId);
    const h = afterById.get(healthyId);

    steps.push({
      name: 'stale address dropped flowType/dispositionType from IndexedDB',
      passed: !!a && !a.hasFlowType && !a.hasDisposition,
      detail: JSON.stringify(a),
    });
    steps.push({
      name: 'stale transaction dropped counterpartyType/counterpartyName',
      passed: !!t && !t.hasCpType && !t.hasCpName,
      detail: JSON.stringify(t),
    });
    steps.push({
      name: "stale 'other' dropped costBasisUsd (0 counted as present)",
      passed: !!o && !o.hasCostBasis,
      detail: JSON.stringify(o),
    });
    steps.push({
      name: 'repaired rows got a bumped updatedAt',
      passed: [a, t, o].every(
        (r) => !!r && r.updatedAt > (seededById.get(r.id)?.updatedAt ?? Infinity),
      ),
      detail: JSON.stringify(
        [a, t, o].map((r) => ({
          id: r?.id,
          before: seededById.get(r?.id)?.updatedAt,
          after: r?.updatedAt,
        })),
      ),
    });
    steps.push({
      name: 'healthy address kept its fields and its original updatedAt',
      passed:
        !!h &&
        h.hasCpType &&
        h.hasCpName &&
        h.hasCostBasis &&
        h.cpName === 'Kept Exchange' &&
        h.costBasisUsd === 123.45 &&
        h.updatedAt === seededById.get(healthyId)?.updatedAt,
      detail: JSON.stringify({ after: h, seededUpdatedAt: seededById.get(healthyId)?.updatedAt }),
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

  console.log(`[dbdoctor-typefields] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dbdoctor-typefields] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    "[dbdoctor-typefields] PASSED: the Database Doctor 'Clear stale type fields' repair removes stale type-specific metadata end-to-end (fields gone from IndexedDB, updatedAt bumped, re-scan shows 0) without touching healthy rows.",
  );
}

main().catch((err) => {
  console.error('[dbdoctor-typefields] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
