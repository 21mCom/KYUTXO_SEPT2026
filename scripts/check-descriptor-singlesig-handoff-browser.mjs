#!/usr/bin/env node
// Task #1614: real-browser verification of the single-sig descriptor handoff.
// Pastes a wpkh descriptor (key origin + <0;1> wildcard) into Descriptor
// Import, asserts the handoff panel appears (no parse error), clicks
// "Continue in Address Importer", and asserts the Address Importer xpub input
// holds the re-encoded zpub and the first derived receive address matches the
// descriptor's expected bc1q address.
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'singlesig-handoff-e2e-' + Date.now();

// BIP32 test-vector xpub (depth 0 -> Electrum-style 0/<n> receive path in the
// Address Importer, matching the descriptor's /<0;1>/* wildcard).
const XPUB = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
const DESCRIPTOR = `wpkh([aabbccdd/84'/0'/0']${XPUB}/<0;1>/*)`;
// convertExtendedKeyPrefix(XPUB, 'zpub') — precomputed with bip32/bs58check.
const EXPECTED_ZPUB = 'zpub6jftahH18ngZxUuv6oSniLNrBCSSE1B4EEU59bwTCEt8x6aS6b2mdfLxbS4QS53g85SWWP6wexqeer516433gYpZQoJie2tcMYdJ1SYYYAL';
// p2wpkh address at 0/0 of the key — what the descriptor specifies for the
// first receive slot.
const EXPECTED_FIRST_ADDRESS = 'bc1qp5wfcq48h6d63wyy9qz0awtpfqwwv4sma86mhz';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} :: ${detail}`);
  if (!ok) failures++;
};

function chromiumBin() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return execSync('which chromium', { encoding: 'utf8' }).trim();
}

async function launchBrowserWithRetry(attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launch({
        executablePath: chromiumBin(), headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      lastErr = e;
      console.log(`[launch retry ${i + 1}/${attempts}] ${e.message?.split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
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

let devProc = null;

async function ensureServer() {
  if (await isServerUp(BASE_URL)) {
    console.log(`[singlesig-handoff-browser] reusing dev server at ${BASE_URL}`);
    return;
  }
  console.log('[singlesig-handoff-browser] starting dev server (npm run dev) ...');
  devProc = spawn('npm', ['run', 'dev'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
    detached: true,
  });
  if (!(await waitForServer(BASE_URL, 120_000))) {
    throw new Error(`Dev server did not become ready at ${BASE_URL} within 120s.`);
  }
}

function stopSpawnedServer() {
  if (!devProc) return;
  try {
    process.kill(-devProc.pid, 'SIGTERM');
  } catch {
    try { devProc.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

async function main() {
  await ensureServer();
  const browser = await launchBrowserWithRetry();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

  let loaded = false, lastErr;
  for (let i = 0; i < 3 && !loaded; i++) {
    try {
      await page.goto(`${BASE_URL}descriptor-import`, { waitUntil: 'load', timeout: 90_000 });
      loaded = true;
    } catch (e) {
      lastErr = e;
      console.log(`[goto retry ${i + 1}/3] ${e.message?.split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (!loaded) throw lastErr;
  await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 8_000 });

  // Step 1: paste the single-sig descriptor.
  const ta = page.getByTestId('textarea-descriptor');
  await ta.waitFor({ state: 'visible', timeout: 30_000 });
  await ta.fill(DESCRIPTOR);

  // Handoff panel appears instead of a parse error.
  const handoffVisible = await page.getByTestId('alert-singlesig-handoff')
    .waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  check('single-sig handoff panel appears', handoffVisible, `visible=${handoffVisible}`);
  const parseErrors = await page.locator('text=Parse Error').count();
  check('no parse error shown', parseErrors === 0, `parseErrorEls=${parseErrors}`);
  if (!handoffVisible) throw new Error('Handoff panel never appeared; cannot continue.');

  const handoffText = await page.getByTestId('alert-singlesig-handoff').innerText();
  check('handoff shows Native SegWit script type', /Native SegWit/.test(handoffText), handoffText.split('\n')[1] || handoffText.slice(0, 80));
  check('handoff shows fingerprint aabbccdd', /aabbccdd/.test(handoffText), 'fingerprint line');

  // Click through to the Address Importer.
  await page.getByTestId('button-continue-address-importer').click();
  await page.waitForURL(/\/import\?/, { timeout: 30_000 });
  const url = new URL(page.url());
  check('navigates to /import with descriptor source', url.pathname === '/import' && url.searchParams.get('source') === 'descriptor', url.search);

  // Xpub input prefilled with the re-encoded zpub.
  const xpubInput = page.getByTestId('input-xpub');
  await xpubInput.waitFor({ state: 'visible', timeout: 30_000 });
  const prefilled = (await xpubInput.inputValue()).trim();
  check('xpub input prefilled with re-encoded zpub', prefilled === EXPECTED_ZPUB, prefilled.slice(0, 20) + '...');

  // Continue to derivation (small range keeps it fast; the range inputs live
  // inside the Advanced Settings collapsible) and verify the first derived
  // receive address matches the descriptor's expected bc1q address.
  await page.getByTestId('button-next-step1').click();
  await page.getByTestId('button-toggle-advanced').click();
  await page.getByTestId('input-end-index').fill('4');
  await page.getByTestId('input-change-end-index').fill('4');
  await page.getByTestId('button-next-step2').click();

  const firstRow = page.getByTestId('address-preview-receive-0');
  await firstRow.waitFor({ state: 'visible', timeout: 120_000 });
  const rowText = await firstRow.innerText();
  check('first derived address matches descriptor bc1q address',
    rowText.includes(EXPECTED_FIRST_ADDRESS), rowText.replace(/\s+/g, ' ').slice(0, 120));

  await browser.close();
  stopSpawnedServer();
  if (failures > 0) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
  console.log('ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); stopSpawnedServer(); process.exit(1); });
