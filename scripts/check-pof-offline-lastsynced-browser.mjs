#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds OFFLINE balance check's
// "last synced" timestamp — end to end, from a seeded address record's
// statsComputedAt (stored in MILLISECONDS) through the on-page summary label
// to the "On-chain data as of" line in the actually-generated PDF.
//
// Bug history: the offline path fed the raw millisecond statsComputedAt into
// formatUnix (a SECONDS-based formatter that multiplies by 1000), rendering a
// far-future (~year 57,000) "last synced" date on the page and in the PDF.
// A jsdom hook test (use-balance-check.offlineLastSynced.test.tsx) locks the
// ms→seconds conversion at unit level; this script proves the full surface in
// headless Chromium:
//
//   1. creates a vault, seeds a funded address record via the CRUD modules
//      (createRecord + bulkUpdateAddressStats with a KNOWN 2025-era
//      statsComputedAt, plus a transaction/participant so the offline
//      balance resolves > 0)
//   2. runs the OFFLINE balance check and asserts the visible summary label
//      ("Offline vault data — last synced …") shows exactly
//      formatUnix(seededMs / 1000) — the real 2025 date, not 1970 and not a
//      far-future year
//   3. fills the declarant fields, downloads the generated PDF, re-parses it
//      with pdf.js (legacy build — same oracle as the other PDF checks) and
//      asserts the "On-chain data as of:" metadata line and the
//      "SOURCE: Offline vault data — last synced …" label carry that same
//      2025 date
//
// NOTE for reviewers: the page under test is client/src/pages/
// ProofOfFundsDeclaration.tsx (route /proof-of-funds); the label comes from
// client/src/pages/proof-of-funds/use-balance-check.ts and the PDF line from
// client/src/pages/proof-of-funds/pof-pdf-section-signature.ts
// (renderDocumentIntegrity). pdf.js is only the verification oracle.
//
// Usage: node scripts/check-pof-offline-lastsynced-browser.mjs
// Requires: a `chromium` binary on PATH (installed via Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM and
// crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PROOF_URL = `${BASE_URL}proof-of-funds`;
const SETUP_PASSWORD = 'pof-lastsynced-check-123';

// BIP-173 test vector address (valid P2WPKH); bech32 is stored lowercase so
// the pasted text matches the seeded record's canonical inputString.
const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

// 2025-01-25T14:30:00Z — statsComputedAt is stored in MILLISECONDS.
const SYNCED_UNIX_SECONDS = 1_737_815_400;
const SYNCED_MS = SYNCED_UNIX_SECONDS * 1000;

const FUNDED_SATS = 750_000;
const FUNDED_TXID =
  'a1b2c3d4e5f6071829304152637485960718293041526374859607182930aabb';

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
      console.log(`[pof-lastsynced] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

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

/** Whitespace-insensitive comparison (pdf.js spacing is arbitrary). */
const norm = (s) => s.replace(/\s+/g, '');

async function main() {
  const exe = resolveChromium();
  console.log(`[pof-lastsynced] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[pof-lastsynced] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[pof-lastsynced] starting dev server (npm run dev) ...`);
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
    console.log(`[pof-lastsynced] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);

  let pdfBytes = null;
  let uiLabel = null;
  let expectedLabel = null;
  let expectedDate = null;

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    // Block all non-local network access: the offline path must never need it.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE_URL) || url.startsWith('data:')) {
        return route.continue();
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[pof-lastsynced][page-console] ${t}`);
      }
    });

    // Retry the initial navigation: under parallel validation the first goto
    // can time out while the dev server warms up.
    let navigated = false;
    for (let i = 0; i < 3 && !navigated; i++) {
      try {
        await page.goto(PROOF_URL, { waitUntil: 'load', timeout: 60_000 });
        navigated = true;
      } catch (err) {
        console.log(`[pof-lastsynced] goto attempt ${i + 1} failed: ${err.message}`);
        if (i === 2) throw err;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // ── Create the vault ───────────────────────────────────────────────────
    const pwInput = page.getByTestId('input-password');
    await pwInput.waitFor({ state: 'visible', timeout: 60_000 });
    await pwInput.fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });

    // ── Seed: address record with a KNOWN statsComputedAt (ms) + funding ──
    // createRecord + bulkUpdateAddressStats are the sanctioned CRUD paths;
    // the offline check reads statsComputedAt straight off the record, while
    // the balance itself is recomputed from the transaction tables.
    const seeded = await page.evaluate(
      async ({ addr, sats, txid, syncedMs }) => {
        const recordCrud = await import('/src/lib/data/record-crud.ts');
        const txCrud = await import('/src/lib/data/transaction-crud.ts');
        const id = await recordCrud.createRecord({
          type: 'address',
          inputString: addr,
          label: 'PoF last-synced check',
        });
        await recordCrud.bulkUpdateAddressStats([
          {
            id,
            stats: {
              cachedBalanceSats: sats,
              cachedTxCount: 1,
              cachedLastActivityTime: Math.floor(syncedMs / 1000) - 3600,
              cachedUtxoCount: 1,
              statsComputedAt: syncedMs,
            },
          },
        ]);
        const now = Math.floor(Date.now() / 1000);
        await txCrud.addTransaction({
          txid,
          blockHeight: 800_000,
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
        // Compute the label the app SHOULD display, via the same formatUnix
        // the page uses (locale/timezone-safe oracle for the assertions).
        const helpers = await import('/src/pages/proof-of-funds/address-helpers.ts');
        return {
          id,
          expectedDate: helpers.formatUnix(Math.floor(syncedMs / 1000)),
        };
      },
      { addr: ADDRESS, sats: FUNDED_SATS, txid: FUNDED_TXID, syncedMs: SYNCED_MS },
    );
    expectedDate = seeded.expectedDate;
    expectedLabel = `Offline vault data — last synced ${expectedDate}`;
    console.log(`[pof-lastsynced] seeded record id=${seeded.id}; expected label: ${expectedLabel}`);

    // ── Offline balance check ──────────────────────────────────────────────
    await page.getByTestId('button-source-offline').click();
    await textarea.fill(ADDRESS);
    await page.getByTestId('button-check-balances').click();
    const labelEl = page.getByTestId('text-data-source-note');
    await labelEl.waitFor({ state: 'visible', timeout: 30_000 });
    uiLabel = (await labelEl.evaluate((el) => el.textContent)) ?? '';
    console.log(`[pof-lastsynced] on-page label: ${uiLabel}`);

    // ── Declarant fields + generate PDF ────────────────────────────────────
    await page.getByTestId('input-declarant-name').fill('Alice Example');
    await page.getByTestId('input-declaration-date').fill('2026-06-30');
    await page.getByTestId('input-purpose').fill('Bank account opening');

    const pdfBtn = page.getByTestId('button-generate-pdf');
    await page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="button-generate-pdf"]');
        return b && !b.hasAttribute('disabled');
      }, undefined,
      { timeout: 30_000 },
    );
    await pdfBtn.scrollIntoViewIfNeeded({ timeout: 10_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 90_000 }),
      pdfBtn.click(),
    ]);
    pdfBytes = await readDownloadBytes(download);
    console.log(`[pof-lastsynced] captured PDF (${pdfBytes.byteLength} bytes)`);
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

  // ── Parse + assert ─────────────────────────────────────────────────────
  const pdfText = await extractFullText(pdfBytes);
  const nPdf = norm(pdfText);

  const steps = [];

  // Sanity: the expected date really is a 2025-era date (guards the fixture).
  steps.push({
    name: 'sanity: expected formatUnix date is a 2025 date',
    passed: /2025/.test(expectedDate),
    detail: expectedDate,
  });

  // 1) On-page summary label matches formatUnix(seconds) EXACTLY.
  steps.push({
    name: 'page: summary label shows the real last-synced date',
    passed: uiLabel.trim() === expectedLabel,
    detail: `ui="${uiLabel.trim()}" expected="${expectedLabel}"`,
  });

  // 2) Label carries no 1970 date and no far-future year (raw-ms symptom is a
  //    5+ digit year; "sync time unavailable" would mean statsComputedAt was
  //    never read).
  steps.push({
    name: 'page: label is not 1970 / far-future / unavailable',
    passed:
      !uiLabel.includes('1970') &&
      !/\d{5,}/.test(uiLabel) &&
      !uiLabel.includes('sync time unavailable'),
    detail: uiLabel.trim(),
  });

  // 3) PDF Document Integrity: "On-chain data as of: <expected date>".
  steps.push({
    name: 'PDF: "On-chain data as of:" line shows the real last-synced date',
    passed: nPdf.includes(norm(`On-chain data as of: ${expectedDate}`)),
    detail: `looked for "On-chain data as of: ${expectedDate}"`,
  });

  // 4) PDF data-source label (declaration section + canonical payload SOURCE
  //    line) carries the same full label.
  steps.push({
    name: 'PDF: offline data-source label with the real date is present',
    passed: nPdf.includes(norm(expectedLabel)),
    detail: `looked for "${expectedLabel}"`,
  });

  // 5) PDF regression tripwires: no 1970 date next to the label wording and
  //    no "sync time unavailable" fallback anywhere.
  steps.push({
    name: 'PDF: no "sync time unavailable" fallback and no 1970 last-synced date',
    passed:
      !nPdf.includes(norm('sync time unavailable')) &&
      !/lastsynced[^A-Za-z]*1970/i.test(nPdf),
    detail: 'checked fallback + 1970 tokens',
  });

  const ok = steps.every((s) => s.passed);
  console.log(`[pof-lastsynced] ok=${ok}`);
  for (const s of steps) {
    console.log(`  [${s.passed ? 'PASS' : 'FAIL'}] ${s.name} :: ${s.detail}`);
  }

  if (!ok) {
    console.error('\n[pof-lastsynced] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[pof-lastsynced] PASSED: the offline last-synced date renders correctly on the page and in the exported PDF.',
  );
}

main().catch((err) => {
  console.error('[pof-lastsynced] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
