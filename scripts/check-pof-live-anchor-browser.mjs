#!/usr/bin/env node
// Real-browser regression guard for the Proof-of-Funds LIVE balance check's
// block anchor + timestamp — end to end, from a stubbed Esplora provider
// (tip height + address stats fulfilled via Playwright network interception,
// nothing leaves the machine) through the on-page summary label
// ("Live on-chain check — block N (date)") to the
// "On-chain data current as of: Block N — date" line in the PDF's Document
// Integrity section.
//
// NOTE for reviewers: the page under test is client/src/pages/
// ProofOfFundsDeclaration.tsx (route /proof-of-funds); the summary label is
// built in client/src/pages/proof-of-funds/use-balance-check.ts (live branch:
// blockHeight from provider.getBlockHeight(), nowTs = Unix SECONDS) and the
// PDF anchor line in client/src/pages/proof-of-funds/pof-pdf-section-signature.ts
// (renderDocumentIntegrity). pdf.js (legacy build) is only the verification
// oracle, same as the other PDF checks.
//
// What a regression here looks like (and what this script would catch):
//   - nowTs fed as MILLISECONDS into formatUnix → far-future 5+ digit year
//   - blockHeight dropped → label degrades to the height-less fallback and
//     the PDF loses the "Block N —" anchor
//   - PDF renders a different timestamp than the page (units drift between
//     the two surfaces)
//
// Assertions:
//   1. on-page label matches `Live on-chain check — block <tip> (<date>)`
//      with the tip formatted via toLocaleString and <date> equal to
//      formatUnix(t) for a minute inside the observed check window
//      (current-era, not 1970, no 5+ digit year)
//   2. the PDF's Document Integrity section contains
//      "On-chain data current as of: Block <tip> — <same date>"
//   3. tripwires: no 1970, no far-future year near the anchor, and the
//      height-less "On-chain data as of:" fallback is NOT used
//
// Usage: node scripts/check-pof-live-anchor-browser.mjs
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
const SETUP_PASSWORD = 'pof-live-anchor-check-123';

// BIP-173 test vector address (valid P2WPKH).
const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const FUNDED_SATS = 750_000;

// Stubbed chain tip returned by the fake Esplora node.
const TIP_HEIGHT = 840_000;

// Default provider is mempool.space (Esplora) on mainnet.
const ESPLORA_HOST_GLOB = 'https://mempool.space/api/**';

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
      console.log(`[pof-live-anchor] chromium launch attempt ${i + 1} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Esplora address-stats JSON body for a given confirmed balance. */
function esploraAddressBody(address, balanceSats) {
  return JSON.stringify({
    address,
    chain_stats: {
      funded_txo_count: 1,
      funded_txo_sum: balanceSats,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 1,
    },
    mempool_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    },
  });
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
  console.log(`[pof-live-anchor] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;

  if (await isServerUp(BASE_URL)) {
    console.log(`[pof-live-anchor] reusing dev server at ${BASE_URL}`);
  } else {
    console.log(`[pof-live-anchor] starting dev server (npm run dev) ...`);
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
    console.log(`[pof-live-anchor] dev server ready at ${BASE_URL}`);
  }

  const browser = await launchWithRetry(exe);

  let pdfBytes = null;
  let uiLabel = null;
  let expectedTipStr = null;
  let anchorDate = null;
  let dateCandidates = [];

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    // Block everything non-local by default; the Esplora stub route below is
    // registered AFTER, so it takes precedence for mempool.space requests.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE_URL) || url.startsWith('data:')) {
        return route.continue();
      }
      return route.abort();
    });
    // Stub the live Esplora provider: fixed tip height + a funded address.
    await context.route(ESPLORA_HOST_GLOB, async (route) => {
      const url = route.request().url();
      if (url.includes('/blocks/tip/height')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          body: String(TIP_HEIGHT),
        });
        return;
      }
      const m = url.match(/\/address\/([^/?]+)/);
      if (m) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: esploraAddressBody(m[1], FUNDED_SATS),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    const page = await context.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.toLowerCase().includes('error')) {
        console.log(`[pof-live-anchor][page-console] ${t}`);
      }
    });

    // Retry the initial navigation: under parallel validation the first goto
    // can time out while the dev server warms up.
    let navigated = false;
    for (let i = 0; i < 3 && !navigated; i++) {
      try {
        await page.goto(PROOF_URL, { waitUntil: 'load', timeout: 60_000 });
        await page.getByTestId('input-password').waitFor({ state: 'visible', timeout: 45_000 });
        navigated = true;
      } catch (err) {
        console.log(`[pof-live-anchor] goto attempt ${i + 1} failed: ${err.message}`);
        if (i === 2) throw err;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // ── Create the vault ───────────────────────────────────────────────────
    await page.getByTestId('input-password').fill(SETUP_PASSWORD);
    const confirmInput = page.getByTestId('input-confirm-password');
    await confirmInput.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmInput.fill(SETUP_PASSWORD);
    await page.getByTestId('button-submit').click();

    const textarea = page.getByTestId('textarea-address-input');
    await textarea.waitFor({ state: 'visible', timeout: 30_000 });

    // ── LIVE balance check against the stubbed node ────────────────────────
    // Capture the check window [tBefore, tAfter] (Unix seconds, page clock)
    // so the label's date can be matched exactly against formatUnix(t) for
    // every minute in the window — no locale/timezone assumptions in Node.
    const tBefore = await page.evaluate(() => Math.floor(Date.now() / 1000));
    await page.getByTestId('button-source-live').click();
    await textarea.fill(ADDRESS);
    await page.getByTestId('button-check-balances').click();

    const labelEl = page.getByTestId('text-data-source-note');
    await labelEl.waitFor({ state: 'visible', timeout: 30_000 });
    uiLabel = ((await labelEl.evaluate((el) => el.textContent)) ?? '').trim();
    console.log(`[pof-live-anchor] on-page label: ${uiLabel}`);

    // Expected block-height string + candidate formatUnix dates for every
    // minute in the observed window, computed with the app's own formatter.
    const oracle = await page.evaluate(
      async ({ tip, t0 }) => {
        const helpers = await import('/src/pages/proof-of-funds/address-helpers.ts');
        const t1 = Math.floor(Date.now() / 1000);
        const candidates = [];
        for (let t = t0; t <= t1 + 60; t += 60) candidates.push(helpers.formatUnix(t));
        candidates.push(helpers.formatUnix(t1));
        return {
          tipStr: tip.toLocaleString(),
          candidates: Array.from(new Set(candidates)),
        };
      },
      { tip: TIP_HEIGHT, t0: tBefore },
    );
    expectedTipStr = oracle.tipStr;
    dateCandidates = oracle.candidates;

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
    console.log(`[pof-live-anchor] captured PDF (${pdfBytes.byteLength} bytes)`);
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

  // Parse the on-page label: "Live on-chain check — block <tip> (<date>)".
  const labelMatch = uiLabel.match(/^Live on-chain check — block (.+) \((.+)\)$/);
  const labelTipStr = labelMatch ? labelMatch[1] : null;
  anchorDate = labelMatch ? labelMatch[2] : null;

  const steps = [];

  steps.push({
    name: 'page: label has the "Live on-chain check — block N (date)" shape',
    passed: !!labelMatch,
    detail: `ui="${uiLabel}"`,
  });

  steps.push({
    name: `page: block height is the stubbed tip (${TIP_HEIGHT})`,
    passed: labelTipStr === expectedTipStr,
    detail: `label="${labelTipStr}" expected="${expectedTipStr}"`,
  });

  steps.push({
    name: 'page: label date equals formatUnix(t) for a minute in the check window',
    passed: anchorDate !== null && dateCandidates.includes(anchorDate),
    detail: `date="${anchorDate}" candidates=${JSON.stringify(dateCandidates)}`,
  });

  // Units tripwires: raw-ms timestamps render 5+ digit years; a zero/undefined
  // timestamp renders 1970.
  steps.push({
    name: 'page: label is not 1970 and has no far-future (5+ digit) year',
    passed: !uiLabel.includes('1970') && !/\d{5,}/.test(uiLabel.replace(/[\d,]*,\d{3}/g, '')),
    detail: uiLabel,
  });

  // PDF Document Integrity anchor line with block height AND the same date
  // the page showed (both surfaces render the same summary.timestamp).
  const expectedAnchor = `On-chain data current as of: Block ${expectedTipStr} — ${anchorDate}`;
  steps.push({
    name: 'PDF: "On-chain data current as of:" line carries Block N — same date',
    passed: anchorDate !== null && nPdf.includes(norm(expectedAnchor)),
    detail: `looked for "${expectedAnchor}"`,
  });

  // The full live summary label (block + date) also appears in the PDF
  // (declaration data-source line / canonical payload SOURCE line).
  steps.push({
    name: 'PDF: live data-source label with block + date is present',
    passed: nPdf.includes(norm(uiLabel)),
    detail: `looked for "${uiLabel}"`,
  });

  // Regression tripwires in the PDF: the height-less fallback line must NOT
  // be used, and no 1970 date may sit next to the anchor wording.
  const pdfAnchorRegion = nPdf;
  steps.push({
    name: 'PDF: no height-less "On-chain data as of:" fallback and no 1970 anchor',
    passed:
      !pdfAnchorRegion.includes(norm('On-chain data as of:')) &&
      !/currentasof[^A-Za-z]*Block[^A-Za-z]*[\d,]+—[^—]*1970/i.test(pdfAnchorRegion),
    detail: 'checked fallback label + 1970 tokens',
  });

  const ok = steps.every((s) => s.passed);
  console.log(`[pof-live-anchor] ok=${ok}`);
  for (const s of steps) {
    console.log(`  [${s.passed ? 'PASS' : 'FAIL'}] ${s.name} :: ${s.detail}`);
  }

  if (!ok) {
    console.error('\n[pof-live-anchor] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '[pof-live-anchor] PASSED: the live block anchor and timestamp render correctly on the page and in the exported PDF.',
  );
}

main().catch((err) => {
  console.error('[pof-live-anchor] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
