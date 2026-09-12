#!/usr/bin/env node
// Focused real-browser proof that wrong passwords cannot mutate a live vault
// for either v3 or legacy encrypted backups, that damaged legacy ciphertext is
// equally non-destructive with the correct password, and that intact retries
// succeed. Everything runs offline against local IndexedDB.

import { chromium } from 'playwright-core';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';
import {
  assertPackagedAsarFresh,
  assertPackagedBundleFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import { findPackagedBinaries } from './packaged-electron-binaries.mjs';
import {
  STABLE_BACKUP_FIXTURE_NAME,
  STABLE_BACKUP_PASSWORD,
  readVerifiedStableBackupFixture,
} from './stable-backup-fixture.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const PACKAGED = process.env.KYUTXO_PACKAGED_RESTORE_SAFETY === '1';
const ROOT = repoRootFromModuleUrl(import.meta.url);
const ASAR = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');
const CDP_PORT = Number(process.env.KYUTXO_PACKAGED_RESTORE_CDP_PORT || 9233);
const BASE_URL = `http://localhost:${PORT}/`;
const SETTINGS_URL = PACKAGED ? 'kyutxo-app://bundle/#/settings' : `${BASE_URL}settings`;
const SETUP_PASSWORD = PACKAGED
  ? 'PackagedRestoreSafety#2026'
  : 'backup-restore-safety-vault';
const V3_PASSWORD = 'backup-restore-safety-v3';
const LEGACY_PASSWORD = 'backup-restore-safety-legacy';
const TX_BACKED_UP = '31'.repeat(32);
const TX_STALE = 'ff'.repeat(32);
const PBKDF2_ITERATIONS = 100_000;
const ATTACHMENT_PATH = 'restore-safety/original.bin';
const ATTACHMENT_BYTES = new TextEncoder().encode('packaged restore safety attachment');
const TAG = PACKAGED ? '[packaged-encrypted-backup-restore-safety]' : '[encrypted-backup-restore-safety]';

function run(command, args) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  if (spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
    throw new Error(`${TAG} command failed: ${command}`);
  }
}

function buildPackage() {
  if (!PACKAGED) return;
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) throw new Error(`${TAG} skip-build requested but ${ASAR} is missing`);
    assertPackagedBundleFresh({ root: ROOT, tag: TAG });
    assertPackagedAsarFresh({ root: ROOT, asarPath: ASAR, tag: TAG });
    return;
  }
  run('npm', ['run', 'build']);
  assertPackagedBundleFresh({ root: ROOT, tag: TAG });
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', ['electron-builder', '--config', 'electron-builder.json', '--dir', '--linux', '-c.npmRebuild=false']);
  if (!fs.existsSync(ASAR)) throw new Error(`${TAG} packaging produced no app.asar`);
}

async function waitForCdp(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${TAG} packaged Electron CDP endpoint did not start`);
}

async function cdpIsUp() {
  try {
    return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function packagedPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('kyutxo-app://bundle/'));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${TAG} packaged renderer did not appear`);
}

function killTree(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
}

async function stopChild(child) {
  if (!child?.pid) return;
  killTree(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

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

async function corruptV3Ciphertext(backupBytes) {
  const zip = await JSZip.loadAsync(backupBytes);
  const backupFile = zip.file('backup.json');
  if (!backupFile) throw new Error('V3 backup is missing backup.json');
  const manifest = JSON.parse(await backupFile.async('text'));
  const encrypted = Buffer.from(manifest.inlineEnc ?? '', 'base64');
  if (encrypted.length <= 12) throw new Error('V3 encrypted inline payload is too short');
  // Preserve the valid ZIP, manifest, salt, and password-check sentinel. The
  // correct password therefore passes the early check, then AES-GCM rejects
  // the independently authenticated inline payload before destructive clear.
  encrypted[12] ^= 0x01;
  manifest.inlineEnc = encrypted.toString('base64');
  zip.file('backup.json', JSON.stringify(manifest));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function snapshot(page) {
  return page.evaluate(async (packaged) => {
    const { db } = await import('/src/lib/database.ts');
    const { STREAMED_TABLES } = await import('/src/lib/backup/format.ts');
    const { readInlineTables } = await import('/src/lib/backup/inline-tables.ts');
    const inlineTables = await readInlineTables();
    const portableTables = {};
    for (const tableName of STREAMED_TABLES) {
      portableTables[tableName] = await db.table(tableName).toArray();
    }
    for (const [tableName, rows] of Object.entries(inlineTables)) {
      portableTables[tableName] = rows;
    }

    let attachmentPaths;
    if (packaged) {
      const result = await window.electronAPI.listAllAttachments();
      if (!result.success) throw new Error(result.error || 'Could not list desktop attachments');
      attachmentPaths = (result.files ?? []).sort();
    } else {
      const listResponse = await fetch('/api/attachments/list-all');
      if (!listResponse.ok) {
        throw new Error(`Could not snapshot attachment files: ${listResponse.status}`);
      }
      attachmentPaths = ((await listResponse.json()).files ?? []).sort();
    }
    const attachmentFiles = [];
    for (const relativePath of attachmentPaths) {
      let bytes;
      if (packaged) {
        const result = await window.electronAPI.readAttachment(relativePath);
        if (!result.success || !result.data) {
          throw new Error(result.error || `Could not read desktop attachment ${relativePath}`);
        }
        bytes = result.data;
      } else {
        const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
        const response = await fetch(`/api/attachments/download/${encodedPath}`);
        if (!response.ok) {
          throw new Error(`Could not snapshot attachment ${relativePath}: ${response.status}`);
        }
        bytes = await response.arrayBuffer();
      }
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')).join('');
      attachmentFiles.push({ relativePath, sha256 });
    }

    return {
      portableTables,
      attachmentFiles,
    };
  }, PACKAGED);
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
  verifyReopen,
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
  if (verifyReopen) {
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await unlockIfNeeded(page, SETUP_PASSWORD, {
      appearTimeoutMs: 30_000,
      label: `${label}-reopen`,
    });
    const reopened = await snapshot(page);
    const reopenVerification = verifyReopen(reopened, restored);
    record(`${label}-reopen`, reopenVerification.passed, reopenVerification.detail);
  }
}

async function main() {
  buildPackage();
  const stableBackup = readVerifiedStableBackupFixture();
  let devProc;
  let appProc;
  let xvfb;
  let tempHome;
  let browser;
  let context;
  let page;
  const steps = [];
  const record = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    console.log(`${TAG} ${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    if (!PACKAGED && !(await serverUp())) {
      devProc = spawn('npm', ['run', 'dev'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
        detached: true,
      });
      await waitForServer();
    }

    if (PACKAGED) {
      if (await cdpIsUp()) {
        throw new Error(`${TAG} CDP port ${CDP_PORT} is already in use; refusing to attach to an unrelated process`);
      }
      const { electronBin, xvfbBin } = findPackagedBinaries({ tag: TAG });
      tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-packaged-restore-safety-'));
      const display = process.env.KYUTXO_PACKAGED_DISPLAY || ':104';
      const env = {
        ...process.env,
        HOME: tempHome,
        XDG_CONFIG_HOME: path.join(tempHome, '.config'),
        XDG_CACHE_HOME: path.join(tempHome, '.cache'),
        XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
        XDG_STATE_HOME: path.join(tempHome, '.local', 'state'),
        NODE_ENV: 'production',
        DISPLAY: display,
      };
      xvfb = spawn(xvfbBin, [display, '-screen', '0', '1440x1600x24'], {
        env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      appProc = spawn(electronBin, [
        ASAR, '--no-sandbox', '--disable-gpu', '--in-process-gpu',
        '--disable-gpu-compositing', '--disable-software-rasterizer',
        `--remote-debugging-port=${CDP_PORT}`,
      ], { cwd: tempHome, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      appProc.stdout.on('data', (chunk) => process.stdout.write(`${TAG}[app] ${chunk}`));
      appProc.stderr.on('data', (chunk) => process.stdout.write(`${TAG}[app-err] ${chunk}`));
      await waitForCdp();
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      page = await packagedPage(browser);
    } else {
      browser = await launchBrowser(chromiumPath());
      context = await browser.newContext({
        serviceWorkers: 'block',
        viewport: { width: 1440, height: 1600 },
      });
      page = await context.newPage();
    }
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.log(`[encrypted-backup-restore-safety][page-console] ${message.text()}`);
      }
    });

    if (PACKAGED) {
      await page.waitForFunction(
        () => document.readyState === 'interactive' || document.readyState === 'complete',
        null,
        { timeout: 60_000 },
      );
      await page.locator('body').waitFor({ state: 'visible', timeout: 60_000 });
    } else {
      await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
    }
    if (PACKAGED && await page.getByTestId('input-confirm-password').isVisible().catch(() => false)) {
      const created = await page.evaluate(async (password) => {
        return window.electronAPI.protectedStore.create(password);
      }, SETUP_PASSWORD);
      if (!created.ok || created.result?.unlocked !== true || created.result?.verified !== true) {
        throw new Error(created.error || 'Could not create packaged protected vault');
      }
      await page.reload({ waitUntil: 'load', timeout: 60_000 });
    }
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
    if (PACKAGED) {
      await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
    }

    if (PACKAGED) {
      const seeded = await page.evaluate(async ({ relativePath, bytes }) => {
        return window.electronAPI.writeAttachment(relativePath, new Uint8Array(bytes).buffer);
      }, { relativePath: ATTACHMENT_PATH, bytes: Array.from(ATTACHMENT_BYTES) });
      if (!seeded.success) throw new Error(seeded.error || 'Could not seed desktop attachment');
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
    record(
      'stable-release-fixture-checksum',
      stableBackup.provenance.sourceTag === 'v1.1.24',
      `sha256=${stableBackup.digest} source=${stableBackup.provenance.sourceRevision}`,
    );
    await page.getByTestId('button-open-restore').click();
    await page.getByTestId('input-restore-file').setInputFiles({
      name: 'malformed-legacy-backup.zip',
      mimeType: 'application/zip',
      buffer: await buildMalformedPlaintextBackup(),
    });
    // Newer restore previews reject malformed plaintext envelopes during file
    // classification; older ones did so after Continue. Accept either point,
    // while still requiring the same visible failure and no vault mutation.
    const malformedContinue = page.getByTestId('button-continue-restore');
    await page.waitForTimeout(500);
    const malformedRejectedDuringSelection =
      !(await malformedContinue.isEnabled().catch(() => false));
    if (!malformedRejectedDuringSelection) {
      await malformedContinue.click();
      await page.getByText(/Malformed backup data|Could not read backup/).first().waitFor({
        state: 'visible',
        timeout: 20_000,
      });
    }
    const afterMalformed = await snapshot(page);
    const malformedConfirmVisible = await page.getByTestId('button-confirm-restore')
      .isVisible()
      .catch(() => false);
    record(
      'malformed-plaintext-non-destructive',
      !malformedConfirmVisible &&
        JSON.stringify(afterMalformed) === JSON.stringify(beforeMalformed),
      `rejectedDuringSelection=${malformedRejectedDuringSelection} confirm=${malformedConfirmVisible} vaultUnchanged=${
        JSON.stringify(afterMalformed) === JSON.stringify(beforeMalformed)
      }`,
    );

    const v3B64 = await page.evaluate(async ({ password, packaged }) => {
      const { exportBackup } = await import('/src/lib/backup/export.ts');
      const { MemorySink } = await import('/src/lib/backup/sink.ts');
      const sink = new MemorySink();
      const attachmentIO = packaged ? {
        async listAll() {
          const result = await window.electronAPI.listAllAttachments();
          if (!result.success) throw new Error(result.error || 'Could not list attachments');
          return result.files ?? [];
        },
        async read(relativePath) {
          const result = await window.electronAPI.readAttachment(relativePath);
          if (!result.success) throw new Error(result.error || `Could not read ${relativePath}`);
          return result.data ?? null;
        },
      } : { async listAll() { return []; }, async read() { return null; } };
      await exportBackup({
        sink,
        encrypted: true,
        password,
        batchSize: 25,
        attachmentIO,
      });
      const bytes = new Uint8Array(await sink.blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, { password: V3_PASSWORD, packaged: PACKAGED });
    const corruptV3Backup = await corruptV3Ciphertext(Buffer.from(v3B64, 'base64'));

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
      corruptBackupBuffer: corruptV3Backup,
       verifyCorrect: ({ portableTables, attachmentFiles }) => {
        const settings = portableTables.settings?.find((row) => row.id === 'default');
        const transactions = portableTables.blockchainTransactions ?? [];
         const packagedAttachmentRestored = !PACKAGED ||
           JSON.stringify(attachmentFiles) === JSON.stringify(beforeMalformed.attachmentFiles);
        return {
           passed: settings?.disableOrphanCheck === true &&
            transactions.length === 1 &&
             transactions[0]?.txid === TX_BACKED_UP &&
             packagedAttachmentRestored,
           detail: `disableOrphanCheck=${settings?.disableOrphanCheck} txids=${transactions.map((tx) => tx.txid).join(',')} attachments=${attachmentFiles.map((file) => file.relativePath).join(',')}`,
        };
      },
    });

    await page.evaluate(async (staleTxid) => {
      const txCrud = await import('/src/lib/data/transaction-crud.ts');
      await txCrud.clearTransactions({ skipNotification: true });
      await txCrud.bulkAddTransactions([{
        txid: staleTxid,
        blockHeight: 999_997,
        blockTime: 1_700_000_003,
        syncedAt: Date.now(),
        curationState: 'ignored',
      }]);
    }, TX_STALE);
    const beforeStableWrong = await snapshot(page);
    const verifyStableFixture = ({ portableTables }) => {
      const records = portableTables.records ?? [];
      const transactions = portableTables.blockchainTransactions ?? [];
      const settings = portableTables.settings?.find((row) => row.id === 'default');
      const recordRow = records[0];
      const passed =
        records.length === 1 &&
        recordRow?.inputString === 'bc1qstablefixture0000000000000000000000000' &&
        recordRow?.label === 'Sanitized stable release fixture' &&
        recordRow?.notes === 'No user data' &&
        JSON.stringify(recordRow?.tags) === JSON.stringify(['golden']) &&
        transactions.length === 1 &&
        transactions[0]?.txid === '245'.padStart(64, '0') &&
        !transactions.some((row) => row.txid === TX_STALE) &&
        settings?.disableOrphanCheck === true;
      return {
        passed,
        detail:
          `records=${records.length} input=${recordRow?.inputString} ` +
          `txids=${transactions.map((tx) => tx.txid).join(',')} ` +
          `setting=${settings?.disableOrphanCheck} tags=${JSON.stringify(recordRow?.tags)}`,
      };
    };
    await proveWrongThenCorrect(page, {
      backupName: STABLE_BACKUP_FIXTURE_NAME,
      backupBuffer: stableBackup.buffer,
      wrongPassword: `${STABLE_BACKUP_PASSWORD}-wrong`,
      correctPassword: STABLE_BACKUP_PASSWORD,
      beforeWrong: beforeStableWrong,
      record,
      label: 'stable-v1.1.24',
      verifyCorrect: verifyStableFixture,
      verifyReopen: (reopened) => verifyStableFixture(reopened),
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
    const legacyExpectedTxid = legacyData.blockchainTransactions[0]?.txid;

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
      verifyCorrect: ({ portableTables }) => {
        const settings = portableTables.settings?.find((row) => row.id === 'default');
        const transactions = portableTables.blockchainTransactions ?? [];
        return {
          passed: settings?.disableOrphanCheck === true &&
            transactions.length === 1 &&
            transactions[0]?.txid === legacyExpectedTxid,
          detail: `disableOrphanCheck=${settings?.disableOrphanCheck} txids=${transactions.map((tx) => tx.txid).join(',')}`,
        };
      },
    });

    await context?.close();
  } finally {
    await browser?.close().catch(() => {});
    await stopChild(devProc);
    await stopChild(appProc);
    await stopChild(xvfb);
    if (tempHome) {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
    }
  }

  const failed = steps.filter((step) => !step.passed);
  console.log(`\n${TAG} ${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) {
    throw new Error(`Failed steps: ${failed.map((step) => step.name).join(', ')}`);
  }
  console.log(`${TAG} PASSED: pinned stable-release, malformed, wrong-password, and corrupt-ciphertext restores are non-destructive; intact restores survive reopen.`);
}

main().catch((error) => {
  console.error(`${TAG} fatal:`, error?.stack ?? error);
  process.exit(1);
});