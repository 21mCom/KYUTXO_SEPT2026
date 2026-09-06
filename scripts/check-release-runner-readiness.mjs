#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TAG = '[release-runner-readiness]';
const PLATFORM_ALIASES = Object.freeze({ win32: 'win', darwin: 'darwin', linux: 'linux' });
const COMMAND_PROBE_TIMEOUT_MS = 30_000;

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    timeout: COMMAND_PROBE_TIMEOUT_MS,
  });
}

function requireCommand(command, args = ['--version']) {
  const result = run(command, args);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`${command} is unavailable: ${detail}`);
  }
  return (result.stdout || result.stderr || '').trim().split(/\r?\n/, 1)[0];
}

function normalizeArch(arch) {
  if (arch === 'amd64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  return arch;
}

function linuxSessionId() {
  if (process.env.XDG_SESSION_ID) return process.env.XDG_SESSION_ID;
  const user = process.env.USER || os.userInfo().username;
  const result = run('loginctl', ['show-user', user, '--property=Display', '--value']);
  return result.status === 0 ? result.stdout.trim() : '';
}

function verifyLinuxDesktop() {
  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  if (!display) throw new Error('Linux runner has neither DISPLAY nor WAYLAND_DISPLAY');
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
    throw new Error('Linux runner has no DBUS_SESSION_BUS_ADDRESS');
  }

  requireCommand('loginctl', ['--version']);
  const sessionId = linuxSessionId();
  if (!sessionId) throw new Error('loginctl could not identify the runner user desktop session');
  const result = run('loginctl', [
    'show-session',
    sessionId,
    '--property=Active',
    '--property=Remote',
    '--property=Type',
  ]);
  if (result.error || result.status !== 0) {
    throw new Error(`loginctl could not inspect session ${sessionId}`);
  }
  const properties = Object.fromEntries(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  if (properties.Active !== 'yes') throw new Error(`Linux session ${sessionId} is not active`);
  if (properties.Remote === 'yes') throw new Error(`Linux session ${sessionId} is remote`);
  if (!['x11', 'wayland'].includes(properties.Type)) {
    throw new Error(`Linux session ${sessionId} is not graphical (Type=${properties.Type || 'unknown'})`);
  }
  return `session=${sessionId} type=${properties.Type} display=${display}`;
}

export function parseExpectedTarget(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--platform', '--arch'].includes(key) || !value) {
      throw new Error('usage: --platform <win|darwin|linux> --arch <x64|arm64>');
    }
    values.set(key, value);
  }
  const platform = values.get('--platform');
  const arch = values.get('--arch');
  if (!['win', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error('usage: --platform <win|darwin|linux> --arch <x64|arm64>');
  }
  return { platform, arch };
}

export function hostTarget() {
  return {
    platform: PLATFORM_ALIASES[process.platform] || process.platform,
    arch: normalizeArch(process.arch),
  };
}

function appendSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function main() {
  const expected = parseExpectedTarget(process.argv.slice(2));
  const actual = hostTarget();
  console.log(`${TAG} expected=${expected.platform}/${expected.arch}`);
  console.log(`${TAG} actual=${actual.platform}/${actual.arch}`);
  if (actual.platform !== expected.platform || actual.arch !== expected.arch) {
    throw new Error(
      `runner label target ${expected.platform}/${expected.arch} does not match host ` +
        `${actual.platform}/${actual.arch}`,
    );
  }

  const bash = requireCommand('bash', ['--version']);
  console.log(`${TAG} bash=${bash}`);
  let desktop = 'logged-in desktop runner (Linux-specific session inspection not required)';
  if (actual.platform === 'linux') desktop = verifyLinuxDesktop();
  console.log(`${TAG} desktop=${desktop}`);
  appendSummary([
    `### Ready: ${expected.platform}/${expected.arch}`,
    '',
    `- Host reported: \`${actual.platform}/${actual.arch}\``,
    `- Bash: \`${bash}\``,
    `- Desktop: \`${desktop}\``,
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = String(error?.message || error);
    console.error(`::warning title=Release desktop is not ready::${message}`);
    appendSummary(['### Not ready', '', `> ${message}`]);
    process.exitCode = 1;
  }
}