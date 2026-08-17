#!/usr/bin/env node
// Real-browser regression guard for the Electron version row in the About card
// (client/src/pages/settings/info-cards-section.tsx, AboutCard).
//
// The preload bridge exposes `electronVersion: process.versions.electron` and
// the component renders it conditionally when `isElectron && electronVersion`.
// A node-side unit test cannot verify the IPC plumbing end-to-end; this script
// proves in headless Chromium that:
//
//   1. When window.electronAPI is mocked with isElectron=true and
//      electronVersion="43.4.0", the Settings page shows
//      [data-testid="text-electron-version"] whose text starts with "43.".
//   2. [data-testid="text-app-version"] does NOT show the stale hardcoded
//      "1.0.0" string (i.e. the real package.json version is used).
//
// Usage: node scripts/check-about-electron-version-browser.mjs
// Requires: a `chromium` binary on PATH (Nix) and `playwright-core`.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

// Serialize real-Chromium checks: parallel runs share port 5000 + CPU/RAM
// and crash each other. Hold the lock for the whole script lifetime.
await acquireBrowserCheckLock();

const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const SETTINGS_URL = `${BASE_URL}settings`;
const SETUP_PASSWORD = 'about-electron-version-check-123';

// The mock electronVersion value — must start with "43." for the assertion.
const MOCK_ELECTRON_VERSION = '43.4.0';

// window.electronAPI shim installed before every page load.
// Models the Electron preload bridge with a known electronVersion.
const SHIM = `
(() => {
  window.electronAPI = {
    isElectron: true,
    electronVersion: '${MOCK_ELECTRON_VERSION}',
    platform: 'linux',
    // Stub all IPC channels so the app doesn't throw on init.
    engine: {
      init: async () => ({ ok: true }),
      status: async () => ({ status: 'idle' }),
      seedBegin: async () => ({ ok: true }),
      seedBatch: async () => ({ ok: true }),
      seedFinish: async () => ({ ok: true }),
      query: async () => ({ rows: [] }),
      benchmark: async () => ({ ok: true }),
      reopen: async () => ({ ok: true }),
      integrityCheck: async () => ({ ok: true }),
      clear: async () => ({ ok: true }),
      generateSynthetic: async () => ({ ok: true }),
      dbInfo: async () => ({ ok: true }),
      onFinalizeProgress: () => () => {},
    },
    isPortableMode: async () => false,
    torStatus: async () => ({ running: false }),
    torTest: async () => ({ success: false }),
    torRequest: async () => ({ success: false }),
    torUpdateSettings: async () => ({}),
    getDiskSpace: async () => ({ free: 1e9, total: 2e9 }),
    getAttachmentsSize: async () => 0,
    checkDemoVault: async () => ({ found: false }),
    readDemoVault: async () => ({ done: true, chunk: [] }),
    saveAttachment: async () => ({ ok: true }),
    readAttachment: async () => ({ ok: true, data: [] }),
    deleteAttachment: async () => ({ ok: true }),
    listAttachments: async () => [],
    listAllAttachments: async () => [],
    writeAttachment: async () => ({ ok: true }),
    renameAttachment: async () => ({ ok: true }),
    writeNeedsReview: async () => ({ ok: true }),
    openNeedsReviewFolder: async () => {},
    listNeedsReview: async () => [],
    readNeedsReview: async () => ({ ok: true, data: [] }),
    deleteNeedsReview: async () => ({ ok: true }),
    backupOpen: async () => ({ id: 'shim-backup-id' }),
    backupWrite: async () => ({ ok: true }),
    backupClose: async () => ({ ok: true }),
    backupAbort: async () => ({ ok: true }),
    electrumTest: async () => ({ success: false }),
    electrumGetHistory: async () => ({ success: false, history: [] }),
    electrumGetUtxos: async () => ({ success: false, utxos: [] }),
    electrumGetTransaction: async () => ({ success: false }),
    electrumGetBlockHash: async () => ({ success: false }),
    electrumCancel: async () => ({ success: true }),
    electrumBatchGetHistory: async () => ({ success: false }),
    electrumBatchGetUtxos: async () => ({ success: false }),
    electrumTrustCertificate: async () => ({ success: true }),
    electrumGetCertificateTrust: async () => ({ trusted: false }),
    electrumRevokeCertificate: async () => ({ success: true }),
  };
})();
`;

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
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function launchWithRetry(exe, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      lastErr = err;
      console.log(
        `[about-electron-version] chromium launch failed (attempt ${i + 1}/${attempts}): ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function dismissMigrationOverlayIfPresent(page) {
  const overlay = page.getByTestId('legacy-migration-overlay');
  const appeared = await overlay
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  console.log('[about-electron-version] legacy-migration overlay detected; dismissing ...');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await overlay.isVisible().catch(() => false))) return;
    const dismiss = page.getByTestId('button-dismiss-migration');
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  throw new Error('legacy-migration overlay did not clear within 60s');
}

async function unlockIfNeeded(page, password) {
  const pwInput = page.getByTestId('input-password');
  const appeared = await pwInput
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return; // already unlocked
  await pwInput.fill(password);
  const confirmInput = page.getByTestId('input-confirm-password');
  const isSetup = await confirmInput.isVisible().catch(() => false);
  if (isSetup) {
    await confirmInput.fill(password);
  }
  await page.getByTestId('button-submit').click();
  await page.getByTestId('input-password').waitFor({ state: 'hidden', timeout: 30_000 });
}

async function main() {
  const exe = resolveChromium();
  console.log(`[about-electron-version] chromium: ${exe}`);

  let devProc = null;
  let startedServer = false;
  if (await isServerUp(BASE_URL)) {
    console.log(`[about-electron-version] reusing dev server at ${BASE_URL}`);
  } else {
    console.log('[about-electron-version] starting dev server (npm run dev) ...');
    devProc = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: true,
    });
    startedServer = true;
    if (!(await waitForServer(BASE_URL, 90_000))) {
      throw new Error(`Dev server did not become ready at ${BASE_URL} within 90s.`);
    }
    console.log(`[about-electron-version] dev server ready at ${BASE_URL}`);
  }

  const steps = [];
  const step = (name, passed, detail = '') => {
    steps.push({ name, passed, detail });
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const browser = await launchWithRetry(exe);
  try {
    // ── Context 1: Electron shim (isElectron=true, electronVersion="43.4.0") ──
    console.log('\n[about-electron-version] === Context 1: Electron shim ===');
    {
      const context = await browser.newContext();
      // Install the electronAPI shim before every page load.
      await context.addInitScript(SHIM);
      const page = await context.newPage();

      // Load the settings page with retries.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          console.log(
            `[about-electron-version] goto failed (attempt ${attempt}): ${e.message}; retrying...`,
          );
          await new Promise((r) => setTimeout(r, 3_000 * attempt));
        }
      }

      // Create/unlock the vault so the app renders its pages.
      await unlockIfNeeded(page, SETUP_PASSWORD);
      await dismissMigrationOverlayIfPresent(page);

      // Navigate explicitly to /settings in case the unlock redirected elsewhere.
      const alreadyOnSettings = page.url().includes('/settings');
      if (!alreadyOnSettings) {
        await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
        await dismissMigrationOverlayIfPresent(page);
      }

      // Wait for the About card to be visible.
      const electronVersionEl = page.getByTestId('text-electron-version');
      const appeared = await electronVersionEl
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);

      step(
        '[electron] text-electron-version element is visible on the Settings page',
        appeared,
        appeared ? 'element present' : 'element NOT found (row may be hidden or testid missing)',
      );

      if (appeared) {
        const electronText = await electronVersionEl.textContent();
        step(
          '[electron] text-electron-version contains "43." (mocked value "43.4.0")',
          (electronText ?? '').includes('43.'),
          `text="${electronText}"`,
        );
      } else {
        steps.push({
          name: '[electron] text-electron-version contains "43."',
          passed: false,
          detail: 'skipped — element not found',
        });
      }

      // Assert the app version is NOT the stale hardcoded "1.0.0".
      const appVersionEl = page.getByTestId('text-app-version');
      const appVersionVisible = await appVersionEl
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);

      if (appVersionVisible) {
        const appVersionText = await appVersionEl.textContent();
        step(
          '[electron] text-app-version does NOT contain the stale hardcoded "1.0.0"',
          !(appVersionText ?? '').includes('1.0.0'),
          `text="${appVersionText}"`,
        );
      } else {
        steps.push({
          name: '[electron] text-app-version does NOT contain stale "1.0.0"',
          passed: false,
          detail: 'text-app-version element not found',
        });
      }

      await context.close();
    }

    // ── Context 2: PWA (no electronAPI shim) ──
    // The vault was already created by Context 1, so we only need to unlock here.
    console.log('\n[about-electron-version] === Context 2: PWA (no electronAPI shim) ===');
    {
      const context = await browser.newContext();
      // No addInitScript — window.electronAPI must be undefined.
      const page = await context.newPage();

      // Load settings with retries.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          console.log(
            `[about-electron-version] PWA goto failed (attempt ${attempt}): ${e.message}; retrying...`,
          );
          await new Promise((r) => setTimeout(r, 3_000 * attempt));
        }
      }

      // Unlock the existing vault (password was set in Context 1).
      await unlockIfNeeded(page, SETUP_PASSWORD);
      await dismissMigrationOverlayIfPresent(page);

      // Navigate explicitly to /settings in case the unlock redirected elsewhere.
      const alreadyOnSettings = page.url().includes('/settings');
      if (!alreadyOnSettings) {
        await page.goto(SETTINGS_URL, { waitUntil: 'load', timeout: 60_000 });
        await dismissMigrationOverlayIfPresent(page);
      }

      // Wait for the About card heading to confirm the card rendered.
      const appVersionEl = page.getByTestId('text-app-version');
      const appVersionVisible = await appVersionEl
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);

      step(
        '[pwa] text-app-version element is visible on the Settings page',
        appVersionVisible,
        appVersionVisible ? 'element present' : 'element NOT found',
      );

      // The Electron version row must NOT be present in the DOM.
      const electronVersionEl = page.getByTestId('text-electron-version');
      const electronRowPresent = await electronVersionEl
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);

      step(
        '[pwa] text-electron-version row is absent (PWA path hides it)',
        !electronRowPresent,
        electronRowPresent
          ? 'FAIL — row is visible but should be hidden without electronAPI'
          : 'correctly absent',
      );

      // The Type badge must show "Progressive Web App", not "Desktop App".
      // Find the badge that follows the "Type" label in the About card.
      // We match by text content rather than testid (no testid on the badge).
      const pwaBadge = page.getByText('Progressive Web App', { exact: true });
      const pwaBadgeVisible = await pwaBadge
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);

      step(
        '[pwa] Type badge shows "Progressive Web App"',
        pwaBadgeVisible,
        pwaBadgeVisible ? 'correct' : 'badge text not found or shows wrong value',
      );

      const desktopBadge = page.getByText('Desktop App', { exact: true });
      const desktopBadgeVisible = await desktopBadge
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);

      step(
        '[pwa] Type badge does NOT show "Desktop App"',
        !desktopBadgeVisible,
        desktopBadgeVisible ? 'FAIL — "Desktop App" badge is visible' : 'correctly absent',
      );

      await context.close();
    }
  } finally {
    await browser.close();
    if (startedServer && devProc) {
      try {
        process.kill(-devProc.pid, 'SIGTERM');
      } catch {
        try {
          devProc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }

  const ok = steps.every((s) => s.passed);

  console.log(`\n[about-electron-version] ok=${ok}`);
  for (const s of steps) {
    console.log(`  [${s.passed ? 'PASS' : 'FAIL'}] ${s.name} :: ${s.detail}`);
  }

  if (!ok) {
    console.error('\n[about-electron-version] FAILED:');
    for (const s of steps.filter((s) => !s.passed)) {
      console.error(`  - ${s.name}: ${s.detail}`);
    }
    process.exit(1);
  }

  console.log(
    '\n[about-electron-version] PASSED:\n' +
      `  • Electron context: version row visible with "${MOCK_ELECTRON_VERSION}" → "43.", ` +
      'app version is not the stale "1.0.0".\n' +
      '  • PWA context: version row is absent, Type badge shows "Progressive Web App" ' +
      '— end-to-end verified in a real browser.',
  );
}

main().catch((err) => {
  console.error(
    '[about-electron-version] ERROR:',
    err && err.stack ? err.stack : err,
  );
  process.exit(1);
});
