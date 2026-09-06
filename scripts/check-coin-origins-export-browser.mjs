#!/usr/bin/env node
// Real-browser regression guard for whole-vault Coin Origins exports.
//
// The Coin Passport check exercises one selected outpoint. This check keeps
// that coverage separate and validates the page-level Holdings by Origin
// aggregation across the entire vault and two wallet scopes.
//
// It seeds deterministic, unknown, and mixed current outputs in two wallets,
// compares the rendered holdings and summary cards with downloaded CSV rows,
// and parses each downloaded PDF with pdf.js to verify its totals.
//
// Usage: node scripts/check-coin-origins-export-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and
// `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const COIN_ORIGINS_URL = `${BASE_URL}coin-origins`;
const SETUP_PASSWORD = 'coin-origins-export-check-123';

const WALLET_A = 'Origins Alpha';
const WALLET_B = 'Origins Beta';

const ALPHA_KNOWN_ADDRESS = 'bc1qoriginexportalphaknown' + 'a'.repeat(24);
const ALPHA_UNKNOWN_ADDRESS = 'bc1qoriginexportalphaunknown' + 'b'.repeat(20);
const ALPHA_MIXED_ADDRESS = 'bc1qoriginexportalphamixed' + 'c'.repeat(24);
const BETA_KNOWN_ADDRESS = 'bc1qoriginexportbetaknown' + 'd'.repeat(24);
const BETA_UNKNOWN_ADDRESS = 'bc1qoriginexportbetaunknown' + 'e'.repeat(20);
const BETA_MIXED_ADDRESS = 'bc1qoriginexportbetamixed' + 'f'.repeat(24);

const ALPHA_KNOWN_TX = '51111111' + '11'.repeat(28);
const ALPHA_UNKNOWN_TX = '52222222' + '22'.repeat(28);
const ALPHA_MIX_ORIGIN_TX = '53333333' + '33'.repeat(28);
const ALPHA_MIX_TX = '54444444' + '44'.repeat(28);
const BETA_KNOWN_TX = '61111111' + '11'.repeat(28);
const BETA_UNKNOWN_TX = '62222222' + '22'.repeat(28);
const BETA_MIX_ORIGIN_TX = '63333333' + '33'.repeat(28);
const BETA_MIX_TX = '64444444' + '44'.repeat(28);

const ALPHA_KNOWN_LOT = `lot:${ALPHA_KNOWN_TX}:0`;
const ALPHA_UNKNOWN_LOT = `lot:${ALPHA_UNKNOWN_TX}:0`;
const ALPHA_MIX_LOT = `lot:${ALPHA_MIX_ORIGIN_TX}:0`;
const BETA_KNOWN_LOT = `lot:${BETA_KNOWN_TX}:0`;
const BETA_UNKNOWN_LOT = `lot:${BETA_UNKNOWN_TX}:0`;
const BETA_MIX_LOT = `lot:${BETA_MIX_ORIGIN_TX}:0`;

const EXPECTED = {
  entire: { total: 37_500, unknown: 14_000, acquisitionLots: 6, holdings: 7, outpoints: 6, rows: 8 },
  alpha: { total: 22_700, unknown: 8_900, acquisitionLots: 3, holdings: 4, outpoints: 3, rows: 4 },
  beta: { total: 14_800, unknown: 5_100, acquisitionLots: 3, holdings: 4, outpoints: 3, rows: 4 },
};

const EXPECTED_LOTS = new Set([
  ALPHA_KNOWN_LOT,
  ALPHA_UNKNOWN_LOT,
  ALPHA_MIX_LOT,
  BETA_KNOWN_LOT,
  BETA_UNKNOWN_LOT,
  BETA_MIX_LOT,
  'unknown',
]);

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
        `[coin-origins-export-browser] chromium launch attempt ${attempt} failed: ` +
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

function numberFromText(text) {
  const value = Number(text.replace(/[^\d]/g, ''));
  if (!Number.isSafeInteger(value)) throw new Error(`Could not parse integer from "${text}"`);
  return value;
}

async function captureVisibleLedger(page, expected) {
  try {
    await page.waitForFunction(
      ({ total, unknown, acquisitionLots, holdings, outpoints }) => {
        const read = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
        const rows = document.querySelectorAll('tr[data-testid^="origin-holding-"]');
        const outputRows = document.querySelectorAll('tr[data-testid^="origin-outpoint-"]');
        return read('origin-total').replace(/[^\d]/g, '') === String(total) &&
          read('origin-unknown').replace(/[^\d]/g, '') === String(unknown) &&
          read('origin-lots').replace(/[^\d]/g, '') === String(acquisitionLots) &&
          rows.length === holdings &&
          outputRows.length === outpoints;
      },
      {
        total: expected.total,
        unknown: expected.unknown,
        acquisitionLots: expected.acquisitionLots,
        holdings: expected.holdings,
        outpoints: expected.outpoints,
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    const actual = await page.evaluate(() => {
      const read = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '';
      return {
        total: read('origin-total'),
        unknown: read('origin-unknown'),
        acquisitionLots: read('origin-lots'),
        reconciled: read('origin-reconciled'),
        holdings: document.querySelectorAll('tr[data-testid^="origin-holding-"]').length,
        outpoints: document.querySelectorAll('tr[data-testid^="origin-outpoint-"]').length,
      };
    });
    throw new Error(`Visible ledger did not reach ${JSON.stringify(expected)}; actual=${JSON.stringify(actual)}`, { cause: error });
  }

  return page.evaluate(() => {
    const read = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '';
    const parseInteger = (text) => {
      const value = Number(text.replace(/[^\d]/g, ''));
      if (!Number.isSafeInteger(value)) throw new Error(`Could not parse integer from "${text}"`);
      return value;
    };
    const holdings = Array.from(document.querySelectorAll('tr[data-testid^="origin-holding-"]')).map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      return {
        lotId: row.getAttribute('data-testid')?.slice('origin-holding-'.length) ?? '',
        outpointCount: parseInteger(cells[4]?.textContent ?? ''),
        sats: parseInteger(cells[5]?.textContent ?? ''),
      };
    });
    const outpoints = Array.from(document.querySelectorAll('tr[data-testid^="origin-outpoint-"]')).map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      return {
        outpoint: row.getAttribute('data-testid')?.slice('origin-outpoint-'.length) ?? '',
        boundary: cells[2]?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        sats: parseInteger(cells[3]?.textContent ?? ''),
      };
    });
    return {
      total: parseInteger(read('origin-total')),
      unknown: parseInteger(read('origin-unknown')),
      acquisitionLots: parseInteger(read('origin-lots')),
      reconciled: read('origin-reconciled'),
      holdings,
      outpoints,
    };
  });
}

function compareCsvToVisible(parsedRows, visible, scopeLabel, expected) {
  const header = ['scope', 'outpoint', 'address', 'boundary', 'lot_id', 'origin_txid', 'origin_vout', 'acquired_at', 'satoshis'];
  if (JSON.stringify(parsedRows[0]) !== JSON.stringify(header)) return 'CSV header mismatch';
  const rows = parsedRows.slice(1);
  if (rows.length !== expected.rows) return `CSV row count ${rows.length}, expected ${expected.rows}`;
  if (rows.some((row) => row[0] !== scopeLabel)) return 'CSV scope column drifted';

  const total = rows.reduce((sum, row) => sum + Number(row[8]), 0);
  if (total !== visible.total) return `CSV total ${total}, visible total ${visible.total}`;
  const csvByLot = new Map();
  for (const row of rows) {
    const [scope, outpoint, address, boundary, lotId, originTxid, originVout, acquiredAt, satsText] = row;
    if (!EXPECTED_LOTS.has(lotId)) return `unexpected lot ${lotId}`;
    if (!outpoint || !address || !['deterministic', 'unknown', 'mixed'].includes(boundary)) return 'CSV allocation fields incomplete';
    if (Number(satsText) <= 0) return 'CSV allocation satoshis invalid';
    if (lotId !== 'unknown' && (!originTxid || originVout === '' || acquiredAt === '')) {
      return 'CSV provenance fields incomplete';
    }
    const prior = csvByLot.get(lotId) ?? { sats: 0, outpoints: new Set(), scope };
    prior.sats += Number(satsText);
    prior.outpoints.add(outpoint);
    csvByLot.set(lotId, prior);
  }
  const acquisitionLotIds = new Set(rows.map((row) => row[4]).filter((lotId) => lotId !== 'unknown'));
  if (acquisitionLotIds.size !== expected.acquisitionLots) {
    return `CSV acquisition-lot count ${acquisitionLotIds.size}, expected ${expected.acquisitionLots}`;
  }
  if (visible.acquisitionLots !== expected.acquisitionLots) {
    return `visible acquisition-lot count ${visible.acquisitionLots}, expected ${expected.acquisitionLots}`;
  }
  if (!visible.holdings.some((holding) => holding.lotId === 'unknown')) {
    return 'visible holdings missing synthetic unknown row';
  }
  for (const holding of visible.holdings) {
    const csvHolding = csvByLot.get(holding.lotId);
    if (!csvHolding || csvHolding.sats !== holding.sats || csvHolding.outpoints.size !== holding.outpointCount) {
      return `CSV holding mismatch for ${holding.lotId}`;
    }
  }
  const outpointTotal = visible.outpoints.reduce((sum, row) => sum + row.sats, 0);
  if (outpointTotal !== visible.total) return `visible outpoint total ${outpointTotal}, summary ${visible.total}`;
  const csvUnknown = rows
    .filter((row) => row[4] === ALPHA_UNKNOWN_LOT || row[4] === BETA_UNKNOWN_LOT || row[4] === 'unknown')
    .reduce((sum, row) => sum + Number(row[8]), 0);
  if (csvUnknown !== visible.unknown) return `CSV unknown total ${csvUnknown}, visible unknown ${visible.unknown}`;
  return null;
}

async function selectWallet(page, walletName) {
  await page.getByTestId('coin-origin-wallet').click();
  await page.getByRole('option', { name: walletName, exact: true }).click();
}

async function main() {
  const executablePath = resolveChromium();
  console.log(`[coin-origins-export-browser] chromium: ${executablePath}`);

  let devProcess = null;
  if (await isServerUp(BASE_URL)) {
    console.log(`[coin-origins-export-browser] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[coin-origins-export-browser] starting dev server (npm run dev) ...');
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
      `[coin-origins-export-browser] ${passed ? 'PASS' : 'FAIL'} ${name}` +
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
        console.log(`[coin-origins-export-browser][page-console] ${message.text()}`);
      }
    });

    await page.goto(COIN_ORIGINS_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    await completeFreshVaultOnboardingIfPresent(page, {
      label: 'coin-origins-export-browser',
    });

    const seeded = await page.evaluate(
      async ({
        walletA,
        walletB,
        addresses,
        txids,
      }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const records = {};
        for (const [key, address] of Object.entries(addresses)) {
          if (key === 'external') continue;
          records[key] = await recordCrud.createRecord({
            type: 'address',
            inputString: address,
            label: `${key} current output`,
            walletName: key.startsWith('alpha') ? walletA : walletB,
            addressImportance: 'manual',
          });
        }

        const now = Math.floor(Date.now() / 1000);
        const day = 24 * 60 * 60;
        await txCrud.bulkAddTransactions([
          { txid: txids.alphaKnown, blockHeight: 801000, blockTime: now - 8 * day, fee: 0, feeRate: 0, syncedAt: Date.now() },
          { txid: txids.alphaUnknown, blockHeight: 801010, blockTime: now - 7 * day, fee: 100, feeRate: 1, syncedAt: Date.now() },
          { txid: txids.alphaMixOrigin, blockHeight: 801020, blockTime: now - 6 * day, fee: 0, feeRate: 0, syncedAt: Date.now() },
          { txid: txids.alphaMix, blockHeight: 801030, blockTime: now - 5 * day, fee: 200, feeRate: 1, syncedAt: Date.now() },
          { txid: txids.betaKnown, blockHeight: 801040, blockTime: now - 4 * day, fee: 0, feeRate: 0, syncedAt: Date.now() },
          { txid: txids.betaUnknown, blockHeight: 801050, blockTime: now - 3 * day, fee: 100, feeRate: 1, syncedAt: Date.now() },
          { txid: txids.betaMixOrigin, blockHeight: 801060, blockTime: now - 2 * day, fee: 0, feeRate: 0, syncedAt: Date.now() },
          { txid: txids.betaMix, blockHeight: 801070, blockTime: now - day, fee: 0, feeRate: 0, syncedAt: Date.now() },
        ]);
        await txCrud.bulkAddParticipants([
          { txid: txids.alphaKnown, role: 'output', address: addresses.alphaKnown, amount: 10_000, vout: 0, recordId: records.alphaKnown },
          { txid: txids.alphaUnknown, role: 'input', address: addresses.external, amount: 6_000, prevTxid: 'a'.repeat(64), prevVout: 1 },
          { txid: txids.alphaUnknown, role: 'output', address: addresses.alphaUnknown, amount: 5_900, vout: 0, recordId: records.alphaUnknown },
          { txid: txids.alphaMixOrigin, role: 'output', address: addresses.alphaMixed, amount: 4_000, vout: 0, recordId: records.alphaMixed },
          { txid: txids.alphaMix, role: 'input', address: addresses.alphaMixed, amount: 4_000, prevTxid: txids.alphaMixOrigin, prevVout: 0, recordId: records.alphaMixed },
          { txid: txids.alphaMix, role: 'input', address: '', amount: 3_000, prevTxid: 'b'.repeat(64), prevVout: 7 },
          { txid: txids.alphaMix, role: 'output', address: addresses.alphaMixed, amount: 6_800, vout: 0, recordId: records.alphaMixed },
          { txid: txids.betaKnown, role: 'output', address: addresses.betaKnown, amount: 7_200, vout: 0, recordId: records.betaKnown },
          { txid: txids.betaUnknown, role: 'input', address: addresses.external, amount: 4_000, prevTxid: 'c'.repeat(64), prevVout: 2 },
          { txid: txids.betaUnknown, role: 'output', address: addresses.betaUnknown, amount: 3_900, vout: 0, recordId: records.betaUnknown },
          { txid: txids.betaMixOrigin, role: 'output', address: addresses.betaMixed, amount: 2_500, vout: 0, recordId: records.betaMixed },
          { txid: txids.betaMix, role: 'input', address: addresses.betaMixed, amount: 2_500, prevTxid: txids.betaMixOrigin, prevVout: 0, recordId: records.betaMixed },
          { txid: txids.betaMix, role: 'input', address: '', amount: 1_200, prevTxid: 'd'.repeat(64), prevVout: 4 },
          { txid: txids.betaMix, role: 'output', address: addresses.betaMixed, amount: 3_700, vout: 0, recordId: records.betaMixed },
        ]);
        return records;
      },
      {
        walletA: WALLET_A,
        walletB: WALLET_B,
        addresses: {
          alphaKnown: ALPHA_KNOWN_ADDRESS,
          alphaUnknown: ALPHA_UNKNOWN_ADDRESS,
          alphaMixed: ALPHA_MIXED_ADDRESS,
          betaKnown: BETA_KNOWN_ADDRESS,
          betaUnknown: BETA_UNKNOWN_ADDRESS,
          betaMixed: BETA_MIXED_ADDRESS,
          external: 'bc1qoriginexportexternal' + '9'.repeat(30),
        },
        txids: {
          alphaKnown: ALPHA_KNOWN_TX,
          alphaUnknown: ALPHA_UNKNOWN_TX,
          alphaMixOrigin: ALPHA_MIX_ORIGIN_TX,
          alphaMix: ALPHA_MIX_TX,
          betaKnown: BETA_KNOWN_TX,
          betaUnknown: BETA_UNKNOWN_TX,
          betaMixOrigin: BETA_MIX_ORIGIN_TX,
          betaMix: BETA_MIX_TX,
        },
      },
    );
    step('seeded two wallets with deterministic, unknown, and mixed outputs', Object.keys(seeded).length === 6);

    // Remount after seeding so Coin Origins reads one fresh, stable DB snapshot.
    await page.goto(COIN_ORIGINS_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    try {
      await page.getByTestId('coin-origins-page').waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`Coin Origins did not remount at ${page.url()}; body="${body}"`, { cause: error });
    }

    for (const [scope, walletName, expected] of [
      ['entire vault', undefined, EXPECTED.entire],
      ['wallet A', WALLET_A, EXPECTED.alpha],
      ['wallet B', WALLET_B, EXPECTED.beta],
    ]) {
      if (walletName) await selectWallet(page, walletName);
      const visible = await captureVisibleLedger(page, expected);
      const label = walletName ?? 'Entire vault';
      step(
        `${scope} visible holdings and summary match seeded totals`,
        visible.total === expected.total &&
          visible.unknown === expected.unknown &&
          visible.acquisitionLots === expected.acquisitionLots &&
          visible.reconciled === 'Yes' &&
          visible.holdings.reduce((sum, row) => sum + row.sats, 0) === expected.total &&
          visible.holdings.length === expected.holdings &&
          visible.holdings.some((row) => row.lotId === 'unknown') &&
          visible.outpoints.length === expected.outpoints,
        `total=${visible.total}, unknown=${visible.unknown}, acquisitionLots=${visible.acquisitionLots}, holdings=${visible.holdings.length}`,
      );

      const [csvDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.getByTestId('coin-origins-csv').click(),
      ]);
      const parsedCsvRows = parseCsv(new TextDecoder().decode(await readDownloadBytes(csvDownload)));
      const csvError = compareCsvToVisible(parsedCsvRows, visible, label, expected);
      step(
        `${scope} CSV matches visible holdings and summary cards`,
        !csvError,
        csvError ?? `rows=${parsedCsvRows.length - 1}, total=${visible.total}`,
      );

      const [pdfDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        page.getByTestId('coin-origins-pdf').click(),
      ]);
      const pdfBytes = await readDownloadBytes(pdfDownload);
      const pdfByteLength = pdfBytes.byteLength;
      const pdfIsValid = pdfByteLength > 1_000 &&
        pdfBytes[0] === 0x25 &&
        pdfBytes[1] === 0x50 &&
        pdfBytes[2] === 0x44 &&
        pdfBytes[3] === 0x46;
      const pdfText = await extractPdfText(pdfBytes.slice());
      const pdfFlat = pdfText.replace(/[\s,]+/g, '');
      const pdfMatchesVisible =
        pdfFlat.includes(`Scope:${label.replace(/\s+/g, '')}`) &&
        pdfFlat.includes(`${visible.total}satsheld`) &&
        pdfFlat.includes(`${visible.unknown}satsunknown`) &&
        pdfFlat.includes('reconciled:yes') &&
        visible.holdings.every((holding) => pdfFlat.includes(String(holding.sats)));
      step(
        `${scope} PDF contains visible totals and every origin holding`,
        pdfIsValid && pdfMatchesVisible,
        `${pdfByteLength} bytes, total=${visible.total}, unknown=${visible.unknown}`,
      );
    }

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
  console.log(`\n[coin-origins-export-browser] ${steps.length - failed.length}/${steps.length} checks passed`);
  if (failed.length > 0) {
    console.error(`[coin-origins-export-browser] FAILED: ${failed.map((entry) => entry.name).join(', ')}`);
    process.exit(1);
  }
  console.log('[coin-origins-export-browser] OK');
}

main().catch((error) => {
  console.error('[coin-origins-export-browser] fatal:', error);
  process.exit(1);
});