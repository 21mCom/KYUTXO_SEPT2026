#!/usr/bin/env node
// Task #1603: verify step transitions in the Descriptor Import wizard land at
// the top of the scroll container (Metadata panel visible), in both directions,
// and combobox popovers still focus their search input.
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'scrolljump-e2e-' + Date.now();

const TR_DESC = "tr([aaaaaaaa/86'/0'/0']xpub6C3YK1g1GPYVABTDS3LDq7XVrtmfZz74n5w3bw4kBoW5wgvhrpAmW7LT5WPQTRoXEbNfsSeuSBdEwzmk6eU9cooqTyZN7BfY3X2Q8KeFsKo/<0;1>/*)";

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

const getScroll = (page) => page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('main div.flex-1.overflow-auto.p-6'));
  const el = els.find((e) => e.scrollHeight > e.clientHeight) || els[0];
  return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null;
});

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

// Started dev-server process (if we had to spawn one) for cleanup at exit.
let devProc = null;

async function ensureServer() {
  if (await isServerUp(BASE_URL)) {
    console.log(`[descriptor-import-scroll] reusing dev server at ${BASE_URL}`);
    return;
  }
  console.log('[descriptor-import-scroll] starting dev server (npm run dev) ...');
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
  await unlockIfNeeded(page);

  const ta = page.getByTestId('textarea-descriptor');
  await ta.waitFor({ state: 'visible', timeout: 30_000 });
  await ta.fill(TR_DESC);
  await page.waitForTimeout(800);
  await page.getByTestId('input-receive-end').fill('99');
  await page.getByTestId('input-change-end').fill('99');

  // Scroll to the bottom of step 1 so residual scroll would carry over.
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('main div.flex-1.overflow-auto.p-6'));
    const el = els.find((e) => e.scrollHeight > e.clientHeight);
    if (el) el.scrollTop = el.scrollHeight;
  });

  await page.getByTestId('button-derive-addresses').click();
  await page.getByTestId('button-import-addresses').waitFor({ state: 'visible', timeout: 180_000 });
  await page.waitForTimeout(500);

  let s = await getScroll(page);
  check('step 1→2 lands at top', s && s.top === 0, JSON.stringify(s));
  const metaVisible = await page.getByTestId('select-owner').isVisible();
  check('Metadata panel visible on step 2', metaVisible, `visible=${metaVisible}`);

  // Owner combobox still focuses its search input.
  await page.getByTestId('select-owner').click();
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() =>
    document.activeElement?.getAttribute('placeholder') || document.activeElement?.tagName);
  check('owner combobox focuses search input', String(focused).includes('owner'), String(focused));
  await page.keyboard.press('Escape');

  // Scroll down within step 2, then go back to step 1.
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('main div.flex-1.overflow-auto.p-6'));
    const el = els.find((e) => e.scrollHeight > e.clientHeight);
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.getByTestId('button-back-step1').click();
  await page.getByTestId('button-derive-addresses').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(500);
  s = await getScroll(page);
  check('step 2→1 lands at top', s && s.top === 0, JSON.stringify(s));

  // Forward again 1→2, then run the import to reach step 3.
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('main div.flex-1.overflow-auto.p-6'));
    const el = els.find((e) => e.scrollHeight > e.clientHeight);
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.getByTestId('button-derive-addresses').click();
  await page.getByTestId('button-import-addresses').waitFor({ state: 'visible', timeout: 180_000 });
  await page.waitForTimeout(500);
  s = await getScroll(page);
  check('step 1→2 (second pass) lands at top', s && s.top === 0, JSON.stringify(s));

  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('main div.flex-1.overflow-auto.p-6'));
    const el = els.find((e) => e.scrollHeight > e.clientHeight);
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.getByTestId('button-import-addresses').click();
  await page.getByTestId('button-view-records').waitFor({ state: 'visible', timeout: 120_000 });
  await page.waitForTimeout(500);
  s = await getScroll(page);
  check('step 2→3 lands at top', !s || s.top === 0, JSON.stringify(s));

  await browser.close();
  stopSpawnedServer();
  if (failures > 0) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
  console.log('ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); stopSpawnedServer(); process.exit(1); });
