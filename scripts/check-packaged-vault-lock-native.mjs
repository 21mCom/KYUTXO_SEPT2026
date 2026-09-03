#!/usr/bin/env node
// Release smoke check for native Electron power-monitor delivery.
//
// Unlike the unit harness, this starts the packaged application and asks the
// host operating system to lock the session or suspend/resume. The main
// process' native-event log lines and the renderer lock-signal log lines are
// both captured, so a command that merely exits successfully without reaching
// Electron cannot pass this check.
//
// This check is intentionally limited to an interactive release runner.
// Screen locking and sleep can make an unattended CI session unavailable
// (Windows/macOS require a real user to unlock the runner), so it is a release
// gate and not an ordinary pull-request check. See
// docs/desktop-release-smoke-check.md.

import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPackagedAsarFresh,
  assertPackagedBundleFresh,
  repoRootFromModuleUrl,
} from './packaged-bundle-freshness.mjs';
import {
  expectedUnpackedDirectory,
  getPackagedTarget,
  parsePackagedTargetArgs,
  packagedTargetHelp,
} from './packaged-targets.mjs';
import {
  dismissMigrationOverlayIfPresent,
  waitForExistingVaultLoginScreen,
  waitForLoginScreenVisible,
  unlockIfNeeded,
} from './browser-check-utils.mjs';

export const NATIVE_EVENT_TIMEOUT_MS = 120_000;
export const STARTUP_TIMEOUT_MS = 90_000;
export const CHECK_PASSWORD = 'native-power-smoke-password';

const ROOT = repoRootFromModuleUrl(import.meta.url);
const TAG = '[packaged-vault-lock-native]';
const HOST_PLATFORM = process.platform === 'win32' ? 'win' : process.platform;
const IS_WINDOWS = HOST_PLATFORM === 'win';

const NATIVE_EVENT_LINES = Object.freeze({
  suspend: '[KYUTXO] System suspending (going to sleep)',
  resume: '[KYUTXO] System resumed from sleep',
  'lock-screen': '[KYUTXO] Screen locked',
});

const LOCK_SIGNAL_PREFIX = '[KYUTXO] Vault lock signal: ';

/**
 * The commands deliberately use native OS tools. Override them when a
 * release runner uses a desktop/session manager with a different command.
 *
 * A screen-lock command should leave the session locked until the operator
 * unlocks it. The command is launched without a shell; provide an executable
 * and JSON array of arguments through the environment when overriding it.
 */
export const NATIVE_POWER_ACTIONS = Object.freeze({
  win: Object.freeze({
    screenLock: { command: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
    suspend: { command: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] },
  }),
  darwin: Object.freeze({
    screenLock: {
      command: '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession',
      args: ['-suspend'],
    },
    suspend: { command: '/usr/bin/pmset', args: ['sleepnow'] },
  }),
  linux: Object.freeze({
    screenLock: { command: 'loginctl', args: ['lock-session'] },
    suspend: { command: 'systemctl', args: ['suspend'] },
  }),
});

export const POLICY_CASES = Object.freeze([
  Object.freeze({
    name: 'all lifecycle protections enabled',
    env: {
      KYUTXO_LOCK_ON_SUSPEND: '1',
      KYUTXO_LOCK_ON_RESUME: '1',
      KYUTXO_LOCK_ON_SCREEN_LOCK: '1',
    },
    screenLockSignals: ['lock-screen'],
    suspendSignals: ['suspend', 'resume'],
  }),
  Object.freeze({
    name: 'screen-lock protection disabled',
    env: {
      KYUTXO_LOCK_ON_SUSPEND: '1',
      KYUTXO_LOCK_ON_RESUME: '1',
      KYUTXO_LOCK_ON_SCREEN_LOCK: '0',
    },
    screenLockSignals: [],
  }),
  Object.freeze({
    name: 'suspend protection disabled',
    env: {
      KYUTXO_LOCK_ON_SUSPEND: '0',
      KYUTXO_LOCK_ON_RESUME: '1',
      KYUTXO_LOCK_ON_SCREEN_LOCK: '1',
    },
    suspendSignals: ['resume'],
  }),
  Object.freeze({
    name: 'resume protection disabled',
    env: {
      KYUTXO_LOCK_ON_SUSPEND: '1',
      KYUTXO_LOCK_ON_RESUME: '0',
      KYUTXO_LOCK_ON_SCREEN_LOCK: '1',
    },
    suspendSignals: ['suspend'],
  }),
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCommandOverride(raw, label) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${TAG} ${label} override must be JSON like ["command","arg"]`, {
      cause: error,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.some((part) => typeof part !== 'string')
  ) {
    throw new Error(`${TAG} ${label} override must be a non-empty string array`);
  }
  return { command: parsed[0], args: parsed.slice(1) };
}

export function nativePowerAction(platform, action, env = process.env) {
  const overrideName =
    action === 'screenLock'
      ? 'KYUTXO_SCREEN_LOCK_COMMAND'
      : 'KYUTXO_SUSPEND_COMMAND';
  const override = parseCommandOverride(env[overrideName], overrideName);
  if (override) return override;
  const actions = NATIVE_POWER_ACTIONS[platform];
  if (!actions?.[action]) {
    throw new Error(`${TAG} no native ${action} command is defined for ${platform}`);
  }
  return actions[action];
}

function runSync(command, args, options = {}) {
  console.log(`${TAG} $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowNonZero !== true) {
    throw new Error(`${TAG} native command failed (exit ${result.status}): ${command}`);
  }
  return result;
}

function resolveTarget() {
  const targetArgs = parsePackagedTargetArgs(process.argv.slice(2));
  if (targetArgs.help) {
    console.log(packagedTargetHelp());
    process.exit(0);
  }
  const platform = targetArgs.localDiagnostic ? HOST_PLATFORM : targetArgs.platform;
  const arch = targetArgs.localDiagnostic ? process.arch : targetArgs.arch;
  if (platform !== HOST_PLATFORM || arch !== process.arch) {
    throw new Error(
      `${TAG} native power events must run on the host package; target=${platform}/${arch} ` +
        `host=${HOST_PLATFORM}/${process.arch}`,
    );
  }
  getPackagedTarget(platform, arch);
  return {
    ...targetArgs,
    platform,
    arch,
    unpackedDir: targetArgs.unpackedDir
      ? path.resolve(targetArgs.unpackedDir)
      : expectedUnpackedDirectory(ROOT, platform, arch),
  };
}

function findPackagedExecutable(platform, unpackedDir) {
  if (platform === 'darwin') {
    return path.join(unpackedDir, 'KYUTXO.app', 'Contents', 'MacOS', 'KYUTXO');
  }
  if (platform === 'win') return path.join(unpackedDir, 'KYUTXO.exe');
  return path.join(unpackedDir, 'kyutxo');
}

function assertPackagedOutput(target) {
  const executable = findPackagedExecutable(target.platform, target.unpackedDir);
  if (!fs.existsSync(executable)) {
    throw new Error(`${TAG} packaged executable is missing: ${executable}`);
  }
  const resources =
    target.platform === 'darwin'
      ? path.join(target.unpackedDir, 'KYUTXO.app', 'Contents', 'Resources')
      : path.join(target.unpackedDir, 'resources');
  const asar = path.join(resources, 'app.asar');
  if (!fs.existsSync(asar)) throw new Error(`${TAG} packaged asar is missing: ${asar}`);
  return { executable, asar };
}

function buildPackagedOutput(target) {
  if (process.env.KYUTXO_PACKAGED_SKIP_BUILD === '1') {
    const output = assertPackagedOutput(target);
    assertPackagedBundleFresh({ tag: TAG });
    assertPackagedAsarFresh({ tag: TAG, asarPath: output.asar });
    return output;
  }
  runSync('npm', ['run', 'build']);
  assertPackagedBundleFresh({ tag: TAG });
  runSync('npx', [
    'electron-builder',
    '--config',
    'electron-builder.json',
    '--dir',
    target.platform === 'win' ? '--win' : target.platform === 'darwin' ? '--mac' : '--linux',
    `--${target.arch}`,
    '--publish',
    'never',
  ]);
  return assertPackagedOutput(target);
}

async function waitForCdp(port, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return true;
    } catch {
      // Electron is still starting.
    }
    await sleep(500);
  }
  return false;
}

async function waitForRendererPage(browser, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('kyutxo-app://bundle/')) return page;
      }
    }
    await sleep(500);
  }
  throw new Error(`${TAG} packaged renderer did not appear within ${timeoutMs}ms`);
}

function launchApp(target, packaged, env, cdpPort) {
  const { executable } = packaged;
  const args =
    target.platform === 'win'
      ? ['--disable-gpu', `--remote-debugging-port=${cdpPort}`]
      : [packaged.asar, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${cdpPort}`];
  const child = spawn(executable, args, {
    cwd: env.HOME,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WINDOWS,
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    process.stdout.write(`${TAG}[app] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
    process.stdout.write(`${TAG}[app-err] ${chunk}`);
  });
  return {
    child,
    getOutput: () => output,
  };
}

async function stopApp(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    runSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { allowNonZero: true });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Already exited.
  }
  await sleep(1500);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited.
    }
  }
}

export function nativeEventsSeen(output) {
  return output
    .split(/\r?\n/)
    .map((line) =>
      Object.entries(NATIVE_EVENT_LINES).find(([, marker]) => line.includes(marker))?.[0],
    )
    .filter(Boolean);
}

export function lockSignalsSeen(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes(LOCK_SIGNAL_PREFIX))
    .map((line) => line.slice(line.indexOf(LOCK_SIGNAL_PREFIX) + LOCK_SIGNAL_PREFIX.length).trim());
}

async function waitForNativeEvents(
  getOutput,
  eventsBeforeAction,
  expectedEvents,
  timeoutMs = NATIVE_EVENT_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const actualEvents = nativeEventsSeen(getOutput()).slice(eventsBeforeAction.length);
    if (JSON.stringify(actualEvents) === JSON.stringify(expectedEvents)) return;
    await sleep(500);
  }
  throw new Error(
    `${TAG} native event timeout; expected=${expectedEvents.join(',')} output=${getOutput().slice(-2000)}`,
  );
}

async function runNativeAction(platform, action, env) {
  const command = nativePowerAction(platform, action, env);
  console.log(`${TAG} requesting native ${action}: ${command.command} ${command.args.join(' ')}`);
  const child = spawn(command.command, command.args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      // A sleep request can terminate its helper as the OS suspends; that is
      // expected, while a non-zero immediate exit still deserves diagnosis.
      if (code !== 0 && action !== 'suspend') {
        reject(new Error(`${TAG} ${action} command exited ${code ?? signal}`));
      } else {
        resolve();
      }
    });
  });
}

async function assertRendererLockState(page, shouldBeLocked) {
  if (shouldBeLocked) {
    await waitForExistingVaultLoginScreen(page, { timeoutMs: 15_000 });
    const unlocked = await unlockIfNeeded(page, CHECK_PASSWORD, {
      appearTimeoutMs: 2_000,
      submitTimeoutMs: STARTUP_TIMEOUT_MS,
      label: 'native-power-smoke-reunlock',
    });
    if (!unlocked) {
      throw new Error(`${TAG} renderer showed the lock screen but could not be unlocked`);
    }
    return 'renderer returned to the existing-vault login screen';
  }

  const unexpectedlyLocked = await page
    .getByTestId('input-password')
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (unexpectedlyLocked) {
    throw new Error(`${TAG} renderer locked even though this policy signal was disabled`);
  }
  const rendererAlive = await page.evaluate(() => ({
    readyState: document.readyState,
    rootChildren: document.getElementById('root')?.childElementCount || 0,
  }));
  if (rendererAlive.readyState !== 'complete' || rendererAlive.rootChildren < 1) {
    throw new Error(`${TAG} renderer was not healthy while asserting the disabled policy`);
  }
  return 'renderer remained unlocked and responsive';
}

function expectedNativeEventsFor(action) {
  return action === 'screenLock' ? ['lock-screen'] : ['suspend', 'resume'];
}

function expectedSignalsFor(policy, action) {
  return action === 'screenLock'
    ? policy.screenLockSignals || []
    : policy.suspendSignals || [];
}

export async function runPolicyCase(
  target,
  output,
  env,
  page,
  policy,
  action,
  dependencies = {},
) {
  const performNativeAction = dependencies.runNativeAction || runNativeAction;
  const awaitNativeEvents = dependencies.waitForNativeEvents || waitForNativeEvents;
  const pause = dependencies.sleep || sleep;
  const verifyRendererLockState =
    dependencies.assertRendererLockState || assertRendererLockState;
  const expectedSignals = expectedSignalsFor(policy, action);
  const expectedNativeEvents = expectedNativeEventsFor(action);
  const nativeEventsBeforeAction = nativeEventsSeen(output.getOutput());
  const signalsBeforeAction = lockSignalsSeen(output.getOutput());
  const result = {
    name: `${policy.name} / ${action}`,
    passed: false,
    detail: '',
  };
  try {
    await performNativeAction(target.platform, action, env);
    await awaitNativeEvents(
      output.getOutput,
      nativeEventsBeforeAction,
      expectedNativeEvents,
    );
    // Native event logging and the following renderer signal are consecutive
    // writes, but they can arrive in separate stdout chunks.
    await pause(500);
    const actualSignals = lockSignalsSeen(output.getOutput()).slice(signalsBeforeAction.length);
    const exact = JSON.stringify(actualSignals) === JSON.stringify(expectedSignals);
    if (!exact) {
      throw new Error(
        `${TAG} ${result.name} signal mismatch: actual=${JSON.stringify(actualSignals)} ` +
          `expected=${JSON.stringify(expectedSignals)}`,
      );
    }
    const rendererDetail = await verifyRendererLockState(page, expectedSignals.length > 0);
    result.passed = true;
    result.detail =
      `native=${expectedNativeEvents.join(',')}; signals=${JSON.stringify(actualSignals)}; ` +
      `${rendererDetail}`;
  } catch (error) {
    result.detail = String(error?.message || error);
  }
  return result;
}

async function runCase(target, packaged, policy, actions, cdpPort, display) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kyutxo-native-power-smoke-'));
  const {
    PORTABLE_EXECUTABLE_DIR: _portableExecutableDir,
    KYUTXO_LOCK_ON_SUSPEND: _inheritedSuspendPolicy,
    KYUTXO_LOCK_ON_RESUME: _inheritedResumePolicy,
    KYUTXO_LOCK_ON_SCREEN_LOCK: _inheritedScreenLockPolicy,
    ...inheritedEnv
  } = process.env;
  const env = {
    ...inheritedEnv,
    ...policy.env,
    HOME: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
    XDG_CACHE_HOME: path.join(tmpHome, '.cache'),
    XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(tmpHome, '.local', 'state'),
    NODE_ENV: 'production',
    KYUTXO_IDLE_LOCK_SECONDS: '0',
    ...(display ? { DISPLAY: display } : {}),
  };
  if (IS_WINDOWS) {
    env.USERPROFILE = tmpHome;
    env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(tmpHome, 'AppData', 'Local');
    env.TEMP = tmpHome;
    env.TMP = tmpHome;
  }

  let app = null;
  let browser = null;
  const results = [];
  try {
    app = launchApp(target, packaged, env, cdpPort);
    if (!(await waitForCdp(cdpPort))) throw new Error(`${TAG} CDP did not start`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await waitForRendererPage(browser);
    await waitForLoginScreenVisible(page, { timeoutMs: STARTUP_TIMEOUT_MS });
    await unlockIfNeeded(page, CHECK_PASSWORD, {
      appearTimeoutMs: STARTUP_TIMEOUT_MS,
      submitTimeoutMs: STARTUP_TIMEOUT_MS,
      label: 'native-power-smoke',
    });
    await dismissMigrationOverlayIfPresent(page, {
      label: 'native-power-smoke',
      timeoutMs: STARTUP_TIMEOUT_MS,
    });

    for (const action of actions) {
      results.push(await runPolicyCase(target, app, env, page, policy, action));
      if (!results.at(-1).passed) break;
    }
  } catch (error) {
    results.push({
      name: `${policy.name} startup`,
      passed: false,
      detail: String(error?.message || error),
    });
  } finally {
    await browser?.close().catch(() => {});
    await stopApp(app?.child);
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return results;
}

async function main() {
  if (process.env.KYUTXO_NATIVE_POWER_SMOKE !== '1') {
    throw new Error(
      `${TAG} refuses to run without KYUTXO_NATIVE_POWER_SMOKE=1; ` +
        'this check intentionally locks/suspends the host OS.',
    );
  }
  const target = resolveTarget();
  const packaged = buildPackagedOutput(target);
  const display = process.env.DISPLAY;
  if (target.platform === 'linux' && !display) {
    throw new Error(
      `${TAG} Linux native power smoke requires the active interactive desktop DISPLAY`,
    );
  }
  const cdpBase = Number(process.env.KYUTXO_PACKAGED_CDP_PORT || 9250);
  const steps = [];
  console.log(`${TAG} target=${target.platform}/${target.arch}; package=${packaged.executable}`);
  console.log(
    `${TAG} release-runner action: screen-lock cases require unlocking the ` +
      'desktop session before the check can continue.',
  );

  const enabled = POLICY_CASES[0];
  steps.push(...(await runCase(target, packaged, enabled, ['screenLock', 'suspend'], cdpBase, display)));
  for (const policy of POLICY_CASES.slice(1)) {
    const action = policy.name.startsWith('screen-') ? 'screenLock' : 'suspend';
    steps.push(...(await runCase(target, packaged, policy, [action], cdpBase + steps.length + 1, display)));
  }

  console.log(`\n${TAG} Results:`);
  for (const step of steps) {
    console.log(`  ${step.passed ? 'PASS' : 'FAIL'}  ${step.name} — ${step.detail}`);
  }
  const failed = steps.filter((step) => !step.passed);
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${TAG} fatal:`, error);
    process.exitCode = 1;
  });
}