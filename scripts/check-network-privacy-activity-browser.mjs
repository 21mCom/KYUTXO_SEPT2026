import { execSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const baseUrl = 'http://127.0.0.1:5000';
const password = 'network-privacy-activity-check';

function chromiumPath() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return execSync('which chromium', { encoding: 'utf8' }).trim();
}

async function isReady() {
  try {
    const response = await fetch(baseUrl);
    return response.ok;
  } catch {
    return false;
  }
}

let server;
if (!(await isReady())) {
  server = spawn('npm', ['run', 'dev'], {
    stdio: 'inherit',
    env: process.env,
  });
  for (let attempt = 0; attempt < 60 && !(await isReady()); attempt++) {
    await delay(500);
  }
}

if (!(await isReady())) {
  server?.kill('SIGTERM');
  throw new Error(`App did not become ready at ${baseUrl}`);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumPath(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, password, {
    appearTimeoutMs: 60_000,
    label: 'network-privacy-activity',
  });

  await page.evaluate(async () => {
    const { db } = await import('/src/lib/database.ts');
    await db.open();
    await db.networkPrivacyActivity.clear();
    await db.nodeSettings.put({
      id: 'default',
      providerType: 'mempool-space',
      useTor: true,
      requestTimeout: 30000,
      network: 'mainnet',
      allowLocalNetwork: false,
      trustedLocalHosts: [],
      networkPrivacyMode: 'public-tor',
      networkAccessEnabled: true,
      networkOnboardingStage: 'complete',
      firstSyncConfirmedAt: Date.now(),
    });
    await db.networkPrivacyActivity.bulkAdd([
      {
        timestamp: Date.now() - 1000,
        providerClass: 'public-tor',
        action: 'address-check',
        addressCount: 2,
      },
      {
        timestamp: Date.now(),
        providerClass: 'public-direct',
        action: 'provider-test',
      },
    ]);
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, password, { label: 'network-privacy-activity-reload' });

  await page.getByTestId('button-network-privacy-activity').click();
  await page.getByTestId('network-privacy-activity-dialog').waitFor();

  const dialogText = await page.getByTestId('network-privacy-activity-dialog').innerText();
  for (const expected of [
    'Local network activity',
    'Provider test',
    'Address check',
    'Public API through Tor',
    'Direct public API',
    '2',
    'not included in backups',
  ]) {
    if (!dialogText.includes(expected)) {
      throw new Error(`Activity dialog is missing ${JSON.stringify(expected)}`);
    }
  }

  const before = await page.evaluate(async () => {
    const { db } = await import('/src/lib/database.ts');
    return db.nodeSettings.get('default');
  });
  await page.getByTestId('button-clear-network-privacy-activity').click();
  await page.getByTestId('network-privacy-activity-empty').waitFor();
  const after = await page.evaluate(async () => {
    const { db } = await import('/src/lib/database.ts');
    return {
      count: await db.networkPrivacyActivity.count(),
      settings: await db.nodeSettings.get('default'),
    };
  });

  if (after.count !== 0) throw new Error('Clear activity did not empty the local log');
  if (JSON.stringify(after.settings) !== JSON.stringify(before)) {
    throw new Error('Clear activity changed provider settings');
  }

  console.log('Network privacy activity browser check passed');
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}