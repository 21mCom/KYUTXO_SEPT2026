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
      firstSyncConfirmedAt: 1,
    });
  }, { ownedAddress, missingFundingTxid, spendingTxid });

  await page.goto(`${baseUrl}/transaction-sync`, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, password, { label: 'normal-sync-recovery' });
  await page.getByTestId('text-page-title').waitFor({ state: 'visible' });

  const settingsBefore = await page.evaluate(async () => {
    const { transactionSyncService } = await import('/src/lib/transaction-sync.ts');
    const { NETWORK_BLOCKED_MESSAGE } = await import('/src/lib/network-privacy.ts');
    const settings = await import('/src/lib/data/node-settings-crud.ts');
    window.__offlineRecoverySyncCalls = [];
    transactionSyncService.updateProvider = () => undefined;
    transactionSyncService.syncWithDepth = async (options) => {
      window.__offlineRecoverySyncCalls.push(options);
      return {
        success: false,
        addressesSynced: 0,
        transactionsImported: 0,
        transactionsUpdated: 0,
        newlyQueuedTransactions: 0,
        newAddressRecords: 0,
        addressesSkipped: 0,
        addressesFiltered: 0,
        transactionsAlreadySynced: 0,
        depthsProcessed: [],
        errors: [NETWORK_BLOCKED_MESSAGE],
      };
    };
    return JSON.stringify(await settings.getNodeSettings('default'));
  });

  const normalSyncButton = page.getByTestId('button-sync');
  await normalSyncButton.waitFor({ state: 'visible' });
  await normalSyncButton.click();
  let settingsAction = page.getByTestId('action-open-node-settings');
  await settingsAction.waitFor({ state: 'visible' });
  let toastText = await settingsAction.locator('..').innerText();
  if (!toastText.includes('Network access is offline')) {
    throw new Error(`Blocked normal sync showed the wrong recovery message: ${toastText}`);
  }
  const normalCalls = await page.evaluate(() => window.__offlineRecoverySyncCalls);
  if (normalCalls.length !== 1 || normalCalls[0]?.sourceFilter !== 'custom') {
    throw new Error(`Normal sync did not reach the full-sync runner exactly once: ${JSON.stringify(normalCalls)}`);
  }
  await settingsAction.click();
  await page.waitForURL('**/node-settings');
  const normalSettingsState = await page.evaluate(async () => {
    const settings = await import('/src/lib/data/node-settings-crud.ts');
    return JSON.stringify(await settings.getNodeSettings('default'));
  });
  if (normalSettingsState !== settingsBefore) {
    throw new Error(`Normal sync recovery changed provider or network settings: ${JSON.stringify({ settingsBefore, normalSettingsState })}`);
  }

  await page.goto(`${baseUrl}/annual-activity`, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, password, { label: 'report-triggered-sync-report' });
  await page.evaluate(async () => {
    const { transactionSyncService } = await import('/src/lib/transaction-sync.ts');
    const { NETWORK_BLOCKED_MESSAGE } = await import('/src/lib/network-privacy.ts');
    window.__offlineRecoverySyncCalls = [];
    transactionSyncService.updateProvider = () => undefined;
    transactionSyncService.syncWithDepth = async (options) => {
      window.__offlineRecoverySyncCalls.push(options);
      return {
        success: false,
        addressesSynced: 0,
        transactionsImported: 0,
        transactionsUpdated: 0,
        newlyQueuedTransactions: 0,
        newAddressRecords: 0,
        addressesSkipped: 0,
        addressesFiltered: 0,
        transactionsAlreadySynced: 0,
        depthsProcessed: [],
        errors: [NETWORK_BLOCKED_MESSAGE],
      };
    };
  });

  const addressInput = page.getByTestId('input-annual-activity-addresses');
  await addressInput.fill(ownedAddress);
  await addressInput.press('Enter');
  await page.getByTestId('button-generate').click();
  await page.getByTestId('warning-unresolved-input-amounts').waitFor({ state: 'visible' });
  await page.getByTestId('button-toggle-unresolved-details').click();

  await page.getByTestId('button-sync-unresolved').click();
  await page.waitForURL('**/transaction-sync');
  await page.getByTestId('text-page-title').waitFor({ state: 'visible' });

  settingsAction = page.getByTestId('action-open-node-settings');
  await settingsAction.waitFor({ state: 'visible' });
  toastText = await settingsAction.locator('..').innerText();
  if (!toastText.includes('Network access is offline')) {
    throw new Error(`Blocked targeted sync showed the wrong recovery message: ${toastText}`);
  }

  const targetedCalls = await page.evaluate(() => window.__offlineRecoverySyncCalls);
  if (
    targetedCalls.length !== 1
    || targetedCalls[0]?.sourceFilter !== 'all'
    || targetedCalls[0]?.maxDepth !== 1
    || targetedCalls[0]?.specificRecordIds?.length !== 1
  ) {
    throw new Error(`Report-targeted sync did not reach the full-sync runner exactly once: ${JSON.stringify(targetedCalls)}`);
  }

  await settingsAction.click();
  await page.waitForURL('**/node-settings');
  const targetedSettingsState = await page.evaluate(async () => {
    const settings = await import('/src/lib/data/node-settings-crud.ts');
    return JSON.stringify(await settings.getNodeSettings('default'));
  });
  if (targetedSettingsState !== settingsBefore) {
    throw new Error(`Report-targeted sync recovery changed provider or network settings: ${JSON.stringify({ settingsBefore, targetedSettingsState })}`);
  }
  console.log('Normal and report-triggered offline sync recovery browser check passed');
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}