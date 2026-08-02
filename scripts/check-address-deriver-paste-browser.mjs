#!/usr/bin/env node
// Real-browser verification for Task #1797: pasting BSMS file content and a
// Sparrow JSON export into the Address Deriver must classify the source
// (badge) and derive real address rows in headless Chromium. jsdom/vitest
// cover the logic, but browser-only crypto/Buffer crashes are only catchable
// here (see .agents/memory/browser-crypto-regression-check.md).
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'deriver-paste-e2e-' + Date.now();

// Known-valid multisig xpubs (same key material as check-descriptor-import-browser.mjs).
const MS_XPUB_A =
  "xpub6F3pzEQsRBs6kMt97AbjvUuCxcWRzPXqjpnNZ75dEdpK8WdmnapCcCmk5gu6A61WvYncw6hUkwCtrhZB2ADG6jNJkftEuTcqR166FRoqh1M";
const MS_XPUB_B =
  "xpub6E7xERGGinZFnZW21bUfFgGGoC78E71n9ShHKMDzb91s9boZDeeNMykNSBxvQyq5sgT5a7vBZrb9jSKYzSoyCAsbEiGuabdbG7miekRRwTH";

// BSMS 1.0 file content: `/**` wildcard = dual-chain, "/0/*,/1/*" restriction line.
const BSMS_CONTENT = [
  'BSMS 1.0',
  `wsh(sortedmulti(2,[bbbbbbbb/48'/0'/0'/2']${MS_XPUB_A}/**,[cccccccc/48'/0'/0'/2']${MS_XPUB_B}/**))`,
  '/0/*,/1/*',
].join('\r\n') + '\r\n';

// Sparrow JSON export wrapping a BIP-84 single-sig descriptor; the zpub is the
// BIP-84 test vector, so the first receive address is pinned and well known.
const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const BIP84_FIRST_RECEIVE = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const SPARROW_JSON = JSON.stringify({
  label: 'Family Vault',
  descriptor: `wpkh([73c5da0a/84'/0'/0']${BIP84_ZPUB}/<0;1>/*)`,
});

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} :: ${detail}`);
  if (!ok) failures++;
};

function chromiumBin() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return execSync('which chromium', { encoding: 'utf8' }).trim();
}

async function unlockIfNeeded(page) {
  const pw = page.getByTestId('input-password');
  const visible = await pw.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
  if (visible) {
    await pw.fill(PASSWORD);
    const confirm = page.getByTestId('input-confirm-password');
    if (await confirm.isVisible().catch(() => false)) await confirm.fill(PASSWORD);
    await page.getByTestId('button-submit').click();
  }
  await page.getByTestId('button-dismiss-migration').click({ timeout: 4_000 }).catch(() => {});
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
    console.log(`[address-deriver-paste-browser] reusing dev server at ${BASE_URL}`);
    return;
  }
  console.log('[address-deriver-paste-browser] starting dev server (npm run dev) ...');
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

// Pastes `input`, clicks Derive, and returns everything the assertions need.
async function runDerive(page, input, label) {
  const ta = page.getByTestId('textarea-key-input');
  await ta.waitFor({ state: 'visible', timeout: 30_000 });
  await ta.fill(input);
  await page.getByTestId('button-derive').click();

  const outcome = await Promise.race([
    page.getByTestId('list-derived-addresses')
      .waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'rows'),
    page.getByTestId('alert-derive-error')
      .waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'error'),
  ]).catch(() => 'timeout');

  if (outcome === 'error') {
    const err = await page.getByTestId('alert-derive-error').innerText().catch(() => '(unreadable)');
    check(`${label}: derivation succeeds`, false, `derive error: ${err}`);
    return null;
  }
  check(`${label}: derived rows rendered`, outcome === 'rows', `outcome=${outcome}`);
  if (outcome !== 'rows') return null;

  const sourceBadge = await page.getByTestId('badge-source').innerText().catch(() => '(no badge)');
  const resultCount = await page.getByTestId('text-result-count').innerText().catch(() => '');
  const rows = await page.getByTestId('list-derived-addresses')
    .locator('[data-testid^="row-derived-"]').count();
  const firstRow = rows > 0
    ? await page.getByTestId('row-derived-0').innerText().catch(() => '')
    : '';
  return { sourceBadge, resultCount, rows, firstRow };
}

async function main() {
  await ensureServer();
  const browser = await launchBrowserWithRetry();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.log(`[pageerror] ${e.message}`);
  });

  let loaded = false, lastErr;
  for (let i = 0; i < 3 && !loaded; i++) {
    try {
      await page.goto(`${BASE_URL}address-deriver`, { waitUntil: 'load', timeout: 90_000 });
      loaded = true;
    } catch (e) {
      lastErr = e;
      console.log(`[goto retry ${i + 1}/3] ${e.message?.split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (!loaded) throw lastErr;
  await unlockIfNeeded(page);

  // ── BSMS paste: multisig dual-chain descriptor, 20 receive addresses ──
  const bsms = await runDerive(page, BSMS_CONTENT, 'BSMS');
  if (bsms) {
    check('BSMS: source badge says "From BSMS file"',
      bsms.sourceBadge === 'From BSMS file', `badge="${bsms.sourceBadge}"`);
    check('BSMS: 20 receive rows derived',
      bsms.rows === 20 && /20 addresses derived/.test(bsms.resultCount),
      `rows=${bsms.rows} count="${bsms.resultCount}"`);
    check('BSMS: first row is a bech32 P2WSH address',
      /bc1q[a-z0-9]{50,}/.test(bsms.firstRow.replace(/\s/g, '')),
      `firstRow="${bsms.firstRow.replace(/\s+/g, ' ').trim()}"`);
  }

  // ── Sparrow JSON paste: single-sig BIP-84 with pinned first address ──
  const sparrow = await runDerive(page, SPARROW_JSON, 'Sparrow');
  if (sparrow) {
    check('Sparrow: source badge says "From Sparrow export"',
      sparrow.sourceBadge === 'From Sparrow export', `badge="${sparrow.sourceBadge}"`);
    const label = await page.getByTestId('text-wallet-label').innerText().catch(() => '(missing)');
    check('Sparrow: wallet label shown', label === 'Family Vault', `label="${label}"`);
    check('Sparrow: 20 receive rows derived',
      sparrow.rows === 20 && /20 addresses derived/.test(sparrow.resultCount),
      `rows=${sparrow.rows} count="${sparrow.resultCount}"`);
    check('Sparrow: first address matches the BIP-84 test vector',
      sparrow.firstRow.includes(BIP84_FIRST_RECEIVE),
      `firstRow="${sparrow.firstRow.replace(/\s+/g, ' ').trim()}"`);
  }

  check('no uncaught page errors', pageErrors.length === 0, `pageErrors=${pageErrors.length}`);

  await browser.close();
  stopSpawnedServer();
  if (failures > 0) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
  console.log('ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); stopSpawnedServer(); process.exit(1); });
