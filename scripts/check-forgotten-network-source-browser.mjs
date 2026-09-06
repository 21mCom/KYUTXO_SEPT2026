#!/usr/bin/env node
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
const PASSWORD = 'ForgottenSourceCheck#2026';
const CUSTOM_URL = 'https://node.forgotten-source.test';
const TOR_PROXY = 'socks5h://127.0.0.1:19050';
const ELECTRUM_HOST = 'electrum.forgotten-source.test';

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
  dev = spawn('npm', ['run', 'dev'], {
    stdio: 'inherit',
    detached: true,
    env: process.env,
  });
  const deadline = Date.now() + 90_000;
  while (!(await serverUp()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!(await serverUp())) throw new Error('dev server did not start');
}

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const providerRequests = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (
      url.includes('forgotten-source.test') ||
      url.includes('/api/tor/test') ||
      url.includes('/api/tor/request')
    ) {
      providerRequests.push(`${route.request().method()} ${url}`);
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();
  console.log('[forgotten-source] opening fresh vault');
  await page.goto(`${BASE_URL}node-settings`, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, {
    appearTimeoutMs: 60_000,
    label: 'forgotten-network-source',
  });
  await completeFreshVaultOnboardingIfPresent(page, {
    label: 'forgotten-network-source',
  });
  await page.goto(`${BASE_URL}node-settings`, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { label: 'forgotten-network-source-settings' });
  console.log('[forgotten-source] fresh vault ready');

  // Configure and explicitly enable a custom source through the real UI.
  await page.getByTestId('radio-provider-custom-electrs').click();
  await page.getByTestId('input-custom-url').fill(CUSTOM_URL);
  await page.getByTestId('switch-use-tor').click();
  await page.getByTestId('input-tor-proxy').fill(TOR_PROXY);
  await page.getByTestId('button-enable-selected-source').click();
  await page.getByTestId('text-network-privacy-state').getByText('Own node').waitFor();
  await page.getByText('Settings Saved').first().waitFor();

  // Electrum controls are desktop-only. Persist their details without changing
  // the mounted browser form; Forget must preserve these partial settings too.
  await page.evaluate(
    async ({ electrumHost }) => {
      const crud = await import('/src/lib/data/node-settings-crud.ts');
      await crud.updateNodeSettings('default', {
        useElectrum: true,
        electrumHost,
        electrumPort: 50002,
        electrumSSL: true,
      });
    },
    { electrumHost: ELECTRUM_HOST },
  );
  console.log('[forgotten-source] configured source visible');

  await page.getByTestId('button-forget-network-source').click();
  await page.getByTestId('dialog-forget-network-source').waitFor({ state: 'visible' });
  await page.getByTestId('button-confirm-forget-network-source').click();
  await page.getByText('Network Source Forgotten').first().waitFor();
  console.log('[forgotten-source] source forgotten');

  // Reopen the vault: the setup-required state must survive a full document
  // reload and must not silently restore access from the retained details.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { label: 'forgotten-network-source-reopen' });
  await page.getByText('Choose before KYUTXO connects').waitFor();
  await page.getByText('Stay offline — configure later').waitFor();
  const reopenedConsent = await page.evaluate(async () => {
    const crud = await import('/src/lib/data/node-settings-crud.ts');
    const settings = await crud.getNodeSettings('default');
    return {
      networkPrivacyMode: settings?.networkPrivacyMode,
      networkAccessEnabled: settings?.networkAccessEnabled,
      networkOnboardingStage: settings?.networkOnboardingStage,
    };
  });
  if (
    reopenedConsent.networkPrivacyMode !== undefined ||
    reopenedConsent.networkAccessEnabled !== false ||
    reopenedConsent.networkOnboardingStage !== 'source'
  ) {
    throw new Error(`forgotten source consent did not survive reopen: ${JSON.stringify(reopenedConsent)}`);
  }
  await completeFreshVaultOnboardingIfPresent(page, {
    label: 'forgotten-network-source-reopen',
  });

  await page.goto(`${BASE_URL}node-settings`, { waitUntil: 'domcontentloaded' });
  await unlockIfNeeded(page, PASSWORD, { label: 'forgotten-network-source-review' });
  await page.getByText('No network source configured').first().waitFor();
  await page
    .getByText('Choose and complete a source below, then explicitly enable it. Until then, network features stay blocked.')
    .waitFor();
  await page.getByTestId('text-network-privacy-state').getByText('Offline').waitFor();
  console.log('[forgotten-source] reopened offline state visible');

  const browserValues = [
    ['input-custom-url', CUSTOM_URL],
    ['input-tor-proxy', TOR_PROXY],
  ];
  for (const [testId, expected] of browserValues) {
    const actual = await page.getByTestId(testId).inputValue();
    if (actual !== expected) {
      throw new Error(`${testId} was not retained after Forget: expected ${expected}, got ${actual}`);
    }
  }

  // Expose desktop-only Electrum controls after the browser vault is already
  // open. Installing this bridge before reload would select packaged protected
  // storage instead of the browser-backed vault under test.
  await page.evaluate(() => {
    const calls = [];
    const unexpectedProviderCall = async (...args) => {
      calls.push(args);
      return { success: false, error: 'unexpected network test call' };
    };
    window.__forgottenSourceElectronCalls = calls;
    window.electronAPI = new Proxy(
      {
        isElectron: true,
        electrumTestConnection: unexpectedProviderCall,
        torTest: unexpectedProviderCall,
        torUpdateSettings: async () => ({ success: true }),
        torStatus: async () => ({ success: true, running: false }),
      },
      {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (prop === 'engine') return undefined;
          if (typeof prop === 'string') return async () => ({ success: true });
          return undefined;
        },
        has(_target, prop) {
          return prop !== 'engine';
        },
      },
    );
  });
  await page.getByTestId('input-custom-url').fill(`${CUSTOM_URL}/rerender`);
  await page.getByTestId('input-custom-url').fill(CUSTOM_URL);

  const desktopValues = [
    ['input-electrum-host', ELECTRUM_HOST],
    ['input-electrum-port', '50002'],
  ];
  for (const [testId, expected] of desktopValues) {
    const actual = await page.getByTestId(testId).inputValue();
    if (actual !== expected) {
      throw new Error(`${testId} was not retained after Forget: expected ${expected}, got ${actual}`);
    }
  }

  const testButtons = [
    'button-test-connection',
    'button-test-tor',
    'button-test-electrum',
  ];
  for (const testId of testButtons) {
    const button = page.getByTestId(testId);
    await button.waitFor({ state: 'visible' });
    if (await button.isEnabled()) throw new Error(`${testId} was enabled before source activation`);
    await button.dispatchEvent('click');
  }
  await page.waitForTimeout(500);

  const electronCalls = await page.evaluate(() => window.__forgottenSourceElectronCalls.length);
  if (electronCalls !== 0) {
    throw new Error(`disabled test controls made ${electronCalls} Electron provider call(s)`);
  }
  if (providerRequests.length !== 0) {
    throw new Error(`disabled test controls contacted providers: ${providerRequests.join(', ')}`);
  }

  const persisted = await page.evaluate(async () => {
    const crud = await import('/src/lib/data/node-settings-crud.ts');
    const settings = await crud.getNodeSettings('default');
    return {
      networkPrivacyMode: settings?.networkPrivacyMode,
      networkAccessEnabled: settings?.networkAccessEnabled,
      networkOnboardingStage: settings?.networkOnboardingStage,
    };
  });
  if (
    persisted.networkPrivacyMode !== undefined ||
    persisted.networkAccessEnabled !== false ||
    persisted.networkOnboardingStage !== 'complete'
  ) {
    throw new Error(`stay-offline choice did not persist: ${JSON.stringify(persisted)}`);
  }

  console.log('PASS: forgotten source stays setup-required and offline after vault reopen');
} finally {
  await browser.close();
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, 'SIGTERM');
    } catch {
      // The dev server may already have exited.
    }
  }
}