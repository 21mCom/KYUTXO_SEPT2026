#!/usr/bin/env node
// Real-browser regression guard for the UTXO → Coin Passport flow.
//
// The unit tests cover the pure ledger and export builders, but they cannot
// prove that the live UTXO link, Vite's browser bundle, Blob download path,
// and a real jsPDF document all agree. This check creates a fresh vault and
// seeds three current outputs:
//
//   - known: an owned acquisition with deterministic provenance
//   - unknown: an owned output whose incoming prevout is unavailable
//   - mixed: a consolidation of the known lot and an unavailable input
//
// It opens the mixed Passport from the UTXO list, checks its two displayed
// allocations and two-hop timeline, then parses the downloaded CSV and PDF.
// The PDF is read only by pdf.js as a verification oracle; the application
// never reads exported PDFs.
//
// Usage: node scripts/check-coin-passport-export-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and
// `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const UTXOS_URL = `${BASE_URL}utxos`;
const SETUP_PASSWORD = 'coin-passport-export-check-123';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

// Group-row testids embed address.slice(0, 8), so keep these prefixes unique.
const KNOWN_ADDRESS = 'bc1qknwnpassport' + 'a'.repeat(30);
const UNKNOWN_ADDRESS = 'bc1qunknpassport' + 'b'.repeat(24);
const MIXED_ADDRESS = 'bc1qmixdpassport' + 'c'.repeat(26);
const EXTERNAL_ADDRESS = 'bc1qpassportexternal' + 'e'.repeat(24);

const KNOWN_TX = '11111111' + '10'.repeat(28);
const UNKNOWN_TX = '22222222' + '20'.repeat(28);
const MIX_ORIGIN_TX = '33333333' + '30'.repeat(28);
const MIX_TX = '44444444' + '40'.repeat(28);

const MIXED_OUTPOINT = `${MIX_TX}:0`;
const KNOWN_LOT = `lot:${MIX_ORIGIN_TX}:0`;
const MIXED_SATS = 6_800;
const KNOWN_MIXED_SATS = 3_800;
const UNKNOWN_MIXED_SATS = 3_000;

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
    const response = await fetch(url, { method: 'GET' });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function launchBrowser(executablePath) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (error) {
      lastError = error;
      console.log(
        `[coin-passport-export-browser] chromium launch attempt ${attempt} failed: ` +
          `${error?.message?.split('\n')[0] ?? error}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw lastError;
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (inQuotes) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

async function readDownloadBytes(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

async function extractPdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      await page.cleanup();
    }
    return pages.join('\n');
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }
}

async function main() {
  const executablePath = resolveChromium();
  console.log(`[coin-passport-export-browser] chromium: ${executablePath}`);

  let devProcess = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[coin-passport-export-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[coin-passport-export-browser] starting dev server (npm run dev) ...');
    devProcess = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL}.`);
    }
  }

  const browser = await launchBrowser(executablePath);
  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(
      `[coin-passport-export-browser] ${passed ? 'PASS' : 'FAIL'} ${name}` +
        (detail ? ` — ${detail}` : ''),
    );
  };

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.log(`[coin-passport-export-browser][page-console] ${message.text()}`);
      }
    });

    await page.goto(UTXOS_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });

    const seeded = await page.evaluate(
      async ({ knownAddress, unknownAddress, mixedAddress, externalAddress, knownTx, unknownTx, mixOriginTx, mixTx, now, day }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');

        const knownRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: knownAddress,
          label: 'Known acquisition',
          walletName: 'Passport fixtures',
          addressImportance: 'manual',
        });
        const unknownRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: unknownAddress,
          label: 'Unknown acquisition',
          walletName: 'Passport fixtures',
          addressImportance: 'manual',
        });
        const mixedRecordId = await recordCrud.createRecord({
          type: 'address',
          inputString: mixedAddress,
          label: 'Mixed consolidation',
          walletName: 'Passport fixtures',
          addressImportance: 'manual',
        });

        await txCrud.bulkAddTransactions([
          {
            txid: knownTx,
            blockHeight: 800_000,
            blockTime: now - 4 * day,
            fee: 0,
            feeRate: 0,
            syncedAt: Date.now(),
          },
          {
            txid: unknownTx,
            blockHeight: 800_100,
            blockTime: now - 3 * day,
            fee: 100,
            feeRate: 1,
            syncedAt: Date.now(),
          },
          {
            txid: mixOriginTx,
            blockHeight: 800_200,
            blockTime: now - 2 * day,
            fee: 0,
            feeRate: 0,
            syncedAt: Date.now(),
          },
          {
            txid: mixTx,
            blockHeight: 800_300,
            blockTime: now - day,
            fee: 200,
            feeRate: 1,
            syncedAt: Date.now(),
          },
        ]);
        await txCrud.bulkAddParticipants([
          // Known fixture: no inputs means a deterministic acquisition.
          { txid: knownTx, role: 'output', address: knownAddress, amount: 10_000, vout: 0, recordId: knownRecordId },
          // Unknown fixture: the incoming prevout is not present locally.
          { txid: unknownTx, role: 'input', address: externalAddress, amount: 6_000, prevTxid: 'aaaaaaaa' + 'a'.repeat(56), prevVout: 1 },
          { txid: unknownTx, role: 'output', address: unknownAddress, amount: 5_900, vout: 0, recordId: unknownRecordId },
          // Mixed fixture: 4,000 known sats plus 3,000 from an unavailable
          // input, less a 200-sat fee, remains in one current output.
          { txid: mixOriginTx, role: 'output', address: mixedAddress, amount: 4_000, vout: 0, recordId: mixedRecordId },
          { txid: mixTx, role: 'input', address: mixedAddress, amount: 4_000, prevTxid: mixOriginTx, prevVout: 0, recordId: mixedRecordId },
          { txid: mixTx, role: 'input', address: '', amount: 3_000, prevTxid: 'bbbbbbbb' + 'b'.repeat(56), prevVout: 7 },
          { txid: mixTx, role: 'output', address: mixedAddress, amount: 6_800, vout: 0, recordId: mixedRecordId },
        ]);
        return { knownRecordId, unknownRecordId, mixedRecordId };
      },
      {
        knownAddress: KNOWN_ADDRESS,
        unknownAddress: UNKNOWN_ADDRESS,
        mixedAddress: MIXED_ADDRESS,
        externalAddress: EXTERNAL_ADDRESS,
        knownTx: KNOWN_TX,
        unknownTx: UNKNOWN_TX,
        mixOriginTx: MIX_ORIGIN_TX,
        mixTx: MIX_TX,
        now: NOW,
        day: DAY,
      },
    );
    step('seeded known, unknown, and mixed fixtures', Boolean(seeded.knownRecordId && seeded.unknownRecordId && seeded.mixedRecordId));

    const countCard = page.getByTestId('text-utxo-count');
    await countCard.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="text-utxo-count"]')?.textContent?.includes('3 / 3'),
      undefined,
      { timeout: 30_000 },
    );
    step('UTXO list shows all three current fixture outputs', (await countCard.textContent())?.includes('3 / 3'), await countCard.textContent());

    const mixedGroup = page.getByTestId(`row-address-${MIXED_ADDRESS.slice(0, 8)}`);
    await mixedGroup.waitFor({ state: 'visible', timeout: 15_000 });
    await mixedGroup.click();
    const mixedRow = page.getByTestId(`row-utxo-${MIXED_OUTPOINT}`);
    await mixedRow.waitFor({ state: 'visible', timeout: 15_000 });
    const passportLink = page.getByTestId(`button-passport-${MIXED_OUTPOINT}`);
    await passportLink.waitFor({ state: 'visible', timeout: 15_000 });
    await Promise.all([
      page.waitForURL(/\/coin-origins\?outpoint=/, { timeout: 30_000 }),
      passportLink.click(),
    ]);

    await page.getByTestId('coin-origins-page').waitFor({ state: 'visible', timeout: 30_000 });
    const passport = page.getByTestId('coin-passport');
    await passport.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('coin-passport-hop-1').waitFor({ state: 'visible', timeout: 30_000 });

    const displayedAllocationRows = await passport.locator('tr[data-testid^="coin-passport-allocation-"]').evaluateAll(
      (rows) =>
        rows.map((row) => {
          const cells = Array.from(row.querySelectorAll('td'));
          return {
            testId: row.getAttribute('data-testid'),
            text: row.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            sats: cells.at(-1)?.textContent?.replace(/[^\d]/g, '') ?? '',
          };
        }),
    );
    const displayedHops = await passport.locator('[data-testid^="coin-passport-hop-"]').allTextContents();
    const allocationIds = displayedAllocationRows.map((row) => row.testId);
    const displayedSats = displayedAllocationRows.map((row) => row.sats);
    step(
      'Passport shows the mixed boundary and exact displayed allocations',
      (await passport.getByText('Mixed boundary', { exact: true }).first().isVisible()) &&
        (await passport.getByText('6,800 sats', { exact: true }).isVisible()) &&
        allocationIds.includes(`coin-passport-allocation-${KNOWN_LOT}`) &&
        allocationIds.includes('coin-passport-allocation-unknown') &&
        displayedSats.join(',') === `${KNOWN_MIXED_SATS},${UNKNOWN_MIXED_SATS}`,
      `rows=${JSON.stringify(displayedAllocationRows)}`,
    );
    step(
      'Passport hop timeline contains the acquisition and mixed consolidation',
      displayedHops.length === 2 &&
        displayedHops[0].includes(MIX_ORIGIN_TX) &&
        displayedHops[1].includes(MIX_TX) &&
        displayedHops[1].toLowerCase().includes('mixed'),
      `hops=${displayedHops.map((text) => text.replace(/\s+/g, ' ').trim()).join(' | ')}`,
    );

    const [csvDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByTestId('coin-passport-csv').click(),
    ]);
    const parsedCsvRows = parseCsv(
      new TextDecoder().decode(await readDownloadBytes(csvDownload)),
    );
    const expectedCsvRows = [
      ['scope', 'outpoint', 'address', 'boundary', 'lot_id', 'origin_txid', 'origin_vout', 'acquired_at', 'satoshis'],
      [
        MIXED_OUTPOINT,
        MIXED_OUTPOINT,
        MIXED_ADDRESS,
        'mixed',
        KNOWN_LOT,
        MIX_ORIGIN_TX,
        '0',
        new Date((NOW - 2 * DAY) * 1000).toISOString(),
        String(KNOWN_MIXED_SATS),
      ],
      [MIXED_OUTPOINT, MIXED_OUTPOINT, MIXED_ADDRESS, 'mixed', 'unknown', '', '', '', String(UNKNOWN_MIXED_SATS)],
    ];
    // The first CSV column is scopeLabel and is intentionally the selected
    // outpoint, so the expected rows above use the same value in both fields.
    step(
      'CSV download matches the two displayed allocations exactly',
      JSON.stringify(parsedCsvRows) === JSON.stringify(expectedCsvRows),
      `rows=${JSON.stringify(parsedCsvRows)}`,
    );

    const [pdfDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.getByTestId('coin-passport-pdf').click(),
    ]);
    const pdfBytes = await readDownloadBytes(pdfDownload);
    // pdf.js may transfer (and detach) the supplied Uint8Array buffer. Record
    // byte-level assertions first and parse a copy.
    const pdfByteLength = pdfBytes.byteLength;
    const pdfIsValid = pdfByteLength > 1_000 &&
      pdfBytes[0] === 0x25 &&
      pdfBytes[1] === 0x50 &&
      pdfBytes[2] === 0x44 &&
      pdfBytes[3] === 0x46;
    const pdfText = await extractPdfText(pdfBytes.slice());
    const pdfFlat = pdfText.replace(/[\s,]+/g, '');
    step(
      'PDF download contains the same allocations, hops, and reconciliation status',
      pdfIsValid &&
        pdfFlat.includes(MIXED_OUTPOINT) &&
        pdfFlat.includes(KNOWN_LOT) &&
        pdfFlat.includes('unknown') &&
        pdfFlat.includes(String(KNOWN_MIXED_SATS)) &&
        pdfFlat.includes(String(UNKNOWN_MIXED_SATS)) &&
        pdfFlat.includes(MIX_ORIGIN_TX) &&
        pdfFlat.includes(MIX_TX) &&
        pdfFlat.includes('mixed') &&
        pdfFlat.includes('reconciled:yes'),
      `${pdfByteLength} bytes`,
    );

    await context.close();
  } finally {
    await browser.close();
    if (devProcess) {
      try {
        process.kill(-devProcess.pid, 'SIGTERM');
      } catch {
        try {
          devProcess.kill('SIGTERM');
        } catch {
          // The process may already have exited.
        }
      }
    }
  }

  const failed = steps.filter((entry) => !entry.passed);
  console.log(`\n[coin-passport-export-browser] ${steps.length - failed.length}/${steps.length} checks passed`);
  if (failed.length > 0) {
    console.error(`[coin-passport-export-browser] FAILED: ${failed.map((entry) => entry.name).join(', ')}`);
    process.exit(1);
  }
  console.log('[coin-passport-export-browser] OK');
}

main().catch((error) => {
  console.error('[coin-passport-export-browser] fatal:', error);
  process.exit(1);
});