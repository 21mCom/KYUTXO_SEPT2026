import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findPackagedBinaries,
  findPackagedBinary,
  PACKAGED_BINARY_LOOKUP_TIMEOUT_MS,
  PACKAGED_BINARY_SPECS,
} from './packaged-electron-binaries.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPTS_DIR);
const PACKAGED_BROWSER_CHECKS = [
  'check-packaged-electron-browser.mjs',
  'check-wrong-password-packaged.mjs',
  'check-packaged-electrum-cancel-browser.mjs',
  'check-packaged-coin-passport-browser.mjs',
  'check-packaged-coin-origins-browser.mjs',
  'check-packaged-vault-migration.mjs',
];

test('all packaged browser checks use the shared binary discovery module', () => {
  for (const filename of PACKAGED_BROWSER_CHECKS) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, filename), 'utf8');
    assert.match(
      source,
      /import\s*\{\s*findPackagedBinaries\s*\}\s*from\s*['"]\.\/packaged-electron-binaries\.mjs['"]/,
      `${filename} must import the shared discovery helper`,
    );
    assert.match(
      source,
      /findPackagedBinaries\s*\(\s*\{\s*tag\s*:\s*TAG\s*\}\s*\)/,
      `${filename} must resolve both binaries through the shared helper`,
    );
    assert.doesNotMatch(
      source,
      /function findNixBinary|\/nix\/store\/\*-electron-|\/nix\/store\/\*-xorg-server-/,
      `${filename} must not carry a private discovery copy`,
    );
  }
});

test('keeps the Electron 29 and modern Xvfb discovery specs together', () => {
  assert.deepEqual(PACKAGED_BINARY_SPECS.electron, {
    envVar: 'KYUTXO_ELECTRON_BIN',
    storePattern: '/nix/store/*-electron-29.*/bin/electron',
    binName: 'electron',
    requirement: 'nix electron 29.x — upstream Electron binaries FPE-crash here',
  });
  assert.deepEqual(PACKAGED_BINARY_SPECS.xvfb, {
    envVar: 'KYUTXO_XVFB_BIN',
    storePattern: '/nix/store/*-xorg-server-2*/bin/Xvfb',
    binName: 'Xvfb',
    requirement: 'nix xorg-server Xvfb — xvfb-run\u2019s bundled 1.20 Xvfb segfaults here',
  });
});

test('uses both explicit environment overrides without probing the store', () => {
  const calls = [];
  const binaries = findPackagedBinaries({
    env: {
      KYUTXO_ELECTRON_BIN: '/override/electron',
      KYUTXO_XVFB_BIN: '/override/Xvfb',
    },
    exec: () => {
      calls.push('unexpected store probe');
      throw new Error('store probe should not run');
    },
  });

  assert.deepEqual(binaries, {
    electronBin: '/override/electron',
    xvfbBin: '/override/Xvfb',
  });
  assert.deepEqual(calls, []);
});

test('uses the narrow glob and bounded lookup when no override is set', () => {
  const calls = [];
  const binaries = findPackagedBinaries({
    env: {},
    exec: (command, options) => {
      calls.push({ command, options });
      return command.includes('electron-29.') ? '/nix/store/electron/bin/electron\n' : '/nix/store/xorg/bin/Xvfb\n';
    },
  });

  assert.deepEqual(binaries, {
    electronBin: '/nix/store/electron/bin/electron',
    xvfbBin: '/nix/store/xorg/bin/Xvfb',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].command, /\/nix\/store\/\*-electron-29\.\*\/bin\/electron/);
  assert.match(calls[1].command, /\/nix\/store\/\*-xorg-server-2\*\/bin\/Xvfb/);
  for (const { options } of calls) {
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.timeout, PACKAGED_BINARY_LOOKUP_TIMEOUT_MS);
  }
});

test('reports an actionable error when discovery times out or finds nothing', () => {
  assert.throws(
    () => findPackagedBinary({
      ...PACKAGED_BINARY_SPECS.electron,
      tag: '[test]',
      env: {},
      exec: () => {
        throw new Error('simulated timeout');
      },
    }),
    {
      message:
        '[test] could not find electron (nix electron 29.x — upstream Electron binaries FPE-crash here). ' +
        'Set KYUTXO_ELECTRON_BIN to override.',
    },
  );

  assert.throws(
    () => findPackagedBinary({
      ...PACKAGED_BINARY_SPECS.xvfb,
      tag: '[test]',
      env: {},
      exec: () => '',
    }),
    /could not find Xvfb .*Set KYUTXO_XVFB_BIN to override/,
  );
});

test('the packaged browser gate launches the generated Windows portable renderer with isolated state', () => {
  const source = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-electron-browser.mjs'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'build.yml'),
    'utf8',
  );

  assert.match(source, /process\.platform === 'win32'/);
  assert.match(source, /path\.join\(ROOT, 'release', IS_WINDOWS \? 'win-unpacked' : 'linux-unpacked'\)/);
  assert.match(source, /IS_WINDOWS \? 'KYUTXO\.exe' : 'kyutxo'/);
  assert.match(source, /KYUTXO-\.\+-Portable\\\.exe/);
  assert.match(source, /fs\.copyFileSync\(portableArtifact, launchExecutable\)/);
  assert.match(source, /portableLaunchDir/);
  assert.match(source, /taskkill.*args\.push\('\/F'\)/s);
  assert.match(source, /maxRetries: 10/);
  assert.match(source, /PORTABLE_CHECK_PASSWORD/);
  assert.match(source, /countRegularFiles\(portableDataDir\)/);
  assert.match(source, /waitForExistingVaultLoginScreen/);
  assert.match(source, /relaunching the same portable wrapper/);
  assert.match(source, /renderer-console-\$\{msg\.type\(\)\}/);
  assert.match(source, /\[renderer-pageerror\]/);
  assert.match(source, /\[startup-error\]/);
  assert.match(
    workflow,
    /- name: Verify packaged Windows renderer and portable restart persistence\s+env:\s+KYUTXO_PACKAGED_SKIP_BUILD: '1'\s+run: node scripts\/check-packaged-electron-browser\.mjs/,
  );
  assert.match(workflow, /generated Portable\.exe release asset/);
});

test('the packaged Coin Passport gate is release-wired after the native worker check', () => {
  const script = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-coin-passport-browser.mjs'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'build.yml'),
    'utf8',
  );
  const buildScript = fs.readFileSync(path.join(SCRIPTS_DIR, 'electron-build.sh'), 'utf8');

  assert.match(script, /engine\.query\('getCoinOriginsPage'/);
  assert.match(script, /expectedCheckpointKey/);
  assert.match(script, /IPC_PAGE_CAP = 250/);
  assert.match(script, /findPortableArtifact\(\)/);
  assert.match(script, /KYUTXO-.+-Portable\\\.exe/);
  assert.match(script, /portable launch copy/);
  assert.match(script, /portable artifact predates the validated app\.asar/);
  assert.doesNotMatch(script, /'--dir',\s+IS_WINDOWS \? '--win'/);
  assert.match(
    workflow,
    /- name: Verify oversized Coin Passport paging through packaged IPC\s+env:\s+KYUTXO_PACKAGED_SKIP_BUILD: '1'\s+run: node scripts\/check-packaged-coin-passport-browser\.mjs/,
  );
  assert.match(
    buildScript,
    /KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts\/check-packaged-coin-passport-browser\.mjs/,
  );
});

test('the packaged Coin Origins gate is release-wired after the native worker check', () => {
  const script = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-coin-origins-browser.mjs'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'build.yml'),
    'utf8',
  );
  const buildScript = fs.readFileSync(path.join(SCRIPTS_DIR, 'electron-build.sh'), 'utf8');

  assert.match(script, /engine\.query\('getCoinOriginsPage'/);
  assert.match(script, /Native engine Alpha acquisition/);
  assert.match(script, /Dexie fallback Alpha acquisition/);
  assert.match(script, /lotsTotal === 2/);
  assert.match(script, /holdingsTotal === 3/);
  assert.match(script, /origin-holding-unknown/);
  assert.match(script, /findPortableArtifact\(\)/);
  assert.match(script, /KYUTXO-.+-Portable\\\.exe/);
  assert.match(
    workflow,
    /- name: Verify Coin Origins wallet-scoped counts through packaged IPC\s+env:\s+KYUTXO_PACKAGED_SKIP_BUILD: '1'\s+run: node scripts\/check-packaged-coin-origins-browser\.mjs/,
  );
  assert.match(
    buildScript,
    /KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts\/check-packaged-coin-origins-browser\.mjs/,
  );
});