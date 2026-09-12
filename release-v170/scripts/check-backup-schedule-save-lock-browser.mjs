#!/usr/bin/env node
// Desktop-capable real-browser check for backup schedule controls.
//
// A raw IndexedDB read/write transaction holds the settings store while the
// real Settings UI starts its Dexie mutation. This proves the rendered Radix
// controls stay disabled for the full persistence wait. The first save is
// released successfully; the second closes Dexie before release so the queued
// write fails. Both paths must restore every control.

import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'backup-schedule-save-lock-check';
const CONTROL_IDS = [
  'switch-scheduled-backups',
  'button-add-backup-folder',
  'select-backup-cadence',
  'input-backup-retention',
  'select-backup-prompt',
  'switch-scheduled-compact',
  'switch-scheduled-encrypted',
  'button-save-backup-schedule',
];

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

async function startSettingsWriteBlocker(page) {
  await page.evaluate(() => {
    window.__backupScheduleWriteBlockerRelease = false;
    window.__backupScheduleWriteBlockerReady = new Promise((resolve, reject) => {
      const open = indexedDB.open('KYUTXODatabase');
      open.onerror = () => reject(open.error || new Error('Could not open vault database'));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('settings', 'readwrite');
        const store = transaction.objectStore('settings');
        const keepAlive = () => {
          const request = store.get('default');
          request.onerror = () => reject(request.error || new Error('Settings lock request failed'));
          request.onsuccess = () => {
            if (window.__backupScheduleWriteBlockerRelease) {
              database.close();
              return;
            }
            keepAlive();
          };
        };
        keepAlive();
        resolve();
      };
    });
  });
  await page.evaluate(() => window.__backupScheduleWriteBlockerReady);
}

async function releaseSettingsWriteBlocker(page) {
  await page.evaluate(() => {
    window.__backupScheduleWriteBlockerRelease = true;
  });
}

async function assertControlsDisabled(page, disabled) {
  for (const id of CONTROL_IDS) {
    const control = page.getByTestId(id);
    await control.waitFor({ state: 'visible' });
    assert.equal(await control.isDisabled(), disabled, `${id} disabled=${disabled}`);
  }
  const remove = page.getByRole('button', { name: 'Remove Primary drive' });
  assert.equal(await remove.isDisabled(), disabled, `remove destination disabled=${disabled}`);
}

async function assertForcedActivationsDoNotChange(page) {
  const before = await page.evaluate(() => ({
    enabled: document.querySelector('[data-testid="switch-scheduled-backups"]')?.getAttribute('data-state'),
    cadence: document.querySelector('[data-testid="select-backup-cadence"]')?.textContent,
    retention: document.querySelector('[data-testid="input-backup-retention"]')?.value,
    compact: document.querySelector('[data-testid="switch-scheduled-compact"]')?.getAttribute('data-state'),
    encrypted: document.querySelector('[data-testid="switch-scheduled-encrypted"]')?.getAttribute('data-state'),
  }));
  for (const id of [
    'switch-scheduled-backups',
    'select-backup-cadence',
    'switch-scheduled-compact',
    'switch-scheduled-encrypted',
  ]) {
    await page.getByTestId(id).click({ force: true });
  }
  await page.getByTestId('input-backup-retention').press('ArrowUp').catch(() => {});
  const after = await page.evaluate(() => ({
    enabled: document.querySelector('[data-testid="switch-scheduled-backups"]')?.getAttribute('data-state'),
    cadence: document.querySelector('[data-testid="select-backup-cadence"]')?.textContent,
    retention: document.querySelector('[data-testid="input-backup-retention"]')?.value,
    compact: document.querySelector('[data-testid="switch-scheduled-compact"]')?.getAttribute('data-state'),
    encrypted: document.querySelector('[data-testid="switch-scheduled-encrypted"]')?.getAttribute('data-state'),
  }));
  assert.deepEqual(after, before, 'disabled schedule controls changed after forced activation');
  assert.equal(await page.getByRole('option').count(), 0, 'disabled Radix Select opened');
}

let dev;
let browser;
try {
  if (!(await serverUp())) {
    dev = spawn('npm', ['run', 'dev'], { stdio: 'inherit', detached: true, env: process.env });
    const deadline = Date.now() + 120_000;
    while (!(await serverUp()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!(await serverUp())) throw new Error('dev server did not start');
  }

  browser = await chromium.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.electronAPI = { isElectron: true };
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[backup-schedule-save-lock] pageerror: ${error.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 60_000, label: 'backup-schedule-save-lock' });
  await completeFreshVaultOnboardingIfPresent(page, { label: 'backup-schedule-save-lock' });
  await page.evaluate(async () => {
    const settings = await import('/src/lib/data/settings-crud.ts');
    await settings.ensureSettings('default');
    await settings.mutateSettings('default', () => ({
      backupSchedule: {
        enabled: true,
        cadenceDays: 7,
        retentionCount: 5,
        promptBehavior: 'automatic',
        compact: false,
        encrypted: false,
        destinations: [
          { token: 'a'.repeat(32), label: 'Primary drive', path: '/backups/primary' },
        ],
      },
    }));
  });

  await page.goto(`${BASE_URL}settings`, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { label: 'backup-schedule-save-lock-settings' });
  await page.getByTestId('backup-schedule-section').waitFor({ state: 'visible', timeout: 60_000 });

  await page.getByTestId('input-backup-retention').fill('12');
  await startSettingsWriteBlocker(page);
  await page.getByTestId('button-save-backup-schedule').click();
  await page.getByText('Saving…').waitFor();
  await assertControlsDisabled(page, true);
  await assertForcedActivationsDoNotChange(page);
  await releaseSettingsWriteBlocker(page);
  await page.getByText('Backup schedule saved').first().waitFor();
  await assertControlsDisabled(page, false);
  assert.equal(await page.getByTestId('input-backup-retention').inputValue(), '12');

  await page.getByTestId('input-backup-retention').fill('13');
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/database.ts');
    window.__rejectBackupScheduleWrite = undefined;
    db.settings.update = () => new Promise((_resolve, reject) => {
      window.__rejectBackupScheduleWrite = () => reject(new Error('forced settings write failure'));
    });
  });
  await page.getByTestId('button-save-backup-schedule').click();
  await page.getByText('Saving…').waitFor();
  await assertControlsDisabled(page, true);
  await assertForcedActivationsDoNotChange(page);
  await page.evaluate(() => {
    if (!window.__rejectBackupScheduleWrite) {
      throw new Error('failed write did not reach the persistence boundary');
    }
    window.__rejectBackupScheduleWrite();
  });
  await page.getByText('Backup schedule not saved').first().waitFor();
  await assertControlsDisabled(page, false);
  assert.equal(await page.getByTestId('input-backup-retention').inputValue(), '13');

  console.log('PASS: desktop schedule controls stay locked through successful and failed real saves');
} finally {
  await browser?.close();
  if (dev?.pid) {
    try { process.kill(-dev.pid, 'SIGTERM'); } catch {}
  }
}