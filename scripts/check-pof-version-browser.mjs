#!/usr/bin/env node
// Real-browser regression guard: the Tool line and canonical payload in the
// generated Proof-of-Funds PDF contain the correct app version string.
//
// KYUTXO_APP_VERSION is derived from package.json at build time; a typo in
// the import path or a Vite bundling quirk could silently produce a blank or
// "undefined" version string. No other check exercises the live Vite-bundled
// PDF path in a real browser.
//
// ── Release pipeline gate ─────────────────────────────────────────────────────
// This check is a REQUIRED step in the version-bump release pipeline.  Run it
// immediately after `node scripts/bump-version.js` (and after
// check-version-literal) to confirm that the new version number is correctly
// embedded in both real and sample Proof-of-Funds PDFs before the release
// commit is merged.  See scripts/bump-version.js for the full release checklist.
//
// Wired as the `pof-version-browser-check` workflow in .replit.
// ─────────────────────────────────────────────────────────────────────────────
//
// What this script does:
//   1. Creates a vault, seeds ONE funded address via the CRUD modules, and
//      runs the OFFLINE balance check.
//   2. Fills the minimum declarant fields needed for the Generate PDF button
//      to become enabled (name, date, purpose).
//   3. Downloads a real PDF and a sample PDF.
//   4. Parses both with pdf.js (legacy build — matches Nix-pinned Chromium
//      v125, which predates Promise.try) and asserts:
//        • Real PDF:    Tool line = "KYUTXO v<version> (Proof of Funds Declaration)"
//        • Real PDF:    canonical payload starts with "KYUTXO-POF-v1" and
//                       carries "TOOL: KYUTXO v<version>"
//        • Sample PDF:  Tool line also carries the same version (sample PDFs
//                       are still stamped with the tool version)
//        • Neither PDF: version string is blank or contains "undefined"
//
// pdf.js is only the verification oracle (KYUTXO never reads PDFs).
//
// Usage: node scripts/check-pof-version-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

// Read the expected version from package.json at script start time so the
// assertion is always in sync with the source of truth.
const __dir = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dir, '..', 'package.json'), 'utf8'));
const EXPECTED_VERSION = PKG.version;

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PROOF_URL = `${BASE_URL}proof-of-funds`;
const SETUP_PASSWORD = 'pof-version-check-456';

const FUNDED_SATS = 300_000;
const FUNDED_TXID =
  'b3c4d5e6f7081929304152637485960718293041526374859607182930b3c4d5';

// Fixed test-only private key → P2PKH address derived at runtime so the
// address is always valid and matches a real address on mainnet.
const PRIV_KEY = Uint8Array.from(
  Buffer.from(
    '3333333333333333333333333333333333333333333333333333333333333333',
    'hex',
  ),
);
const FUNDED_ADDRESS = bitcoin.payments.p2pkh({
  pubkey: secp256k1.getPublicKey(PRIV_KEY, true),
  network: bitcoin.networks.bitcoin,
}).address;

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

/** Read a Playwright download into a Uint8Array of its bytes. */
async function readDownloadBytes(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

/** Parse PDF bytes with the legacy pdf.js build and return the full text. */
async function extractFullText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
      );
      await page.cleanup();
    }
    return pages.join('\n');
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }
}

/** Whitespace-insensitive normalization: pdf.js splits columns arbitrarily. */
const norm = (s) => s.replace(/\s+/g, '');

async function main() {
  const exe = resolveChromium();
  console.log(`[pof-version] chromium: ${exe}`);
  console.log(`[pof-version] expected version: ${EXPECTED_VERSION}`);
  console.log(`[pof-version] funded address: ${FUNDED_ADDRESS}`);

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[pof-version] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[pof-version] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[pof-version] dev server ready at ${BASE_URL}`);
  }

  let realPdfBytes = null;
  let samplePdfBytes = null;

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    // Fully offline: only the dev server is reachable.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE_URL) || url.startsWith('data:')) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[pof-version][page-console] ${t}`);
      }
    });

    await page.goto(PROOF_URL, { waitUntil: 'load', timeout: 90_000 });

    // ── Create the vault ─────────────────────────────────────────────────
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 60_000 });

    // ── Seed the funded address (offline balance source reads these rows) ─
    await page
      .getByTestId('textarea-address-input')
      .waitFor({ state: 'visible', timeout: 60_000 });
    await page.evaluate(
      async ({ addr, sats, txid }) => {
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({
          txid,
          blockHeight: 800_100,
          blockTime: now - 3600,
          fee: 1000,
          feeRate: 5,
          syncedAt: Date.now(),
        });
        await txCrud.addParticipant({
          txid,
          role: 'output',
          address: addr,
          amount: sats,
          vout: 0,
        });
        return true;
      },
      { addr: FUNDED_ADDRESS, sats: FUNDED_SATS, txid: FUNDED_TXID },
    );

    // ── Offline balance check ──────────────────────────────────────────────
    await page.getByTestId('button-source-offline').click();
    await page.getByTestId('textarea-address-input').fill(FUNDED_ADDRESS);
    await page.getByTestId('button-check-balances').click();
    await page
      .locator('[data-testid="row-address-0"]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    console.log('[pof-version] offline balance check complete');

    // ── Fill minimum declarant fields ────────────────────────────────────
    await page.getByTestId('input-declarant-name').fill('Version Test User');
    await page.getByTestId('input-declaration-date').fill('2026-08-17');
    await page.getByTestId('input-purpose').fill('Version string regression check');

    // ── Wait for the Generate PDF button to become enabled ───────────────
    await page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="button-generate-pdf"]');
        return b && !b.hasAttribute('disabled');
      },
      undefined,
      { timeout: 20_000 },
    );

    // ── Download real PDF ─────────────────────────────────────────────────
    const pdfBtn = page.getByTestId('button-generate-pdf');
    await pdfBtn.scrollIntoViewIfNeeded({ timeout: 10_000 });
    const [realDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      pdfBtn.click(),
    ]);
    realPdfBytes = await readDownloadBytes(realDownload);
    console.log(`[pof-version] captured real PDF (${realPdfBytes.byteLength} bytes)`);

    // ── Download sample PDF ───────────────────────────────────────────────
    const sampleBtn = page.getByTestId('button-generate-sample-pdf');
    await sampleBtn.scrollIntoViewIfNeeded({ timeout: 10_000 });
    const [sampleDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      sampleBtn.click(),
    ]);
    samplePdfBytes = await readDownloadBytes(sampleDownload);
    console.log(`[pof-version] captured sample PDF (${samplePdfBytes.byteLength} bytes)`);
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

  // ── Parse + assert (Node side; pdf.js is only the oracle) ────────────────
  console.log('[pof-version] parsing PDFs with pdf.js ...');
  const realText = await extractFullText(realPdfBytes);
  const sampleText = await extractFullText(samplePdfBytes);
  const nReal = norm(realText);
  const nSample = norm(sampleText);

  const EXPECTED_TOOL_LINE = `KYUTXO v${EXPECTED_VERSION} (Proof of Funds Declaration)`;
  const EXPECTED_PAYLOAD_TOOL = `TOOL: KYUTXO v${EXPECTED_VERSION}`;

  const steps = [];

  // 1) Real PDF Tool line in Document Integrity section.
  {
    const passed = nReal.includes(norm(EXPECTED_TOOL_LINE));
    steps.push({
      name: 'real PDF: Tool line contains correct version',
      passed,
      detail: passed
        ? `found: ${JSON.stringify(EXPECTED_TOOL_LINE)}`
        : `NOT found: ${JSON.stringify(EXPECTED_TOOL_LINE)} in text snippet: ${realText.substring(0, 500)}`,
    });
  }

  // 2) Real PDF version string is not blank or "undefined".
  {
    const hasUndefined = nReal.includes(norm('KYUTXOvundefined'));
    const hasBlankTool = nReal.includes(norm('KYUTXO v (Proof'));
    const passed = !hasUndefined && !hasBlankTool;
    steps.push({
      name: 'real PDF: version string is not blank or "undefined"',
      passed,
      detail: passed
        ? 'no blank/undefined version found'
        : `hasUndefined=${hasUndefined} hasBlankTool=${hasBlankTool}`,
    });
  }

  // 3) Real PDF canonical payload carries the TOOL line.
  {
    const passed =
      nReal.includes(norm('KYUTXO-POF-v1')) &&
      nReal.includes(norm(EXPECTED_PAYLOAD_TOOL));
    steps.push({
      name: 'real PDF: canonical payload carries correct TOOL line',
      passed,
      detail: passed
        ? `found: ${JSON.stringify(EXPECTED_PAYLOAD_TOOL)}`
        : `NOT found: ${JSON.stringify(EXPECTED_PAYLOAD_TOOL)}`,
    });
  }

  // 4) Sample PDF Tool line also carries the correct version.
  {
    const passed = nSample.includes(norm(EXPECTED_TOOL_LINE));
    steps.push({
      name: 'sample PDF: Tool line contains correct version',
      passed,
      detail: passed
        ? `found: ${JSON.stringify(EXPECTED_TOOL_LINE)}`
        : `NOT found: ${JSON.stringify(EXPECTED_TOOL_LINE)}`,
    });
  }

  // 5) Sample PDF version string is not blank or "undefined".
  {
    const hasUndefined = nSample.includes(norm('KYUTXOvundefined'));
    const hasBlankTool = nSample.includes(norm('KYUTXO v (Proof'));
    const passed = !hasUndefined && !hasBlankTool;
    steps.push({
      name: 'sample PDF: version string is not blank or "undefined"',
      passed,
      detail: passed
        ? 'no blank/undefined version found'
        : `hasUndefined=${hasUndefined} hasBlankTool=${hasBlankTool}`,
    });
  }

  // 6) Sanity: the sample PDF is the specimen variant (proves we parsed the right file).
  {
    const passed = nSample.includes(norm('SPECIMEN'));
    steps.push({
      name: 'sample PDF: carries the SPECIMEN stamp',
      passed,
      detail: passed ? 'SPECIMEN stamp present' : 'SPECIMEN stamp missing — wrong PDF?',
    });
  }

  const ok = steps.every((s) => s.passed);
  console.log(`\n[pof-version] ok=${ok}`);
  for (const s of steps) {
    console.log(`  [${s.passed ? 'PASS' : 'FAIL'}] ${s.name} :: ${s.detail}`);
  }

  if (!ok) {
    console.error('\n[pof-version] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    `\n[pof-version] PASSED: PDF Tool line correctly shows "KYUTXO v${EXPECTED_VERSION}" in both real and sample PDFs.`,
  );
}

main().catch((err) => {
  console.error('[pof-version] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
