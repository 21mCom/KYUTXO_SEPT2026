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
const PACKAGED_BROWSER_CHECKS = [
  'check-packaged-electron-browser.mjs',
  'check-wrong-password-packaged.mjs',
  'check-packaged-electrum-cancel-browser.mjs',
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