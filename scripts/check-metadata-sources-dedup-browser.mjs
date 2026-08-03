#!/usr/bin/env node
// Real-browser regression guard: re-running the SAME wallet file import must
// not grow the Metadata Sources panel (Task #1729).
//
// captureMergeOrigin de-dups value-identical re-imports at the unit level;
// the visible symptom was the Metadata Sources panel growing on every
// re-import. This check drives the actual Wallet Import wizard in a REAL
// headless Chromium:
//   1. Import a Sparrow JSON wallet file (creates records + creation origins).
//   2. Re-import the exact same file (all rows merge). The record's
//      Metadata Sources panel row count must stay flat while the latest
//      origin's timestamp refreshes.
//   3. Re-import a changed-label version of the file. The panel must gain
//      exactly one new origin row (changed values still append).
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-metadata-sources-dedup-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'metadata-sources-dedup-check-123';

const ADDR_COUNT = 3;
const TARGET_WALLET = 'DedupWallet';
// Sparrow adapter drops addresses with length <= 20 — keep these longer.
const ADDRS = Array.from({ length: ADDR_COUNT }, (_, i) => `bc1qmetasrcdedupcheck${String(i).padStart(3, '0')}`);
const PROBE_ADDR = ADDRS[0];

function sparrowFile(labelPrefix) {
  return JSON.stringify({
    wallet: 'sparrow',
    addresses: ADDRS.map((address, i) => ({ address, label: `${labelPrefix} ${i}` })),
  });
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

/** Run the full Wallet Import wizard for the given Sparrow JSON content. */
async function runImportWizard(page, fileContent, fileName) {
  await page.goto(`${BASE_URL}wallet-import`, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page);

  await page.setInputFiles('[data-testid="input-file-upload"]', {
    name: fileName,
    mimeType: 'application/json',
    buffer: Buffer.from(fileContent, 'utf8'),
  });
  await page.getByText(fileName).waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('button-next-step').click();

  // Setup step: pick the same target wallet name every run so re-imports are
  // value-identical.
  await page.getByTestId('select-wallet-name').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('select-wallet-name').click();
  const walletNameSearch = page.getByPlaceholder('Search or add new...').last();
  await walletNameSearch.waitFor({ state: 'visible', timeout: 10_000 });
  await walletNameSearch.fill(TARGET_WALLET);
  const exactItem = page.locator('[cmdk-item]').filter({ hasText: new RegExp(`^${TARGET_WALLET}$`) }).first();
  if (await exactItem.isVisible().catch(() => false)) {
    await exactItem.click();
  } else {
    await page.locator('[cmdk-item]').filter({ hasText: `Add "${TARGET_WALLET}"` }).first().click();
  }
  await page.getByTestId('button-next-step').click();

  // Preview step.
  await page.getByTestId('preview-record-0').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('button-next-step').click();

  // Import step.
  await page.getByText('Import Complete!').waitFor({ state: 'visible', timeout: 60_000 });
}

/** Read the probe record's id + its origin rows straight from IndexedDB. */
async function readOrigins(page, addr) {
  return page.evaluate(async ({ address }) => {
    const { db } = await import('/src/lib/database.ts');
    const record = await db.records.where('inputString').equals(address).first();
    if (!record?.id) return { recordId: null, origins: [] };
    const origins = await db.recordOrigins.where('recordId').equals(record.id).toArray();
    origins.sort((a, b) => b.createdAt - a.createdAt);
    return {
      recordId: record.id,
      origins: origins.map((o) => ({ id: o.id, originType: o.originType, source: o.source, label: o.label, createdAt: o.createdAt })),
    };
  }, { address: addr });
}

/** Open the record's detail via a real row click and read the Metadata Sources panel count + rows. */
async function readPanel(page, recordId) {
  await page.goto(`${BASE_URL}records`, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page);
  const row = page.getByTestId(`row-record-${recordId}`);
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  // Click a neutral cell (the Type cell) — the first cell is the selection
  // checkbox and other cells carry their own click handlers (address links).
  await row.locator('td').nth(1).click();
  const detailSeen = await page
    .getByText('Record Details')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  console.log(`[metadata-sources-dedup-browser] detail view opened for record ${recordId}: ${detailSeen}`);
  const toggle = page.getByTestId('button-toggle-sources');
  try {
    await toggle.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (err) {
    const bodyText = ((await page.locator('body').textContent().catch(() => '')) ?? '').slice(0, 800);
    console.log(`[metadata-sources-dedup-browser] panel missing for record ${recordId}; body: ${bodyText}`);
    throw err;
  }
  const headerText = ((await toggle.textContent()) ?? '').trim();
  const match = headerText.match(/Metadata Sources \((\d+)\)/);
  const headerCount = match ? Number(match[1]) : -1;
  await toggle.click();
  await page.getByTestId('list-metadata-sources').waitFor({ state: 'visible', timeout: 15_000 });
  const rowCount = await page.locator('[data-testid="list-metadata-sources"] [data-testid^="button-origin-"]').count();
  return { headerText, headerCount, rowCount };
}

async function main() {
  const exe = resolveChromium();
  console.log(`[metadata-sources-dedup-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[metadata-sources-dedup-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[metadata-sources-dedup-browser] starting dev server (npm run dev) ...`);
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    const ready = await waitForServer(BASE_URL, 90_000);
    if (!ready) throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
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
      console.log(`[metadata-sources-dedup-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }

  const steps = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1600 },
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[metadata-sources-dedup-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Import #1: creates the records (and their creation origins) ───────
    await runImportWizard(page, sparrowFile('Dedup label'), 'sparrow-dedup.json');
    const afterFirst = await readOrigins(page, PROBE_ADDR);
    steps.push({
      name: 'first import creates the probe record with origin history',
      passed: !!afterFirst.recordId && afterFirst.origins.length >= 1,
      detail: `recordId=${afterFirst.recordId} origins=${afterFirst.origins.length}`,
    });
    if (!afterFirst.recordId) throw new Error('probe record missing after first import');
    console.log(`[metadata-sources-dedup-browser] origins after first import: ${JSON.stringify(afterFirst.origins)}`);

    const panelAfterFirst = await readPanel(page, afterFirst.recordId);
    steps.push({
      name: 'Metadata Sources panel renders after the first import',
      passed: panelAfterFirst.headerCount === afterFirst.origins.length && panelAfterFirst.rowCount === panelAfterFirst.headerCount,
      detail: `header="${panelAfterFirst.headerText}" rows=${panelAfterFirst.rowCount}`,
    });

    // Small gap so the refreshed timestamp is strictly greater.
    await page.waitForTimeout(1_100);

    // ── Import #2: identical file — panel count must stay flat ────────────
    await runImportWizard(page, sparrowFile('Dedup label'), 'sparrow-dedup.json');
    const afterSecond = await readOrigins(page, PROBE_ADDR);
    const firstLatest = afterFirst.origins[0];
    const secondLatest = afterSecond.origins[0];
    steps.push({
      name: 'identical re-import does not add an origin row',
      passed: afterSecond.origins.length === afterFirst.origins.length,
      detail: `before=${afterFirst.origins.length} after=${afterSecond.origins.length}`,
    });
    steps.push({
      name: 'identical re-import refreshes the latest origin timestamp in place',
      passed:
        !!secondLatest &&
        secondLatest.id === firstLatest.id &&
        secondLatest.createdAt > firstLatest.createdAt,
      detail: `id ${firstLatest?.id}->${secondLatest?.id}, createdAt ${firstLatest?.createdAt}->${secondLatest?.createdAt}`,
    });

    const panelAfterSecond = await readPanel(page, afterSecond.recordId);
    steps.push({
      name: 'Metadata Sources panel row count stays flat after the identical re-import',
      passed:
        panelAfterSecond.headerCount === panelAfterFirst.headerCount &&
        panelAfterSecond.rowCount === panelAfterFirst.rowCount,
      detail: `header="${panelAfterSecond.headerText}" rows=${panelAfterSecond.rowCount} (was ${panelAfterFirst.rowCount})`,
    });

    // ── Import #3: changed labels — panel must gain exactly one row ───────
    await runImportWizard(page, sparrowFile('Changed label'), 'sparrow-dedup-v2.json');
    const afterThird = await readOrigins(page, PROBE_ADDR);
    steps.push({
      name: 'changed-value re-import still appends a new origin row',
      passed: afterThird.origins.length === afterSecond.origins.length + 1,
      detail: `before=${afterSecond.origins.length} after=${afterThird.origins.length}`,
    });

    const panelAfterThird = await readPanel(page, afterThird.recordId);
    steps.push({
      name: 'Metadata Sources panel shows exactly one more row after the changed-value re-import',
      passed:
        panelAfterThird.headerCount === panelAfterSecond.headerCount + 1 &&
        panelAfterThird.rowCount === panelAfterSecond.rowCount + 1,
      detail: `header="${panelAfterThird.headerText}" rows=${panelAfterThird.rowCount} (was ${panelAfterSecond.rowCount})`,
    });
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try { devProc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
  }

  const ok = steps.every((s) => s.passed);
  console.log(`[metadata-sources-dedup-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[metadata-sources-dedup-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[metadata-sources-dedup-browser] PASSED: identical re-imports keep the Metadata Sources panel flat (timestamp refreshes), changed values still append.');
}

main().catch((err) => {
  console.error('[metadata-sources-dedup-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
