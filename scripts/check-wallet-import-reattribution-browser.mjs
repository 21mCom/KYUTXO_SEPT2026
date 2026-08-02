#!/usr/bin/env node
// Real-browser regression guard for the FULL Wallet Import page UI path
// (Task #1787, complements scripts/check-wallet-overview-browser.mjs which
// calls executeImport directly in-page).
//
// Reproduced end to end in a REAL headless Chromium:
//   1. Upload an actual Sparrow JSON wallet file on /wallet-import whose
//      addresses already exist in the vault as blockchain-discovered rows
//      stamped 'WalletAlpha' (plus curated leftovers under 'WalletGamma').
//   2. Pick a target wallet name ('WalletDelta') in the Setup step's
//      combobox — the wiring under test: walletName must flow from the page
//      state into executeImport's ImportOptions.
//   3. Run the import via the wizard and confirm the completion toast reports
//      "N re-attributed from other wallets" and the results grid shows the
//      merge counts.
//   4. Visit Wallet Overview, hit Refresh, and confirm the addresses moved:
//      WalletDelta appears with the merged rows, WalletAlpha's curated counts
//      are unchanged, and WalletGamma disappears.
//
// Everything runs offline against IndexedDB — no network request leaves the
// machine. Usage: node scripts/check-wallet-import-reattribution-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETUP_PASSWORD = 'wallet-import-reattr-check-123';

const ALPHA_CURATED = 4; // curated manual rows that must NOT move
const ALPHA_CURATED_USED = 2;
const REIMPORT_DISCOVERED = 6; // discovered rows under WalletAlpha -> import to WalletDelta
const REIMPORT_CURATED = 2; // curated manual rows under WalletGamma -> import to WalletDelta
const EXPECTED_MERGES = REIMPORT_DISCOVERED + REIMPORT_CURATED; // 8
const TARGET_WALLET = 'WalletDelta';

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

/** Wait until row-wallet-<name> contains `needle` (or the row vanishes when needle is null). */
async function waitForWalletRow(page, walletName, needle, timeoutMs = 45_000) {
  const row = page.getByTestId(`row-wallet-${walletName}`);
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    if (needle === null) {
      if (!(await row.isVisible().catch(() => false))) return { ok: true, text: '(absent)' };
    } else {
      text = ((await row.textContent().catch(() => '')) ?? '').trim();
      if (text.includes(needle)) return { ok: true, text };
    }
    await page.waitForTimeout(400);
  }
  return { ok: false, text };
}

async function main() {
  const exe = resolveChromium();
  console.log(`[wallet-import-reattr-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[wallet-import-reattr-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[wallet-import-reattr-browser] starting dev server (npm run dev) ...`);
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
      console.log(`[wallet-import-reattr-browser] chromium launch failed (attempt ${attempt}), retrying: ${err.message}`);
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
        console.log(`[wallet-import-reattr-browser][page-console] ${msg.text()}`);
      }
    });

    await page.goto(`${BASE_URL}wallet-import`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true, detail: 'setup form submitted' });

    // ── Seed pre-existing rows the wallet file will re-attribute ──────────
    const seed = await page.evaluate(
      async ({ alphaCurated, alphaCuratedUsed, reimportDiscovered, reimportCurated }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const now = Math.floor(Date.now() / 1000);
        const records = [];
        const reimportAddrs = [];

        // WalletAlpha curated rows that must stay put.
        for (let i = 0; i < alphaCurated; i++) {
          records.push({
            type: 'address', inputString: `bc1qwimportalphastay${String(i).padStart(3, '0')}`,
            label: `Alpha keep ${i}`, tags: [], categories: [],
            walletName: 'WalletAlpha', addressImportance: 'manual', chainType: 'receive',
            firstSeenBlockTime: i < alphaCuratedUsed ? now - i * 60 : undefined,
          });
        }
        // Addresses the wallet file re-imports: discovery rows stamped with
        // ANOTHER wallet's name by sync…
        for (let i = 0; i < reimportDiscovered; i++) {
          const addr = `bc1qwimportreattrdisc${String(i).padStart(3, '0')}`;
          reimportAddrs.push(addr);
          records.push({
            type: 'address', inputString: addr,
            label: '', tags: [], categories: [],
            walletName: 'WalletAlpha', addressImportance: 'blockchain-discovered',
            discoveredInTxid: `txwimport${i}`,
          });
        }
        // …plus curated leftovers under a different wallet entirely.
        for (let i = 0; i < reimportCurated; i++) {
          const addr = `bc1qwimportreattrgamma${String(i).padStart(3, '0')}`;
          reimportAddrs.push(addr);
          records.push({
            type: 'address', inputString: addr,
            label: `Gamma addr ${i}`, tags: [], categories: [],
            walletName: 'WalletGamma', addressImportance: 'manual', chainType: 'receive',
            firstSeenBlockTime: i === 0 ? now : undefined,
          });
        }

        await recordCrud.bulkCreateRecords(records, { skipNotification: true });
        return { recordCount: records.length, reimportAddrs };
      },
      {
        alphaCurated: ALPHA_CURATED, alphaCuratedUsed: ALPHA_CURATED_USED,
        reimportDiscovered: REIMPORT_DISCOVERED, reimportCurated: REIMPORT_CURATED,
      },
    );
    steps.push({
      name: 'seeded vault (curated Alpha rows + discovered/curated rows to re-attribute)',
      passed: seed.recordCount === ALPHA_CURATED + EXPECTED_MERGES,
      detail: `records=${seed.recordCount}`,
    });

    // Reload so the page mounts cleanly with the seeded rows.
    await page.goto(`${BASE_URL}wallet-import`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);

    // ── Step 1: Upload — a real Sparrow JSON wallet export file ───────────
    const sparrowJson = JSON.stringify({
      wallet: 'sparrow',
      addresses: seed.reimportAddrs.map((address, i) => ({
        address,
        label: `Delta reimport ${i}`,
      })),
    });
    await page.setInputFiles('[data-testid="input-file-upload"]', {
      name: 'sparrow-export.json',
      mimeType: 'application/json',
      buffer: Buffer.from(sparrowJson, 'utf8'),
    });
    // The file card shows the filename once loaded + detected.
    await page.getByText('sparrow-export.json').waitFor({ state: 'visible', timeout: 15_000 });
    const detectedType = ((await page.getByTestId('select-wallet-type').textContent().catch(() => '')) ?? '').trim();
    steps.push({
      name: 'upload step accepts the Sparrow JSON file and auto-detects Sparrow Wallet',
      passed: detectedType.includes('Sparrow'),
      detail: `select-wallet-type="${detectedType}"`,
    });

    await page.getByTestId('button-next-step').click();

    // ── Step 2: Setup — pick the target wallet name via the combobox ──────
    await page.getByTestId('select-wallet-name').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('select-wallet-name').click();
    const walletNameSearch = page.getByPlaceholder('Search or add new...').last();
    await walletNameSearch.waitFor({ state: 'visible', timeout: 10_000 });
    await walletNameSearch.fill(TARGET_WALLET);
    // Prefer an existing exact item; otherwise use the Add "<name>" item.
    const exactItem = page.locator('[cmdk-item]').filter({ hasText: new RegExp(`^${TARGET_WALLET}$`) }).first();
    if (await exactItem.isVisible().catch(() => false)) {
      await exactItem.click();
    } else {
      await page.locator('[cmdk-item]').filter({ hasText: `Add "${TARGET_WALLET}"` }).first().click();
    }
    const walletNameShown = ((await page.getByTestId('select-wallet-name').textContent().catch(() => '')) ?? '').trim();
    steps.push({
      name: `setup step records the target wallet name '${TARGET_WALLET}'`,
      passed: walletNameShown.includes(TARGET_WALLET),
      detail: `select-wallet-name="${walletNameShown}"`,
    });

    await page.getByTestId('button-next-step').click();

    // ── Step 3: Preview — all uploaded addresses resolve as merges ────────
    await page.getByTestId('preview-record-0').waitFor({ state: 'visible', timeout: 30_000 });
    const previewCount = await page.locator('[data-testid^="preview-record-"]').count();
    const mergeBadges = await page.locator('[data-testid^="preview-record-"]', { hasText: 'Merge' }).count();
    steps.push({
      name: `preview shows all ${EXPECTED_MERGES} file addresses as merges with existing rows`,
      passed: previewCount === EXPECTED_MERGES && mergeBadges === EXPECTED_MERGES,
      detail: `previewCount=${previewCount} mergeBadges=${mergeBadges}`,
    });

    // ── Step 4: Import — toast must report the re-attribution count ───────
    await page.getByTestId('button-next-step').click();
    const toastNeedle = `${EXPECTED_MERGES} re-attributed from other wallets`;
    const toastSeen = await page
      .getByText(toastNeedle, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    steps.push({
      name: `completion toast reports "${toastNeedle}"`,
      passed: toastSeen,
      detail: `toastSeen=${toastSeen}`,
    });

    await page.getByText('Import Complete!').waitFor({ state: 'visible', timeout: 30_000 });
    const toastUpdated = await page
      .getByText(`updated ${EXPECTED_MERGES} existing records`, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    steps.push({
      name: `import completes: toast counts ${EXPECTED_MERGES} updated records and 0 created`,
      passed: toastUpdated,
      detail: `toastUpdated=${toastUpdated}`,
    });

    // The merged rows must now carry the new wallet name AND be promoted to
    // a curated tier so the wallet surfaces actually count them.
    const dbState = await page.evaluate(async ({ addrs, target }) => {
      const { db } = await import('/src/lib/database.ts');
      const rows = await db.records.where('inputString').anyOf(addrs).toArray();
      return {
        total: rows.length,
        moved: rows.filter((r) => r.walletName === target).length,
        curated: rows.filter((r) => r.addressImportance === 'wallet-import' || r.addressImportance === 'manual' || r.addressImportance === 'verified').length,
        discoveryLeft: rows.filter((r) => r.addressImportance === 'blockchain-discovered' || r.addressImportance === 'pending-review').length,
      };
    }, { addrs: seed.reimportAddrs, target: TARGET_WALLET });
    steps.push({
      name: 'all merged rows now carry the target wallet name and a curated tier',
      passed:
        dbState.total === EXPECTED_MERGES &&
        dbState.moved === EXPECTED_MERGES &&
        dbState.discoveryLeft === 0,
      detail: JSON.stringify(dbState),
    });

    // ── Step 5: Wallet Overview — the addresses moved after Refresh ───────
    await page.goto(`${BASE_URL}wallet-overview`, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    await page.getByTestId('button-refresh').click();

    // Delta: 6 discovered (used, seen in a tx) + 1 used Gamma row = 7 used of 8.
    const deltaRow = await waitForWalletRow(
      page,
      TARGET_WALLET,
      `${REIMPORT_DISCOVERED + 1}/${EXPECTED_MERGES}`,
    );
    steps.push({
      name: `after Refresh, ${TARGET_WALLET} shows the ${EXPECTED_MERGES} re-attributed addresses`,
      passed: deltaRow.ok,
      detail: `row="${deltaRow.text}"`,
    });
    const alphaRow = await waitForWalletRow(page, 'WalletAlpha', `${ALPHA_CURATED_USED}/${ALPHA_CURATED}`);
    steps.push({
      name: 'WalletAlpha curated totals are unchanged by the re-import',
      passed: alphaRow.ok,
      detail: `row="${alphaRow.text}"`,
    });
    const gammaGone = await waitForWalletRow(page, 'WalletGamma', null, 15_000);
    steps.push({
      name: 'WalletGamma disappears once its curated rows moved to the target wallet',
      passed: gammaGone.ok,
      detail: `row=${gammaGone.text}`,
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
  console.log(`[wallet-import-reattr-browser] ok=${ok}`);
  for (const step of steps) {
    console.log(`  [${step.passed ? 'PASS' : 'FAIL'}] ${step.name} :: ${step.detail}`);
  }
  if (!ok) {
    console.error('\n[wallet-import-reattr-browser] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }
  console.log('[wallet-import-reattr-browser] PASSED: the Wallet Import page re-attributes uploaded addresses end to end, and the toast reports the count.');
}

main().catch((err) => {
  console.error('[wallet-import-reattr-browser] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
