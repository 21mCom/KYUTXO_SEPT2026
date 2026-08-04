#!/usr/bin/env node
// Task 1831 verification: the packaged desktop app must show "Incorrect
// password" (data-testid text-error) when a wrong vault password is entered,
// and the vault must stay locked.
//
// Background: task #1820 fixed a silent wrong-password unlock — LoginScreen
// was unmounted by the global loading gate in client/src/App.tsx, wiping its
// error state. The original report came from a packaged-app run (#1781), so
// this check proves the fix end-to-end in the real electron-builder asar.
//
// Flow (same Xvfb + CDP recipe as scripts/check-packaged-electron-browser.mjs),
// all in ONE app session (a kill/relaunch cycle is flaky here: the packaged
// app's single-instance lock + unflushed profile state make the second launch
// unreliable):
//   1. Fresh profile → Create Vault form → set password → vault unlocks.
//   2. Click the in-app lock button (button-logout) → Unlock form appears
//      (isInitialized=true — the exact LoginScreen + App.tsx loading-gate
//      path from the bug report).
//   3. Enter a WRONG password → assert text-error shows "Incorrect password"
//      and the login form (input-password) stays mounted (vault locked).
//
// Usage:
//   KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts/check-wrong-password-packaged.mjs
//     Reuses release/linux-unpacked/resources/app.asar (fails if absent).
//   Without the env var it builds everything first (several minutes).

import { chromium } from 'playwright-core';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireBrowserCheckLock } from './browser-check-lock.mjs';

await acquireBrowserCheckLock();

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ASAR = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');
const CDP_PORT = Number(process.env.KYUTXO_PACKAGED_CDP_PORT || 9224);
const TAG = '[wrong-password-packaged]';
const GOOD_PASSWORD = 'correct-horse-battery';
const WRONG_PASSWORD = 'definitely-not-it-42';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findNixBinary({ envVar, storeGlobs, binName, requirement }) {
  if (process.env[envVar]) return process.env[envVar];
  for (const glob of storeGlobs) {
    let entries = [];
    try {
      entries = fs.readdirSync('/nix/store').filter((n) => glob.test(n)).sort().reverse();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join('/nix/store', entry, 'bin', binName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  throw new Error(`${TAG} could not find ${binName} (${requirement}). Set ${envVar} to override.`);
}

function run(cmd, args) {
  console.log(`${TAG} $ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`${TAG} command failed (exit ${res.status}): ${cmd} ${args.join(' ')}`);
  }
}

function buildAsar() {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    if (!fs.existsSync(ASAR)) {
      throw new Error(`${TAG} KYUTXO_PACKAGED_SKIP_BUILD=1 but ${ASAR} does not exist.`);
    }
    console.log(`${TAG} reusing existing asar: ${ASAR}`);
    return;
  }
  run('npm', ['run', 'build']);
  run('node', ['scripts/build-native-engine.mjs']);
  run('npx', ['electron-builder', '--config', 'electron-builder.json', '--dir', '--linux', '-c.npmRebuild=false']);
  if (!fs.existsSync(ASAR)) {
    throw new Error(`${TAG} electron-builder finished but ${ASAR} was not produced.`);
  }
}

async function waitForCdp(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

function launchApp(electronBin, env, DISPLAY, cwd) {
  const child = spawn(
    electronBin,
    [
      ASAR,
      '--no-sandbox',
      '--disable-gpu',
      // Longer sessions than the blank-window gate: without these, Chromium
      // keeps retrying a separate GPU process, and after ~6 failed launches
      // (error_code=1002 under Xvfb) it FATALs the whole app mid-run.
      '--in-process-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      `--remote-debugging-port=${CDP_PORT}`,
    ],
    { cwd, env: { ...env, DISPLAY }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  child.stdout.on('data', (d) => process.stdout.write(`${TAG}[app] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`${TAG}[app-err] ${d}`));
  child.on('exit', (code, sig) => console.log(`${TAG} app process exited (code=${code} sig=${sig})`));
  return child;
}

function killTree(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
}

async function connectAndFindPage() {
  if (!(await waitForCdp(90_000))) {
    throw new Error(`${TAG} CDP endpoint never came up on port ${CDP_PORT}`);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  let page = null;
  const deadline = Date.now() + 60_000;
  while (!page && Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().startsWith('file://')) page = p;
      }
    }
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error(`${TAG} no file:// renderer page appeared within 60s.`);
  console.log(`${TAG} renderer page: ${page.url()}`);
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`${TAG}[console-${msg.type()}] ${msg.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (err) => console.log(`${TAG}[pageerror] ${String(err).slice(0, 300)}`));
  page.on('crash', () => console.log(`${TAG}[page CRASHED]`));
  return { browser, page };
}

async function main() {
  buildAsar();

  const electronBin = findNixBinary({
    envVar: 'KYUTXO_ELECTRON_BIN',
    storeGlobs: [/-electron-29\./],
    binName: 'electron',
    requirement: 'nix electron 29.x — upstream Electron binaries FPE-crash here',
  });
  const xvfbBin = findNixBinary({
    envVar: 'KYUTXO_XVFB_BIN',
    storeGlobs: [/-xorg-server-21\./, /-xorg-server-2\d\./],
    binName: 'Xvfb',
    requirement: 'nix xorg-server Xvfb (xvfb-run\u2019s bundled 1.20 Xvfb segfaults here)',
  });
  console.log(`${TAG} electron: ${electronBin}`);
  console.log(`${TAG} Xvfb: ${xvfbBin}`);

  // One persistent profile shared across BOTH launches: run 1 creates the
  // vault, run 2 must see it as initialized and reject the wrong password.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-wrongpw-check-'));
  const env = {
    ...process.env,
    HOME: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
    XDG_CACHE_HOME: path.join(tmpHome, '.cache'),
    XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(tmpHome, '.local', 'state'),
    NODE_ENV: 'production',
  };

  const DISPLAY = process.env.KYUTXO_PACKAGED_DISPLAY || ':98';
  console.log(`${TAG} starting Xvfb on ${DISPLAY}...`);
  const xvfb = spawn(xvfbBin, [DISPLAY, '-screen', '0', '1280x800x24'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  xvfb.stderr.on('data', (d) => process.stdout.write(`${TAG}[xvfb] ${d}`));
  await sleep(2000);

  const steps = [];
  let browser = null;
  let child = null;
  try {
    // ── Run 1: create the vault ──────────────────────────────────────────
    console.log(`${TAG} run 1: launching packaged app (create vault)...`);
    child = launchApp(electronBin, env, DISPLAY, tmpHome);
    let page;
    ({ browser, page } = await connectAndFindPage());

    await page.getByTestId('input-password').waitFor({ state: 'visible', timeout: 60_000 });
    const confirmVisible = await page
      .getByTestId('input-confirm-password')
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'run 1 shows the Create Vault form (fresh profile)',
      passed: confirmVisible,
      detail: `confirm-password field visible=${confirmVisible}`,
    });
    if (!confirmVisible) throw new Error(`${TAG} expected fresh-profile setup form; aborting.`);

    await page.getByTestId('input-password').fill(GOOD_PASSWORD);
    await page.getByTestId('input-confirm-password').fill(GOOD_PASSWORD);
    await page.getByTestId('button-submit').click();
    // Vault created → app unlocks → login form disappears.
    await page.getByTestId('input-password').waitFor({ state: 'detached', timeout: 60_000 });
    steps.push({
      name: 'run 1 vault created and unlocked (login form unmounted)',
      passed: true,
      detail: 'input-password detached after Create Vault',
    });

    // ── Relaunch the app → Unlock form ────────────────────────────────────
    // Quit gracefully (SIGTERM → clean Electron shutdown, exit code 0) so the
    // Chromium profile (IndexedDB kybtc-vault) flushes, then relaunch with the
    // same profile. This is the real user journey from the bug report:
    // restart the packaged app, get the Unlock form, type a wrong password.
    console.log(`${TAG} quitting gracefully and relaunching...`);
    await sleep(3000); // let post-create writes settle
    await browser.close().catch(() => {});
    browser = null;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killTree(child);
    await Promise.race([exited, sleep(20_000)]);
    await sleep(2000);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }

    child = launchApp(electronBin, env, DISPLAY, tmpHome);
    ({ browser, page } = await connectAndFindPage());
    await page.getByTestId('input-password').waitFor({ state: 'visible', timeout: 120_000 });
    const confirmOnUnlock = await page
      .getByTestId('input-confirm-password')
      .isVisible()
      .catch(() => false);
    steps.push({
      name: 'relaunch shows the Unlock form (vault persisted; no confirm field)',
      passed: !confirmOnUnlock,
      detail: `confirm-password visible=${confirmOnUnlock} (must be false)`,
    });
    if (confirmOnUnlock) throw new Error(`${TAG} unlock form not shown after relaunch; aborting.`);

    // ── Wrong password must surface the error and stay locked ────────────
    // Startup churn (vault check / eager migrations) can remount LoginScreen
    // shortly after first paint, wiping a too-early fill. Fill, then verify
    // the value actually stuck before submitting; retry until it does.
    const pwInput = page.getByTestId('input-password');
    let fillStuck = false;
    for (let attempt = 0; attempt < 10 && !fillStuck; attempt++) {
      await sleep(2000);
      await pwInput.fill(WRONG_PASSWORD);
      await sleep(1000);
      fillStuck = (await pwInput.inputValue().catch(() => '')) === WRONG_PASSWORD;
    }
    if (!fillStuck) throw new Error(`${TAG} password fill never persisted in the unlock form.`);
    await page.getByTestId('button-submit').click();

    let errorText = '';
    let errorShown = false;
    try {
      const el = page.getByTestId('text-error');
      await el.waitFor({ state: 'visible', timeout: 60_000 });
      errorText = (await el.innerText()).trim();
      errorShown = errorText === 'Incorrect password';
    } catch {
      errorShown = false;
      const debug = await page
        .evaluate(() => ({
          body: document.body ? document.body.innerText.slice(0, 400) : '<no body>',
          errorEl: document.querySelector('[data-testid="text-error"]')?.textContent ?? null,
          submitLabel:
            document.querySelector('[data-testid="button-submit"]')?.textContent ?? null,
          pwValue:
            document.querySelector('[data-testid="input-password"]')?.value ?? null,
        }))
        .catch((e) => ({ body: `<evaluate failed: ${e}>` }));
      console.log(`${TAG} DEBUG after wrong password: ${JSON.stringify(debug)}`);
    }
    steps.push({
      name: 'wrong password shows the "Incorrect password" error (text-error)',
      passed: errorShown,
      detail: errorShown ? `text-error = ${JSON.stringify(errorText)}` : `text-error missing or wrong (got ${JSON.stringify(errorText)})`,
    });

    // Vault stays locked: login form still mounted after the error, and stays
    // that way (guard against a delayed unlock).
    await sleep(2000);
    const stillLocked = await page.getByTestId('input-password').isVisible().catch(() => false);
    const submitLabel = await page
      .getByTestId('button-submit')
      .innerText()
      .catch(() => '');
    steps.push({
      name: 'vault stays locked after the wrong password',
      passed: stillLocked && /unlock vault/i.test(submitLabel),
      detail: `input-password visible=${stillLocked}, submit label=${JSON.stringify(submitLabel)}`,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child) {
      killTree(child);
      await sleep(2000);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    try {
      process.kill(-xvfb.pid, 'SIGTERM');
    } catch {
      try {
        xvfb.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log(`\n${TAG} Results:`);
  for (const s of steps) {
    console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name} — ${s.detail}`);
  }
  const failed = steps.filter((s) => !s.passed);
  if (failed.length > 0) {
    console.error(`\n${TAG} ${failed.length}/${steps.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n${TAG} all ${steps.length} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
