#!/usr/bin/env node
// Full e2e verification for Task #1556: taproot + multisig descriptor imports,
// re-import (dedup/update path), Dexie state, and Records page visibility.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'descriptor-e2e-' + Date.now();

const TR_DESC = "tr([aaaaaaaa/86'/0'/0']xpub6C3YK1g1GPYVABTDS3LDq7XVrtmfZz74n5w3bw4kBoW5wgvhrpAmW7LT5WPQTRoXEbNfsSeuSBdEwzmk6eU9cooqTyZN7BfY3X2Q8KeFsKo/<0;1>/*)";
const MS_DESC = "wsh(sortedmulti(2,[bbbbbbbb/48'/0'/0'/2']xpub6F3pzEQsRBs6kMt97AbjvUuCxcWRzPXqjpnNZ75dEdpK8WdmnapCcCmk5gu6A61WvYncw6hUkwCtrhZB2ADG6jNJkftEuTcqR166FRoqh1M/<0;1>/*,[cccccccc/48'/0'/0'/2']xpub6E7xERGGinZFnZW21bUfFgGGoC78E71n9ShHKMDzb91s9boZDeeNMykNSBxvQyq5sgT5a7vBZrb9jSKYzSoyCAsbEiGuabdbG7miekRRwTH/<0;1>/*))";

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

async function runImport(page, descriptor, label) {
  await page.goto(`${BASE_URL}descriptor-import`, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page);
  const ta = page.getByTestId('textarea-descriptor');
  await ta.waitFor({ state: 'visible', timeout: 30_000 });
  await ta.fill(descriptor);
  await page.waitForTimeout(800);
  await page.getByTestId('input-receive-end').fill('99');
  await page.getByTestId('input-change-end').fill('99');
  await page.getByTestId('button-derive-addresses').click();
  const importBtn = page.getByTestId('button-import-addresses');
  await importBtn.waitFor({ state: 'visible', timeout: 180_000 });
  await importBtn.click();
  const done = await page.getByTestId('button-view-records')
    .waitFor({ state: 'visible', timeout: 120_000 }).then(() => true).catch(() => false);
  const summary = done
    ? await page.getByTestId('text-save-summary').innerText().catch(() => '(no summary)')
    : '(step 3 never rendered)';
  const problems = await page.getByTestId('alert-save-problems').count();
  check(`${label}: import completes to step 3`, done, summary);
  check(`${label}: no save problems reported`, problems === 0, `problemAlerts=${problems}`);
  return summary;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: chromiumBin(), headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page);

  const s1 = await runImport(page, TR_DESC, 'taproot');
  check('taproot: 200 verified', /200 address\(es\) imported and verified.*200 created, 0 updated/.test(s1), s1);

  const s2 = await runImport(page, MS_DESC, 'multisig');
  check('multisig: 200 verified', /200 address\(es\) imported and verified.*200 created, 0 updated/.test(s2), s2);

  // Re-import taproot over existing rows -> dedup/update path.
  const s3 = await runImport(page, TR_DESC, 'taproot re-import');
  check('re-import: 200 updated', /200 address\(es\) imported and verified.*0 created, 200 updated/.test(s3), s3);

  const state = await page.evaluate(async () => {
    const { db } = await import('/src/lib/database.ts');
    return {
      records: await db.records.count(),
      xpubTier: await db.records.where('[type+addressImportance]').equals(['address', 'xpub-derived']).count(),
    };
  });
  check('Dexie: 400 records all xpub-derived', state.records === 400 && state.xpubTier === 400, JSON.stringify(state));

  // Records page shows them without manual refresh.
  await page.goto(`${BASE_URL}records`, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page);
  await page.waitForTimeout(8000);
  const body = await page.locator('body').innerText();
  const totalOk = /of 400/.test(body);
  const hasRows = /Taproot (Receive|Change) #\d+|Multisig (Receive|Change) #\d+|bc1p/.test(body);
  check('Records page shows 400 total with imported rows', totalOk && hasRows, `totalOk=${totalOk} rows=${hasRows}`);

  await browser.close();
  if (failures > 0) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
  console.log('ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
