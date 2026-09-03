#!/usr/bin/env node
// Real-browser guard for the authenticated global command palette. It verifies
// the Cmd/Ctrl-K shortcut, route aliases, local metadata search, canonical txid
// lookup, hidden-tier exclusion, and keyboard selection against live IndexedDB.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const LABEL = 'global-command-search-browser';
const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'global-command-check-123';
const VISIBLE_TXID = 'abc123'.repeat(10) + 'abcd';
const HIDDEN_TXID = 'def456'.repeat(10) + 'def0';
const METADATA_NEEDLE = 'command-metadata-needle';

function resolveChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return execSync('which chromium', { encoding: 'utf8' }).trim();
}

async function isServerUp() {
  try {
    const response = await fetch(BASE_URL);
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Dev server did not become ready at ${BASE_URL}`);
}

async function main() {
  let devProc = null;
  let startedServer = false;
  if (!(await isServerUp())) {
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    await waitForServer();
  }

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: LABEL });
    await page.getByTestId('button-command-search').waitFor({ state: 'visible', timeout: 30_000 });

    const seeded = await page.evaluate(async ({ visibleTxid, hiddenTxid, needle }) => {
      const { createRecord } = await import('/src/lib/data/record-crud.ts');
      const visibleId = await createRecord({
        type: 'transaction',
        inputString: visibleTxid,
        label: 'Palette browser record',
        notes: needle,
        tags: ['browser-command'],
        categories: [],
        addressImportance: 'manual',
      });
      const hiddenId = await createRecord({
        type: 'transaction',
        inputString: hiddenTxid,
        label: 'Hidden palette record',
        tags: [],
        categories: [],
        addressImportance: 'pending-review',
        source: 'blockchain-sync',
      });
      return { visibleId, hiddenId };
    }, { visibleTxid: VISIBLE_TXID, hiddenTxid: HIDDEN_TXID, needle: METADATA_NEEDLE });

    await page.keyboard.press('Control+K');
    const input = page.getByTestId('input-command-search');
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill('add address');
    const aliasResult = page.getByTestId('command-page-address-importer');
    await aliasResult.waitFor({ state: 'visible', timeout: 10_000 });
    await aliasResult.click();
    await page.waitForURL((url) => url.pathname === '/import', { timeout: 10_000 });

    await page.keyboard.press('Control+K');
    await input.fill(METADATA_NEEDLE);
    const metadataResult = page.getByTestId(`command-record-${seeded.visibleId}`);
    await metadataResult.waitFor({ state: 'visible', timeout: 10_000 });

    // Keyboard selection, not a coordinate click: the matching record is the
    // only selectable result for this metadata term.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.getByTestId('text-panel-identifier').waitFor({ state: 'visible', timeout: 10_000 });
    const openedIdentifier = (await page.getByTestId('text-panel-identifier').textContent())?.trim();
    if (openedIdentifier !== VISIBLE_TXID) {
      throw new Error(`metadata result opened ${openedIdentifier}, expected ${VISIBLE_TXID}`);
    }
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+K');
    await input.fill(VISIBLE_TXID.toUpperCase());
    await page.getByTestId(`command-record-${seeded.visibleId}`).waitFor({ state: 'visible', timeout: 10_000 });
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+K');
    await input.fill(HIDDEN_TXID.toUpperCase());
    await page.waitForTimeout(400);
    if (await page.getByTestId(`command-record-${seeded.hiddenId}`).count()) {
      throw new Error('hidden pending-review record leaked into command search');
    }

    console.log(
      `[${LABEL}] PASSED: shortcut, alias navigation, keyboard selection, local metadata search, canonical txid lookup, and hidden-row exclusion work in Chromium.`,
    );
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        devProc.kill('SIGTERM');
      }
    }
  }
}

main().catch((error) => {
  console.error(`[${LABEL}] ERROR:`, error?.stack ?? error);
  process.exit(1);
});