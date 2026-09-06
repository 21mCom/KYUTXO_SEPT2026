#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const baseUrl = 'http://127.0.0.1:5000';
const password = 'report-triggered-sync-check';
const ownedAddress = 'bc1qreporttargetedbrowsercheck00000000000000aa';
const missingFundingTxid = 'a1'.repeat(32);
const spendingTxid = 'b2'.repeat(32);

function chromiumPath() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  return execSync('which chromium', { encoding: 'utf8' }).trim();
}

async function isReady() {
  try {
    return (await fetch(baseUrl)).ok;
  } catch {
    return false;
  }
}

let server;
if (!(await isReady())) {
  server = spawn('npm', ['run', 'dev'], { stdio: 'inherit', env: process.env });
  for (let attempt = 0; attempt < 120 && !(await isReady()); attempt++) await delay(500);
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
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`[browser ${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => console.error(`[browser pageerror] ${error.stack ?? error.message}`));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, password, {
    appearTimeoutMs: 60_000,
    label: 'report-triggered-sync',
  });
  await completeFreshVaultOnboardingIfPresent(page, { label: 'report-triggered-sync' });

  await page.evaluate(async ({ ownedAddress, missingFundingTxid, spendingTxid }) => {
    const records = await import('/src/lib/data/record-crud.ts');
    const transactions = await import('/src/lib/data/transaction-crud.ts');
    const settings = await import('/src/lib/data/node-settings-crud.ts');

    await records.clearAllRecords({ skipNotification: true });
    await transactions.clearTransactions({ skipNotification: true });
    await transactions.clearParticipants({ skipNotification: true });
    await records.createRecord(
      {
        type: 'address',
        inputString: ownedAddress,
        label: 'Report targeted sync owner',
        tags: [],
        categories: [],
        addressImportance: 'manual',
      },
      { skipNotification: true, skipVocabularySync: true },
    );
    await transactions.addTransaction(
      {
        txid: spendingTxid,
        blockHeight: 800000,
        blockTime: Math.floor(Date.UTC(2023, 6, 1) / 1000),
        fee: 1000,
        feeRate: 5,
        syncedAt: Date.now(),
      },
      { skipNotification: true },
    );
    await transactions.addParticipant(
      {
        txid: spendingTxid,
        role: 'input',
        address: ownedAddress,
        amount: 0,
        prevTxid: missingFundingTxid,
        prevVout: 0,
      },
      { skipNotification: true },
    );
    await settings.updateNodeSettings('default', {
      providerType: 'blockstream',
      useTor: false,
      useElectrum: false,
      networkPrivacyMode: 'public-direct',
      networkPrivacyChosenAt: Date.now(),
      networkAccessEnabled: false,
      networkOnboardingStage: 'complete',
      firstSyncConfirmedAt: undefined,
    });
  }, { ownedAddress, missingFundingTxid, spendingTxid });

  await page.goto(`${baseUrl}/annual-activity`, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, password, { label: 'report-triggered-sync-report' });

  const addressInput = page.getByTestId('input-annual-activity-addresses');
  await addressInput.fill(ownedAddress);
  await addressInput.press('Enter');
  await page.getByTestId('button-generate').click();
  await page.getByTestId('warning-unresolved-input-amounts').waitFor({ state: 'visible' });
  await page.getByTestId('button-toggle-unresolved-details').click();

  await page.evaluate(async () => {
    const { transactionSyncService } = await import('/src/lib/transaction-sync.ts');
    const original = transactionSyncService.updateProvider.bind(transactionSyncService);
    window.__reportTargetedProviderAttempts = 0;
    transactionSyncService.updateProvider = (...args) => {
      window.__reportTargetedProviderAttempts += 1;
      return original(...args);
    };
  });

  await page.getByTestId('button-sync-unresolved').click();
  await page.waitForURL('**/transaction-sync');
  await page.getByTestId('text-page-title').waitFor({ state: 'visible' });

  const disclosure = page.getByTestId('dialog-first-sync-disclosure');
  await disclosure.waitFor({ state: 'visible' }).catch(async (error) => {
    const diagnostics = await page.evaluate(async () => {
      const settings = await import('/src/lib/data/node-settings-crud.ts');
      return {
        nodeSettings: await settings.getNodeSettings('default'),
        providerAttempts: window.__reportTargetedProviderAttempts,
        bodyText: document.body.innerText,
      };
    });
    throw new Error(`First-sync disclosure did not appear after report navigation: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  });
  const disclosureText = await disclosure.innerText();
  if (!disclosureText.includes('1 address') || !disclosureText.includes('blockstream.info directly')) {
    throw new Error(`Report handoff showed the wrong first-sync disclosure: ${disclosureText}`);
  }
  if (await page.getByTestId('action-open-node-settings').isVisible()) {
    throw new Error('Targeted sync contacted the provider before first-sync approval');
  }

  await page.getByTestId('button-confirm-first-sync').click();
  const settingsAction = page.getByTestId('action-open-node-settings');
  await settingsAction.waitFor({ state: 'visible' });
  const toastText = await settingsAction.locator('..').innerText();
  if (!toastText.includes('Network access is offline')) {
    throw new Error(`Blocked targeted sync showed the wrong recovery message: ${toastText}`);
  }

  const attempts = await page.evaluate(() => window.__reportTargetedProviderAttempts);
  if (attempts !== 1) {
    throw new Error(`Approval started ${attempts} targeted provider attempts instead of exactly one`);
  }

  await settingsAction.click();
  await page.waitForURL('**/node-settings');
  console.log('Report-triggered targeted sync navigation browser check passed');
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}