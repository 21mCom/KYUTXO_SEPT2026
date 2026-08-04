#!/usr/bin/env node
// Real-browser check for the Database Doctor "Duplicate identifier records"
// card (task: "Confirm the duplicate-records list opens the right record in a
// real browser").
//
// The jsdom test (DatabaseDoctor.duplicateIdentifiers.test.tsx) mocks the
// preview context, so the true end-to-end path — RecordPreviewProvider
// building the panel record from the vault, click handling on the duplicate
// rows, and the pagination controls rendering in a real DOM — is unverified.
// This script:
//   1. creates a fresh vault (fresh browser context => empty IndexedDB)
//   2. seeds 12 collision groups: each has a canonical record (via the CRUD
//      layer) plus a second record whose inputString is raw-updated to a
//      padded/UPPERCASE variant of the same bech32 address, emulating rows
//      written before identifiers were canonicalized on save
//   3. runs the health check on /database-doctor and waits for the
//      "Duplicate identifier records" card
//   4. clicks the non-canonical row of the first group and asserts the shared
//      record detail panel opens showing THAT record's stored identifier
//   5. closes the panel, clicks the canonical sibling, and asserts the panel
//      now shows the canonical identifier (right record per row, not just
//      "a" record)
//   6. pages to page 2 (12 groups > 10 per page) and opens a row there,
//      asserting pagination wires ids through correctly
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-database-doctor-duplicates-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const DOCTOR_URL = `${BASE_URL}database-doctor`;
const SETUP_PASSWORD = 'dbdoctor-duplicates-check-123';

const GROUPS = 12; // > 10 per page => pagination renders

function addrOf(i) {
  // Lenient bech32-shaped mainnet address; unique per group.
  return `bc1qdupdoctor${String(i).padStart(2, '0')}${'q'.repeat(24)}check`;
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

async function unlockIfNeeded(page) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 15_000 })
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
  console.log('[dbdoctor-duplicates-browser] legacy-migration overlay detected; waiting it out ...');
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

/** Open a duplicate row and return the detail-panel identifier text. */
async function openRowAndReadPanel(page, rowId) {
  const rowButton = page.getByTestId(`button-open-duplicate-${rowId}`);
  await rowButton.waitFor({ state: 'visible', timeout: 30_000 });
  await rowButton.click();
  const panelId = page.getByTestId('text-panel-identifier');
  await panelId.waitFor({ state: 'visible', timeout: 30_000 });
  const text = ((await panelId.textContent()) ?? '').trim();
  // Close the sheet (RecordDetailPanel is a Radix Sheet; Escape triggers
  // onOpenChange -> closePreview).
  await page.keyboard.press('Escape');
  await panelId.waitFor({ state: 'hidden', timeout: 15_000 });
  return text;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[dbdoctor-duplicates-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[dbdoctor-duplicates-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[dbdoctor-duplicates-browser] starting dev server (npm run dev) ...`);
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
    console.log(`[dbdoctor-duplicates-browser] dev server ready at ${BASE_URL}`);
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
        `[dbdoctor-duplicates-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`,
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
        console.log(`[dbdoctor-duplicates-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed collision groups ───────────────────────────────────────────────
    // Canonical record via the CRUD layer; the duplicate sibling is created
    // via CRUD with a placeholder identifier, then raw-updated to a
    // padded/UPPERCASE variant of the same address. The raw update emulates
    // rows stored before canonicalization on save existed (createRecord would
    // canonicalize the identifier and never produce this state).
    const seed = await page.evaluate(
      async ({ groups, addrs }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const { db } = await import('/src/lib/database.ts');
        const out = [];
        for (let i = 0; i < groups; i++) {
          const addr = addrs[i];
          const canonicalId = await recordCrud.createRecord({
            type: 'address',
            inputString: addr,
            label: `Keep ${i}`,
          });
          const placeholder = `bc1qdupplaceholder${String(i).padStart(2, '0')}${'p'.repeat(20)}x`;
          const dupId = await recordCrud.createRecord({
            type: 'address',
            inputString: placeholder,
            label: `Dup ${i}`,
          });
          const nonCanonical = `  ${addr.toUpperCase()}  `;
          await db.records.update(dupId, {
            inputString: nonCanonical,
            inputStringLower: nonCanonical.toLowerCase(),
          });
          out.push({ canonicalId, dupId });
        }
        // Sanity: the duplicate rows really are stored non-canonically.
        const check = await db.records.get(out[0].dupId);
        return { pairs: out, dup0Stored: check?.inputString ?? null };
      },
      { groups: GROUPS, addrs: Array.from({ length: GROUPS }, (_, i) => addrOf(i)) },
    );
    const seedOk =
      seed.pairs.length === GROUPS && seed.dup0Stored === `  ${addrOf(0).toUpperCase()}  `;
    steps.push({
      name: `seeded ${GROUPS} collision groups (canonical + padded/UPPERCASE sibling)`,
      passed: seedOk,
      detail: `pairs=${seed.pairs.length} dup0Stored=${JSON.stringify(seed.dup0Stored)}`,
    });
    if (!seedOk) throw new Error('seeding failed; aborting');

    // ── Run the health check on the Database Doctor page ────────────────────
    await page.goto(DOCTOR_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    await page.getByTestId('button-run-check').click();

    const card = page.getByTestId('card-duplicate-identifiers');
    const cardVisible = await card
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: 'health check surfaces the Duplicate identifier records card',
      passed: cardVisible,
      detail: cardVisible ? 'card visible after scan' : 'card never appeared',
    });
    if (!cardVisible) throw new Error('duplicate card missing; aborting');

    // Pagination renders (12 groups over a 10-per-page cap).
    const pageLabel = ((await page.getByTestId('text-duplicates-page').textContent().catch(() => '')) ?? '').trim();
    steps.push({
      name: 'pagination controls render with the right group count',
      passed: /Page 1 of 2/.test(pageLabel) && /12/.test(pageLabel),
      detail: `text-duplicates-page=${JSON.stringify(pageLabel)}`,
    });

    // ── Click the NON-canonical row of group 0: panel shows that record ─────
    const { canonicalId: keep0, dupId: dup0 } = seed.pairs[0];
    const dupPanelText = await openRowAndReadPanel(page, dup0);
    steps.push({
      name: 'clicking the non-canonical duplicate row opens ITS record in the detail panel',
      passed: dupPanelText.includes(addrOf(0).toUpperCase()),
      detail: `panel identifier=${JSON.stringify(dupPanelText)} expected to contain ${addrOf(0).toUpperCase()}`,
    });

    // ── Click the canonical sibling: panel shows the OTHER record ───────────
    const keepPanelText = await openRowAndReadPanel(page, keep0);
    steps.push({
      name: 'clicking the canonical sibling row opens the canonical record instead',
      passed: keepPanelText.includes(addrOf(0)) && !keepPanelText.includes(addrOf(0).toUpperCase()),
      detail: `panel identifier=${JSON.stringify(keepPanelText)} expected ${addrOf(0)}`,
    });

    // ── Page 2: a row beyond the first 10 groups still opens correctly ──────
    await page.getByTestId('button-duplicates-next').click();
    const page2Label = ((await page.getByTestId('text-duplicates-page').textContent().catch(() => '')) ?? '').trim();
    const lastPair = seed.pairs[GROUPS - 1];
    const page2PanelText = await openRowAndReadPanel(page, lastPair.dupId);
    steps.push({
      name: 'after paging, a page-2 duplicate row opens the right record',
      passed:
        /Page 2 of 2/.test(page2Label) &&
        page2PanelText.includes(addrOf(GROUPS - 1).toUpperCase()),
      detail: `page label=${JSON.stringify(page2Label)} panel identifier=${JSON.stringify(page2PanelText)}`,
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

  console.log(`[dbdoctor-duplicates-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }

  if (!ok) {
    console.error('\n[dbdoctor-duplicates-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[dbdoctor-duplicates-browser] PASSED: the duplicate-records list opens the right record in the shared detail panel, including across pagination, in a real browser.',
  );
}

main().catch((err) => {
  console.error('[dbdoctor-duplicates-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
