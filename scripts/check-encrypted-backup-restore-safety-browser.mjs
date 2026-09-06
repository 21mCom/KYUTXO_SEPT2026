#!/usr/bin/env node
// Focused real-browser proof that wrong passwords cannot mutate a live vault
// for either v3 or legacy encrypted backups, that damaged legacy ciphertext is
// equally non-destructive with the correct password, and that intact retries
// succeed. Everything runs offline against local IndexedDB.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETTINGS_URL = `${BASE_URL}settings`;
const SETUP_PASSWORD = 'backup-restore-safety-vault';
const V3_PASSWORD = 'backup-restore-safety-v3';
const LEGACY_PASSWORD = 'backup-restore-safety-legacy';
const TX_BACKED_UP = '31'.repeat(32);
const TX_STALE = 'ff'.repeat(32);
const PBKDF2_ITERATIONS = 100_000;

function chromiumPath() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No chromium binary found on PATH; install it or set CHROMIUM_BIN.');
  }
}

async function serverUp() {
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
    if (await serverUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Dev server did not become ready at ${BASE_URL}.`);
}

async function launchBrowser(executablePath) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

async function buildLegacyBackup(data, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  ));
  const encrypted = new Uint8Array(iv.length + ciphertext.length);
  encrypted.set(iv);
  encrypted.set(ciphertext, iv.length);
  const zip = new JSZip();
  zip.file('backup.json', JSON.stringify({
    encrypted: true,
    exportDate: new Date().toISOString(),
    salt: Buffer.from(salt).toString('base64'),
    data: Buffer.from(encrypted).toString('base64'),
  }));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function buildMalformedPlaintextBackup() {
  const zip = new JSZip();
  zip.file('backup.json', JSON.stringify({
    encrypted: false,
    exportDate: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    data: 'not-a-vault-payload',
  }));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function corruptLegacyCiphertext(backupBytes) {
  const zip = await JSZip.loadAsync(backupBytes);
  const backupFile = zip.file('backup.json');
  if (!backupFile) throw new Error('Legacy backup is missing backup.json');
  const backup = JSON.parse(await backupFile.async('text'));
  const encrypted = Buffer.from(backup.data, 'base64');
  if (encrypted.length <= 12) throw new Error('Legacy encrypted payload is too short');
  // Keep the IV and ZIP/JSON structure valid while making AES-GCM reject the
  // authenticated ciphertext even when the supplied password is correct.
  encrypted[12] ^= 0x01;
  backup.data = encrypted.toString('base64');
  zip.file('backup.json', JSON.stringify(backup));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const recordCrud = await import('/src/lib/data/record-crud.ts');
    const settingsCrud = await import('/src/lib/data/settings-crud.ts');
    const txCrud = await import('/src/lib/data/transaction-crud.ts');
    return {
      settings: await settingsCrud.getSettings('default'),
      records: await recordCrud.getAllRecords(),
      transactions: await txCrud.getAllTransactions(),
    };
  });
}

async function openRestore(page, name, buffer) {
  await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
  await unlockIfNeeded(page, SETUP_PASSWORD, {
    appearTimeoutMs: 30_000,
    label: 'encrypted-backup-restore-safety',
  });
  const open = page.getByTestId('button-open-restore');
  await open.scrollIntoViewIfNeeded();
  await open.click();
  await page.getByTestId('input-restore-file').setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer,
  });
  await page.getByText('Backup Date:', { exact: false }).waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  await page.getByTestId('radio-replace').click();
}

async function proveWrongThenCorrect(page, {
  backupName,
  backupBuffer,
  wrongPassword,
  correctPassword,
  beforeWrong,
  verifyCorrect,
  record,
  label,
  corruptBackupBuffer,
}) {
  await openRestore(page, backupName, backupBuffer);
  const password = page.getByTestId('input-restore-password');
  const continueButton = page.getByTestId('button-continue-restore');
  await password.fill(wrongPassword);
  await continueButton.click();
  await page.getByText('Could not read backup', { exact: true }).first().waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  const previewVisible = await page.getByTestId('restore-preferences-preview')
    .isVisible()
    .catch(() => false);
  const afterWrong = await snapshot(page);
  record(
    `${label}-wrong-password-non-destructive`,
    !previewVisible && JSON.stringify(afterWrong) === JSON.stringify(beforeWrong),
    `preview=${previewVisible} vaultUnchanged=${JSON.stringify(afterWrong) === JSON.stringify(beforeWrong)}`,
  );

  if (corruptBackupBuffer) {
    await page.getByTestId('input-restore-file').setInputFiles({
      name: `${label}-corrupt-ciphertext.zip`,
      mimeType: 'application/zip',
      buffer: corruptBackupBuffer,
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    await password.fill(correctPassword);
    await continueButton.click();
    await page.getByText('Could not read backup', { exact: true }).first().waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    const failureMessageVisible = await page
      .getByText('The password may be incorrect, or the backup is corrupted.', {
        exact: true,
      })
      .first()
      .isVisible()
      .catch(() => false);
    const corruptPreviewVisible = await page.getByTestId('restore-preferences-preview')
      .isVisible()
      .catch(() => false);
    const afterCorrupt = await snapshot(page);
    record(
      `${label}-corrupt-ciphertext-non-destructive`,
      failureMessageVisible &&
        !corruptPreviewVisible &&
        JSON.stringify(afterCorrupt) === JSON.stringify(beforeWrong),
      `failureMessage=${failureMessageVisible} preview=${corruptPreviewVisible} vaultUnchanged=${
        JSON.stringify(afterCorrupt) === JSON.stringify(beforeWrong)
      }`,
    );

    await page.getByTestId('input-restore-file').setInputFiles({
      name: backupName,
      mimeType: 'application/zip',
      buffer: backupBuffer,
    });
    await page.getByText('Backup Date:', { exact: false }).waitFor({
      state: 'visible',
      timeout: 20_000,
    });
  }

  await password.fill(correctPassword);
  await continueButton.click();
  await page.getByTestId('restore-preferences-preview').waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  await page.getByTestId('button-confirm-restore').click();
  await page.getByText('Restore Successful', { exact: false }).first().waitFor({
    state: 'visible',
    timeout: 120_000,
  });
  const restored = await snapshot(page);
  const verification = verifyCorrect(restored);
  record(`${label}-correct-password-retry`, verification.passed, verification.detail);
}

async function main() {
  let devProc;
  if (!(await serverUp())) {
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    await waitForServer();
  }

  const browser = await launchBrowser(chromiumPath());
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`[encrypted-backup-restore-safety] ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1600 },
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.log(`[encrypted-backup-restore-safety][page-console] ${message.text()}`);
      }
    });

    await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      dismissMigration: false,
      label: 'encrypted-backup-restore-safety',
    });
    if (await completeFreshVaultOnboardingIfPresent(page, {
      label: 'encrypted-backup-restore-safety',
    })) {
      await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
      await unlockIfNeeded(page, SETUP_PASSWORD, { appearTimeoutMs: 30_000 });
    }

    await page.evaluate(async (txid) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      await settingsCrud.updateSettings('default', {
        disableOrphanCheck: true,
      }, { skipNotification: true });
      await txCrud.bulkAddTransactions([{
        txid,
        blockHeight: 800_001,
        blockTime: 1_700_000_000,
        fee: 321,
        feeRate: 2,
        syncedAt: Date.now(),
        curationState: 'new',
      }]);
    }, TX_BACKED_UP);

    const beforeMalformed = await snapshot(page);
    await page.getByTestId('button-open-restore').click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'malformed-legacy-backup.zip',
      mimeType: 'application/zip',
      buffer: await buildMalformedPlaintextBackup(),
    });
    await page.getByTestId('button-continue-restore').click();
    await page.getByText('Malformed backup data').first().waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    const afterMalformed = await snapshot(page);
    const malformedConfirmVisible = await page.getByTestId('button-confirm-restore')
      .isVisible()
      .catch(() => false);
    record(
      'malformed-plaintext-non-destructive',
      !malformedConfirmVisible &&
        JSON.stringify(afterMalformed) === JSON.stringify(beforeMalformed),
      `confirm=${malformedConfirmVisible} vaultUnchanged=${
        JSON.stringify(afterMalformed) === JSON.stringify(beforeMalformed)
      }`,
    );

    const v3B64 = await page.evaluate(async (password) => {
      const { exportBackup } = await import('/src/lib/backup/export.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');
      const sink = new MemorySink();
      await exportBackup({
        sink,
        encrypted: true,
        password,
        batchSize: 25,
        attachmentIO: { async listAll() { return []; }, async read() { return null; } },
      });
      const bytes = new Uint8Array(await sink.blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, V3_PASSWORD);

    await page.evaluate(async (staleTxid) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      await settingsCrud.updateSettings('default', {
        disableOrphanCheck: false,
      }, { skipNotification: true });
      await txCrud.clearTransactions({ skipNotification: true });
      await txCrud.bulkAddTransactions([{
        txid: staleTxid,
        blockHeight: 999_999,
        blockTime: 1_700_000_001,
        fee: 1,
        feeRate: 1,
        syncedAt: Date.now(),
        curationState: 'ignored',
      }]);
    }, TX_STALE);
    const beforeV3Wrong = await snapshot(page);

    await proveWrongThenCorrect(page, {
      backupName: 'encrypted-v3-safety.zip',
      backupBuffer: Buffer.from(v3B64, 'base64'),
      wrongPassword: `${V3_PASSWORD}-wrong`,
      correctPassword: V3_PASSWORD,
      beforeWrong: beforeV3Wrong,
      record,
      label: 'v3',
      verifyCorrect: ({ settings, transactions }) => ({
        passed: settings?.disableOrphanCheck === true &&
          transactions.length === 1 &&
          transactions[0]?.txid === TX_BACKED_UP,
        detail: `disableOrphanCheck=${settings?.disableOrphanCheck} txids=${transactions.map((tx) => tx.txid).join(',')}`,
      }),
    });

    const legacyData = await page.evaluate(async () => {
      const recordCrud = await import('/src/lib/data/record-crud.ts');
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      const settings = await settingsCrud.getSettings('default');
      return {
        records: await recordCrud.getAllRecords(), tags: [], categories: [], attachments: [],
        recordOrigins: [], customFields: [], owners: [], walletNames: [], seedNames: [],
        walletSoftware: [], derivationTemplates: [], evidence: [], evidenceAttachments: [],
        priceData: [], settings: settings ? [settings] : [], nodeSettings: [], utxoLineage: [],
        custodySegments: [], lineageSnapshots: [],
        blockchainTransactions: await txCrud.getAllTransactions(),
        transactionParticipants: await txCrud.getAllTransactionParticipants(),
        addressSyncState: [], dustFlags: [],
      };
    });
    const legacyBackup = await buildLegacyBackup(legacyData, LEGACY_PASSWORD);
    const corruptLegacyBackup = await corruptLegacyCiphertext(legacyBackup);

    await page.evaluate(async (staleTxid) => {
      const settingsCrud = await import('/src/lib/data/settings-crud.ts');
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      await settingsCrud.updateSettings('default', {
        disableOrphanCheck: false,
      }, { skipNotification: true });
      await txCrud.clearTransactions({ skipNotification: true });
      await txCrud.bulkAddTransactions([{
        txid: staleTxid,
        blockHeight: 999_998,
        blockTime: 1_700_000_002,
        fee: 2,
        feeRate: 1,
        syncedAt: Date.now(),
        curationState: 'ignored',
      }]);
    }, TX_STALE);
    const beforeLegacyWrong = await snapshot(page);

    await proveWrongThenCorrect(page, {
      backupName: 'encrypted-legacy-safety.zip',
      backupBuffer: legacyBackup,
      wrongPassword: `${LEGACY_PASSWORD}-wrong`,
      correctPassword: LEGACY_PASSWORD,
      beforeWrong: beforeLegacyWrong,
      record,
      label: 'legacy',
      corruptBackupBuffer: corruptLegacyBackup,
      verifyCorrect: ({ settings, transactions }) => ({
        passed: settings?.disableOrphanCheck === true &&
          transactions.length === 1 &&
          transactions[0]?.txid === TX_BACKED_UP,
        detail: `disableOrphanCheck=${settings?.disableOrphanCheck} txids=${transactions.map((tx) => tx.txid).join(',')}`,
      }),
    });

    await context.close();
  } finally {
    await browser.close();
    if (devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        devProc.kill('SIGTERM');
      }
    }
  }

  const failed = steps.filter((step) => !step.passed);
  console.log(`\n[encrypted-backup-restore-safety] ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    throw new Error(`Failed steps: ${failed.map((step) => step.name).join(', ')}`);
  }
  console.log('[encrypted-backup-restore-safety] PASSED: wrong-password and corrupt-ciphertext restores are non-destructive and intact retries succeed.');
}

main().catch((error) => {
  console.error('[encrypted-backup-restore-safety] fatal:', error?.stack ?? error);
  process.exit(1);
});