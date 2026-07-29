#!/usr/bin/env node
// Real-browser regression guard for the BIP-329 label export on the Backup
// (/export) page: seeding labeled address/tx/output records and clicking the
// "Export Labels (BIP-329 .jsonl)" button must download a JSONL file whose
// lines round-trip the seeded labels ({type, ref, label, ...} per line).
//
// The vitest node check (client/src/lib/bip329.test.ts) covers the pure
// record -> line conversion; this check covers the live wiring: the Dexie
// cursor read, blob construction, and the anchor-click download in a real
// Chromium.
//
// Usage: node scripts/check-bip329-export-browser.mjs
// Requires: `chromium` on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const EXPORT_URL = `${BASE_URL}export`;
const SETUP_PASSWORD = 'bip329-export-check-1';

const ADDR = 'bc1qbip329exportcheckaddressxxxxxxxxxxxx';
const ADDR_LABEL = 'BIP-329 export check address';
const TXID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0aabb';
const TX_LABEL = 'BIP-329 export check tx';
const OUTPOINT = `${'b'.repeat(63)}c`.slice(0, 64) + ':1';
const OUTPUT_LABEL = 'BIP-329 export check output';

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
  console.log('[bip329-export-browser] legacy-migration overlay detected; waiting it out ...');
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
    } catch (err) {
      lastErr = err;
      console.log(`[bip329-export-browser] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const exe = resolveChromium();
  console.log(`[bip329-export-browser] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[bip329-export-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[bip329-export-browser] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
  }

  const browser = await launchWithRetry(exe);
  const steps = [];

  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[bip329-export-browser][page-console] ${msg.text()}`);
      }
    });

    // ── Create the vault ────────────────────────────────────────────────────
    await page.goto(EXPORT_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page);
    steps.push({ name: 'vault created and app unlocked', passed: true });

    // ── Seed labeled records (address, tx, output) via the app's own CRUD ───
    await page.evaluate(
      async ({ addr, addrLabel, txid, txLabel, outpoint, outputLabel }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: addrLabel,
        });
        await recordCrud.createRecord({
          type: 'transaction',
          inputString: txid,
          label: txLabel,
        });
        await recordCrud.createRecord({
          type: 'transaction',
          inputString: outpoint,
          label: outputLabel,
          notes: 'BIP-329 output at index 1. Spendable: false',
        });
      },
      { addr: ADDR, addrLabel: ADDR_LABEL, txid: TXID, txLabel: TX_LABEL, outpoint: OUTPOINT, outputLabel: OUTPUT_LABEL }
    );
    steps.push({ name: 'seeded labeled address/tx/output records', passed: true });

    // ── Click the BIP-329 export button and capture the download ────────────
    const exportButton = page.getByTestId('button-export-bip329');
    await exportButton.waitFor({ state: 'visible', timeout: 30_000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await exportButton.click();
    const download = await downloadPromise;

    const suggested = download.suggestedFilename();
    if (!/^kyutxo-labels-bip329-\d{4}-\d{2}-\d{2}\.jsonl$/.test(suggested)) {
      throw new Error(`Unexpected download filename: ${suggested}`);
    }
    const filePath = await download.path();
    const content = await readFile(filePath, 'utf8');
    steps.push({ name: `downloaded ${suggested}`, passed: true });

    // ── Verify JSONL content round-trips the seeded labels ──────────────────
    const lines = content
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));

    const byRef = new Map(lines.map((l) => [l.ref, l]));
    const addrLine = byRef.get(ADDR);
    if (!addrLine || addrLine.type !== 'addr' || addrLine.label !== ADDR_LABEL) {
      throw new Error(`addr line wrong or missing: ${JSON.stringify(addrLine)}`);
    }
    const txLine = byRef.get(TXID);
    if (!txLine || txLine.type !== 'tx' || txLine.label !== TX_LABEL) {
      throw new Error(`tx line wrong or missing: ${JSON.stringify(txLine)}`);
    }
    const outLine = byRef.get(OUTPOINT);
    if (!outLine || outLine.type !== 'output' || outLine.label !== OUTPUT_LABEL || outLine.spendable !== 'false') {
      throw new Error(`output line wrong or missing: ${JSON.stringify(outLine)}`);
    }
    steps.push({ name: 'exported JSONL contains addr/tx/output labels (spendable round-trips)', passed: true });

    console.log('\n[bip329-export-browser] all steps passed:');
    for (const s of steps) console.log(`  ✓ ${s.name}`);
  } finally {
    await browser.close().catch(() => {});
    if (startedServer && devProc && devProc.pid) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[bip329-export-browser] FAILED: ${err.stack || err.message}`);
    process.exit(1);
  }
);
