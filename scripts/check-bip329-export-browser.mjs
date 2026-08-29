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
import { unlockIfNeeded } from './browser-check-utils.mjs';

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
const WALLET = 'Bip329CheckWallet';
const OTHER_WALLET = 'Bip329OtherWallet';
const TAG = 'bip329checktag';

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

// Wait until the live match-count line reads "<n> labels will be exported."
async function waitForMatchCount(page, n, timeoutMs = 20_000) {
  const expected = `${n} label${n === 1 ? '' : 's'} will be exported.`;
  await page.waitForFunction(
    ({ testid, text }) => {
      const el = document.querySelector(`[data-testid="${testid}"]`);
      return el && el.textContent && el.textContent.trim() === text;
    },
    { testid: 'text-bip329-match-count', text: expected },
    { timeout: timeoutMs }
  );
}

// Radix Select: open the trigger, pick the option by its visible name.
async function pickSelectOption(page, triggerTestId, optionName) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
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
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'bip329-export-browser' });
    steps.push({ name: 'vault created and app unlocked', passed: true });

    // ── Seed labeled records (address, tx, output) via the app's own CRUD ───
    // The address/output records carry a wallet + tag so the filter controls
    // have something to select; vocabulary rows are created explicitly (and
    // awaited) so the dropdown options exist before the page reload below.
    await page.evaluate(
      async ({ addr, addrLabel, txid, txLabel, outpoint, outputLabel, wallet, otherWallet, tag }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const vocab = await import('/src/lib/data/vocabulary-crud.ts');
        await vocab.createWalletName(wallet);
        await vocab.createWalletName(otherWallet);
        await vocab.createTag(tag);
        await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: addrLabel,
          walletName: wallet,
          tags: [tag],
        });
        await recordCrud.createRecord({
          type: 'transaction',
          inputString: txid,
          label: txLabel,
          walletName: otherWallet,
        });
        await recordCrud.createRecord({
          type: 'transaction',
          inputString: outpoint,
          label: outputLabel,
          notes: 'BIP-329 output at index 1. Spendable: false',
          walletName: wallet,
          tags: [tag],
        });
      },
      { addr: ADDR, addrLabel: ADDR_LABEL, txid: TXID, txLabel: TX_LABEL, outpoint: OUTPOINT, outputLabel: OUTPUT_LABEL, wallet: WALLET, otherWallet: OTHER_WALLET, tag: TAG }
    );
    steps.push({ name: 'seeded labeled address/tx/output records (with wallet/tag vocabulary)', passed: true });

    // Reload once so the page's live queries pick up the dynamically-imported
    // writes (records, tag/wallet vocabulary) before asserting on the UI.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 8_000, label: 'bip329-export-browser' });

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

    // ── Filter controls: live match count tracks every dimension ────────────
    await waitForMatchCount(page, 3);
    steps.push({ name: 'live match count starts at 3 (unfiltered)', passed: true });

    await pickSelectOption(page, 'select-bip329-type', 'Addresses');
    await waitForMatchCount(page, 1);
    if (await page.getByTestId('checkbox-bip329-utxo-only').count() !== 0) {
      throw new Error('UTXO refs only checkbox should be hidden for the address kind');
    }

    await pickSelectOption(page, 'select-bip329-type', 'Transactions');
    await waitForMatchCount(page, 1);
    const utxoOnly = page.getByTestId('checkbox-bip329-utxo-only');
    await utxoOnly.waitFor({ state: 'visible', timeout: 5_000 });
    if (await utxoOnly.isChecked()) {
      throw new Error('UTXO refs only checkbox should start unchecked');
    }

    await utxoOnly.check();
    await waitForMatchCount(page, 1);
    if (!(await utxoOnly.isChecked())) {
      throw new Error('UTXO refs only checkbox did not become checked');
    }

    await utxoOnly.uncheck();
    await waitForMatchCount(page, 1);
    if (await utxoOnly.isChecked()) {
      throw new Error('UTXO refs only checkbox did not become unchecked');
    }

    await pickSelectOption(page, 'select-bip329-type', 'Other');
    await waitForMatchCount(page, 0);
    if (await page.getByTestId('checkbox-bip329-utxo-only').count() !== 0) {
      throw new Error('UTXO refs only checkbox should be hidden for the other kind');
    }

    await pickSelectOption(page, 'select-bip329-type', 'All');
    await waitForMatchCount(page, 3);
    steps.push({ name: 'type filter covers address / transaction / UTXO-only / other / all', passed: true });

    await pickSelectOption(page, 'select-bip329-tag', TAG);
    await waitForMatchCount(page, 2);
    await pickSelectOption(page, 'select-bip329-tag', 'All Tags');
    await waitForMatchCount(page, 3);
    steps.push({ name: 'tag filter narrows the count', passed: true });

    await pickSelectOption(page, 'select-bip329-wallet', WALLET);
    await waitForMatchCount(page, 2);
    await pickSelectOption(page, 'select-bip329-wallet', 'All Wallets');
    await waitForMatchCount(page, 3);
    steps.push({ name: 'wallet filter narrows the count', passed: true });

    await page.getByTestId('input-bip329-search').fill('export check output');
    await waitForMatchCount(page, 1);
    steps.push({ name: 'search filter narrows the count (debounced)', passed: true });

    // ── Filtered export downloads only the matching lines ───────────────────
    const filteredDownloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await exportButton.click();
    const filteredDownload = await filteredDownloadPromise;
    const filteredContent = await readFile(await filteredDownload.path(), 'utf8');
    const filteredLines = filteredContent
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    if (filteredLines.length !== 1 || filteredLines[0].ref !== OUTPOINT || filteredLines[0].label !== OUTPUT_LABEL) {
      throw new Error(`filtered export wrong: ${JSON.stringify(filteredLines)}`);
    }
    steps.push({ name: 'filtered export downloads only the matching label', passed: true });

    // ── Clear filters restores the full set ─────────────────────────────────
    await page.getByTestId('button-bip329-clear-filters').click();
    await waitForMatchCount(page, 3);
    steps.push({ name: 'clear filters restores the unfiltered count', passed: true });

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
