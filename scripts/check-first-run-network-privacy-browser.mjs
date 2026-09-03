#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import { unlockIfNeeded } from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'network-privacy-check-123';
const ADDRESS = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

function chromiumPath() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return execSync('which chromium', { encoding: 'utf8' }).trim();
}

async function serverUp() {
  try {
    return (await fetch(BASE_URL)).status < 500;
  } catch {
    return false;
  }
}

let dev;
if (!(await serverUp())) {
  dev = spawn('npm', ['run', 'dev'], { stdio: 'inherit', detached: true, env: process.env });
  const deadline = Date.now() + 90_000;
  while (!(await serverUp()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  if (!(await serverUp())) throw new Error('dev server did not start');
}

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const externalRequests = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE_URL) || url.startsWith('data:')) return route.continue();
    externalRequests.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, label: 'network-privacy' });

  await page.getByTestId('network-onboarding-source').waitFor({ state: 'visible' });
  if (externalRequests.length) throw new Error(`fresh onboarding contacted: ${externalRequests.join(', ')}`);

  // A lock/reload resumes the undecided first-run state instead of falling
  // through to the configured public default.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { label: 'network-privacy-resume' });
  await page.getByTestId('network-onboarding-source').waitFor({ state: 'visible' });

  await page.getByTestId('choice-network-public-direct').click();
  await page.getByTestId('button-save-network-choice').click();
  await page.getByTestId('network-onboarding-import').waitFor({ state: 'visible' });
  await page.getByTestId('button-onboarding-finish').click();
  await page.getByTestId('text-network-privacy-state').waitFor({ state: 'visible' });
  if ((await page.getByTestId('text-network-privacy-state').textContent()) !== 'Direct public') {
    throw new Error('header did not show Direct public');
  }

  // One click goes offline without erasing the selected provider; the state
  // survives lock/reload.
  await page.getByTestId('button-network-privacy').click();
  await page.getByTestId('text-network-privacy-state').getByText('Offline').waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { label: 'network-privacy-offline' });
  await page.getByTestId('text-network-privacy-state').getByText('Offline').waitFor();
  await page.getByTestId('button-network-privacy').click();

  await page.evaluate(async (address) => {
    const records = await import('/src/lib/data/record-crud.ts');
    await records.createRecord({
      type: 'address',
      inputString: address,
      label: 'First sync disclosure',
      tags: [],
      categories: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      addressImportance: 'manual',
    });
  }, ADDRESS);
  await page.goto(`${BASE_URL}transaction-sync`, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { label: 'network-privacy-first-sync' });
  const start = page.getByTestId('button-sync');
  await start.waitFor({ state: 'visible' });
  await start.click();
  const dialog = page.getByTestId('dialog-first-sync-disclosure');
  await dialog.waitFor({ state: 'visible' });
  const disclosure = await dialog.textContent();
  if (!disclosure?.includes('1 address') || !disclosure.includes('mempool.space directly')) {
    throw new Error(`first-sync disclosure was not provider/count exact: ${disclosure}`);
  }
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Simulate an older configured vault: absent onboarding fields must not
  // force the new wizard or silently change its provider behavior.
  await page.evaluate(async () => {
    const crud = await import('/src/lib/data/node-settings-crud.ts');
    await crud.updateNodeSettings('default', {
      networkPrivacyMode: undefined,
      networkOnboardingStage: undefined,
      networkAccessEnabled: undefined,
      firstSyncConfirmedAt: undefined,
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { label: 'network-privacy-existing' });
  await page.getByTestId('text-network-privacy-state').getByText('Direct public').waitFor();
  if (await page.getByTestId('network-onboarding-source').isVisible()) {
    throw new Error('legacy existing vault was forced through onboarding');
  }
  console.log('PASS: fresh, resumed, offline, first-sync, and existing-vault network privacy journeys');
} finally {
  await browser.close();
  if (dev?.pid) {
    try { process.kill(-dev.pid, 'SIGTERM'); } catch {}
  }
}