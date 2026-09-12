#!/usr/bin/env node
// Real-browser check for the mode-specific primary action and cancellation
// behavior in the Settings entity-list import confirmation dialog.
//
// The existing entity-list checks cover warning rendering, preview math, diff
// controls, and large-list behavior; this check protects the final user-facing
// action labels and verifies that canceling a staged preview leaves the active
// list untouched.
//
// Usage: node scripts/check-entity-list-import-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

// Browser checks share port 5000 and system resources, so serialize this
// check with the other real-Chromium checks.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETTINGS_URL = `${BASE_URL}settings`;
const SETUP_PASSWORD = 'entity-list-import-check-123';
const RUN_ID = `${Date.now()}-${process.pid}`;

const REPLACE_ENTRIES = [
  {
    address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo',
    name: `Replace cancel fixture ${RUN_ID}`,
    category: 'exchange',
  },
];
const MERGE_ENTRIES = [
  {
    address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    name: `Merge cancel fixture ${RUN_ID}`,
    category: 'mixer',
  },
];

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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function launchWithRetry(executablePath, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
      }
    }
  }
  throw lastError;
}

async function waitForPreview(page) {
  await page.getByTestId('text-preview-incoming').waitFor({
    state: 'visible',
    timeout: 30_000,
  });
}

async function importSnapshot(page, fileName, entries) {
  await page.getByTestId('input-entity-file').setInputFiles({
    name: fileName,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(entries)),
  });
  await waitForPreview(page);
}

async function readActiveListSummary(page) {
  const source = (await page.getByTestId('badge-entity-source').textContent())?.trim() ?? '';
  const count = (await page.getByTestId('text-entity-count').textContent())?.trim() ?? '';
  return { source, count };
}

async function cancelPreview(page) {
  await page.getByTestId('button-cancel-entity-import').click();
  await page.getByTestId('text-preview-incoming').waitFor({
    state: 'detached',
    timeout: 30_000,
  });
}

async function main() {
  const executablePath = resolveChromium();
  let devProc = null;
  let browser = null;
  const checks = [];
  const check = (name, passed, detail = '') => {
    checks.push({ name, passed: Boolean(passed), detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    if (!(await isServerUp(BASE_URL))) {
      console.log('[entity-list-import-browser] starting dev server ...');
      devProc = spawn('npm', ['run', 'dev'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
        detached: true,
      });
      if (!(await waitForServer(BASE_URL, 120_000))) {
        throw new Error(`Dev server did not become ready at ${BASE_URL} within 120s.`);
      }
    } else {
      console.log(`[entity-list-import-browser] reusing dev server at ${BASE_URL}`);
    }

    browser = await launchWithRetry(executablePath);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (error) =>
      console.log(`[entity-list-import-browser] pageerror: ${error.message}`),
    );

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 90_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'entity-list-import-browser',
    });

    await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 90_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: 'entity-list-import-browser',
    });
    await page.getByTestId('button-import-entities').waitFor({
      state: 'visible',
      timeout: 60_000,
    });

    // Replace is the default mode. Capture the live list before staging a
    // unique fixture, then cancel and verify neither displayed value changed.
    const replaceBefore = await readActiveListSummary(page);
    await importSnapshot(page, `replace-cancel-${RUN_ID}.json`, REPLACE_ENTRIES);
    const replaceButton = page.getByTestId('button-confirm-entity-import');
    const replaceLabel = (await replaceButton.textContent())?.trim() ?? '';
    check(
      'replace preview shows Replace list and not Merge list',
      replaceLabel.includes('Replace list') && !replaceLabel.includes('Merge list'),
      replaceLabel,
    );
    await cancelPreview(page);
    const replaceAfter = await readActiveListSummary(page);
    check(
      'canceling replace preview preserves the active source badge',
      replaceAfter.source === replaceBefore.source,
      `before=${replaceBefore.source} after=${replaceAfter.source}`,
    );
    check(
      'canceling replace preview preserves the active entry count',
      replaceAfter.count === replaceBefore.count,
      `before=${replaceBefore.count} after=${replaceAfter.count}`,
    );

    await page.getByTestId('radio-entity-merge').click();
    const mergeBefore = await readActiveListSummary(page);
    await importSnapshot(page, `merge-cancel-${RUN_ID}.json`, MERGE_ENTRIES);
    const mergeButton = page.getByTestId('button-confirm-entity-import');
    const mergeLabel = (await mergeButton.textContent())?.trim() ?? '';
    check(
      'merge preview shows Merge list and not Replace list',
      mergeLabel.includes('Merge list') && !mergeLabel.includes('Replace list'),
      mergeLabel,
    );
    await cancelPreview(page);
    const mergeAfter = await readActiveListSummary(page);
    check(
      'canceling merge preview preserves the active source badge',
      mergeAfter.source === mergeBefore.source,
      `before=${mergeBefore.source} after=${mergeAfter.source}`,
    );
    check(
      'canceling merge preview preserves the active entry count',
      mergeAfter.count === mergeBefore.count,
      `before=${mergeBefore.count} after=${mergeAfter.count}`,
    );

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          // Best-effort cleanup for a server this script started.
        }
      }
    }
  }

  const failed = checks.filter((entry) => !entry.passed);
  console.log(
    `[entity-list-import-browser] checks=${checks.length} failed=${failed.length}`,
  );
  if (failed.length > 0) {
    throw new Error(`${failed.length} browser check(s) failed`);
  }
  console.log(
    '[entity-list-import-browser] PASSED: replace and merge previews show mode-specific labels and cancel without changing the active list.',
  );
}

main().catch((error) => {
  console.error(
    '[entity-list-import-browser] ERROR:',
    error && error.stack ? error.stack : error,
  );
  process.exit(1);
});