#!/usr/bin/env node
// Deterministic real-Chromium regression check for an empty vault's startup and
// client-side navigation (Task #241).  This deliberately measures the first
// authenticated app shell separately from warm route swaps: a fast route swap
// must not hide a slow unlock/startup regression.

import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';
import {
  completeFreshVaultOnboardingIfPresent,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

await acquireBrowserCheckLock();

const TAG = 'empty-vault-navigation-browser';
const PORT = Number(process.env.KYUTXO_DEV_PORT || 5000);
const BASE_URL = `http://localhost:${PORT}/`;
const PASSWORD = 'empty-vault-navigation-check-241';
const STARTUP_BUDGET_MS = Number(process.env.KYUTXO_EMPTY_VAULT_STARTUP_BUDGET_MS || 20_000);
const ROUTE_BUDGET_MS = Number(process.env.KYUTXO_EMPTY_VAULT_ROUTE_BUDGET_MS || 4_000);
const ROUTES = [
  // The sidebar's Records destination is the "/" dashboard route (the
  // dedicated /records route is a legacy/detail surface), so use its stable
  // empty-vault action as the readiness marker.
  { name: 'transaction inbox', testid: 'link-transaction-inbox', marker: 'transaction-curation-inbox' },
  { name: 'resolve ownership', testid: 'link-resolve-ownership', marker: 'ownership-resolution-page' },
  { name: 'coin origins', testid: 'link-coin-origins', marker: 'coin-origins-page' },
  { name: 'records', testid: 'link-records', marker: 'button-create-record' },
];

function chromiumPath() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No `chromium` binary found on PATH; install chromium or set CHROMIUM_BIN.');
  }
}
async function serverUp() {
  try {
    const response = await fetch(BASE_URL);
    return response.status < 500;
  } catch {
    return false;
  }
}
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  const executablePath = chromiumPath();
  console.log(`[${TAG}] chromium: ${executablePath}`);
  let server = null;
  let startedServer = false;
  if (!(await serverUp())) {
    console.log(`[${TAG}] starting dev server (npm run dev) ...`);
    server = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, detached: true });
    startedServer = true;
    if (!(await waitForServer(90_000))) throw new Error(`Dev server did not become ready at ${BASE_URL}.`);
  } else {
    console.log(`[${TAG}] reusing dev server at ${BASE_URL}`);
  }

  let browser;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      console.log(`[${TAG}] chromium launch failed (${attempt}), retrying: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
    }
  }

  const phases = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const backgroundLog = [];
    const pageErrors = [];
    page.on('console', (message) => {
      if (/\[(Records|DbUpgrade|LegacyDecrypt|FileDecrypt|SearchVisibilityRepair|CanonicalIdentifierRepair|Engine)/.test(message.text())) {
        backgroundLog.push(message.text());
      }
      if (message.type() === 'error') {
        pageErrors.push(`console: ${message.text()}`);
        console.log(`[${TAG}][page-console] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      window.__emptyVaultCheck = {
        longTasks: [],
        blockedOpenCount: 0,
        transactionCount: 0,
        pendingTransactions: 0,
        maxPendingTransactions: 0,
      };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__emptyVaultCheck.longTasks.push({
            start: entry.startTime,
            duration: entry.duration,
            name: entry.name,
          });
        }
      }).observe({ entryTypes: ['longtask'] });

      const originalOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        const request = originalOpen.apply(this, args);
        request.addEventListener('blocked', () => {
          window.__emptyVaultCheck.blockedOpenCount += 1;
        });
        return request;
      };

      const originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const transaction = originalTransaction.apply(this, args);
        const state = window.__emptyVaultCheck;
        state.transactionCount += 1;
        state.pendingTransactions += 1;
        state.maxPendingTransactions = Math.max(state.maxPendingTransactions, state.pendingTransactions);
        let didSettle = false;
        const settled = () => {
          if (didSettle) return;
          didSettle = true;
          state.pendingTransactions = Math.max(0, state.pendingTransactions - 1);
        };
        transaction.addEventListener('complete', settled, { once: true });
        transaction.addEventListener('abort', settled, { once: true });
        transaction.addEventListener('error', settled, { once: true });
        return transaction;
      };
    });
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60_000 });

    // The setup password and offline onboarding are part of the first-auth
    // measurement, but route swaps below never include a full page reload.
    const startupStart = Date.now();
    await unlockIfNeeded(page, PASSWORD, { appearTimeoutMs: 30_000, label: TAG });
    const onboarding = await completeFreshVaultOnboardingIfPresent(page, { label: TAG });
    await page.getByTestId('link-records').waitFor({ state: 'visible', timeout: STARTUP_BUDGET_MS });
    await page.getByTestId('group-overview').waitFor({ state: 'visible', timeout: STARTUP_BUDGET_MS });
    const startupMs = Date.now() - startupStart;
    const startupDiagnostics = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      visibility: document.visibilityState,
      resources: performance.getEntriesByType('resource').length,
      longTasks: window.__emptyVaultCheck.longTasks,
      database: {
        blockedOpenCount: window.__emptyVaultCheck.blockedOpenCount,
        transactionCount: window.__emptyVaultCheck.transactionCount,
        pendingTransactions: window.__emptyVaultCheck.pendingTransactions,
        maxPendingTransactions: window.__emptyVaultCheck.maxPendingTransactions,
      },
      heapUsed: performance.memory?.usedJSHeapSize ?? null,
    }));
    phases.push({
      name: 'first authenticated app-shell readiness',
      passed: startupMs <= STARTUP_BUDGET_MS,
      durationMs: startupMs,
      diagnostics: { onboarding, backgroundLog: backgroundLog.slice(), errors: pageErrors.slice(), ...startupDiagnostics },
    });

    // Warm route transitions are intentionally repeated. A fresh empty vault
    // should exercise each route's real data initialization without network.
    const transitions = [];
    for (let round = 1; round <= 3; round++) {
      for (const route of ROUTES) {
        const started = Date.now();
        const beforeTasks = await page.evaluate(() => window.__emptyVaultCheck.longTasks.length);
        const beforeBackgroundLog = backgroundLog.length;
        const beforeErrors = pageErrors.length;
        await page.getByTestId(route.testid).click();
        const marker = page.getByTestId(route.marker);
        await marker.waitFor({ state: 'visible', timeout: ROUTE_BUDGET_MS });
        if (route.name !== 'records') {
          await page.locator(`[data-testid="${route.marker}"][data-navigation-ready="true"]`).waitFor({ state: 'visible', timeout: ROUTE_BUDGET_MS });
        }
        const durationMs = Date.now() - started;
        const diagnostics = await page.evaluate(({ beforeTasks }) => {
          const all = window.__emptyVaultCheck.longTasks;
          return {
            url: location.href,
            visibility: document.visibilityState,
            longTasks: all.slice(beforeTasks),
            resources: performance.getEntriesByType('resource').length,
            database: {
              blockedOpenCount: window.__emptyVaultCheck.blockedOpenCount,
              transactionCount: window.__emptyVaultCheck.transactionCount,
              pendingTransactions: window.__emptyVaultCheck.pendingTransactions,
              maxPendingTransactions: window.__emptyVaultCheck.maxPendingTransactions,
            },
            heapUsed: performance.memory?.usedJSHeapSize ?? null,
          };
        }, { beforeTasks });
        diagnostics.backgroundLog = backgroundLog.slice(beforeBackgroundLog);
        diagnostics.errors = pageErrors.slice(beforeErrors);
        transitions.push({ round, route: route.name, durationMs, diagnostics });
      }
    }
    for (const transition of transitions) {
      phases.push({
        name: `route transition ${transition.route} (round ${transition.round})`,
        passed: transition.durationMs <= ROUTE_BUDGET_MS,
        durationMs: transition.durationMs,
        diagnostics: transition.diagnostics,
      });
    }
  } finally {
    await browser.close();
    if (startedServer && server) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* ignore */ } }
    }
  }

  const worstRoute = Math.max(...phases.filter((phase) => phase.name.startsWith('route transition')).map((phase) => phase.durationMs));
  const allLongTasks = phases.flatMap((phase) => phase.diagnostics.longTasks || []);
  const worstLongTask = Math.max(0, ...allLongTasks.map((entry) => entry.duration));
  const blockedOpenCount = Math.max(...phases.map((phase) => phase.diagnostics.database?.blockedOpenCount ?? 0));
  const noPageErrors = phases.every((phase) => (phase.diagnostics.errors ?? []).length === 0);
  const ok = phases.every((phase) => phase.passed) && noPageErrors && blockedOpenCount === 0 && worstLongTask < 1_000;
  console.log(`[${TAG}] startupBudgetMs=${STARTUP_BUDGET_MS} routeBudgetMs=${ROUTE_BUDGET_MS} worstRouteMs=${worstRoute} longTasks=${allLongTasks.length} worstLongTaskMs=${Math.round(worstLongTask)}`);
  for (const phase of phases) {
    console.log(`  [${phase.passed ? 'PASS' : 'FAIL'}] ${phase.name} :: ${phase.durationMs}ms :: ${JSON.stringify(phase.diagnostics)}`);
  }
  if (!ok) {
    console.error(`[${TAG}] FAILED: one or more empty-vault readiness/route budgets exceeded.`);
    process.exit(1);
  }
  console.log(`[${TAG}] PASSED: authenticated shell readiness and repeated client-side navigation stayed within bounded budgets.`);
}

main().catch((error) => {
  console.error(`[${TAG}] ERROR:`, error?.stack || error);
  process.exit(1);
});