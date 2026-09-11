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
import {
  findWindowsPortableArtifact,
  prepareWindowsPortableLaunch,
  verifyWindowsPortableBundle,
} from './packaged-windows-portable.mjs';
import {
  clearPackagedCdpOwnership,
  packagedCdpLaunchArgs,
  readDevToolsActivePort,
  waitForOwnedPackagedCdp,
} from './packaged-cdp.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPTS_DIR);
const PACKAGED_NON_BROWSER_CHECKS = new Set([
  // These validate packaged internals without launching a renderer under
  // Electron/Xvfb, so the browser-check filename convention does not apply.
  'check-packaged-native-engine.mjs',
  'check-packaged-vault-lock-native.mjs',
]);
const PACKAGED_BROWSER_CHECK_PATTERN = /^check-packaged-.+-browser\.mjs$/;
const MANUAL_PACKAGED_BROWSER_CHECKS = new Map();

test('packaged CDP uses an OS-selected loopback port and isolated absolute profile', () => {
  const profile = path.join(path.parse(SCRIPTS_DIR).root, 'tmp', 'owned-cdp');
  assert.deepEqual(packagedCdpLaunchArgs(profile), [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
  ]);
  assert.throws(() => packagedCdpLaunchArgs('relative-profile'), /must be absolute/);
});

test('packaged CDP ownership binds the endpoint websocket token to the launch profile', async (t) => {
  const profile = fs.mkdtempSync(path.join(SCRIPTS_DIR, '.cdp-owner-test-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(profile, 'DevToolsActivePort'),
    '43123\n/devtools/browser/owned-token\n',
  );
  assert.deepEqual(readDevToolsActivePort(profile).port, 43123);

  const owned = await waitForOwnedPackagedCdp({
    userDataDir: profile,
    timeoutMs: 100,
    pollMs: 1,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/browser/owned-token',
      }),
    }),
  });
  assert.equal(owned.browserPath, '/devtools/browser/owned-token');
  clearPackagedCdpOwnership(profile);
  assert.equal(fs.existsSync(path.join(profile, 'DevToolsActivePort')), false);
  fs.writeFileSync(
    path.join(profile, 'DevToolsActivePort'),
    '43123\n/devtools/browser/owned-token\n',
  );

  await assert.rejects(
    waitForOwnedPackagedCdp({
      userDataDir: profile,
      timeoutMs: 20,
      pollMs: 1,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/browser/unrelated-token',
        }),
      }),
    }),
    /could not establish ownership.*CDP ownership mismatch.*unrelated-token/,
  );
});

function discoverPackagedBrowserChecks(filenames) {
  return filenames
    .filter((filename) => PACKAGED_BROWSER_CHECK_PATTERN.test(filename))
    .sort();
}

function discoverPackagedCdpChecks(filenames) {
  return filenames
    .filter((filename) =>
      PACKAGED_BROWSER_CHECK_PATTERN.test(filename) ||
      filename === 'check-packaged-vault-lock-native.mjs')
    .sort();
}

function assertUsesOwnedPackagedCdp(filename, source) {
  assert.match(
    source,
    /import\s*\{[\s\S]*\bpackagedCdpLaunchArgs\b[\s\S]*\bwaitForOwnedPackagedCdp\b[\s\S]*\}\s*from\s*['"]\.\/packaged-cdp\.mjs['"]/,
    `${filename} must import the shared packaged CDP launch and ownership helpers`,
  );
  assert.match(
    source,
    /\bpackagedCdpLaunchArgs\s*\(/,
    `${filename} must launch packaged Electron with packagedCdpLaunchArgs`,
  );
  assert.match(
    source,
    /\bwaitForOwnedPackagedCdp\s*\(/,
    `${filename} must establish CDP ownership with waitForOwnedPackagedCdp`,
  );
  assert.doesNotMatch(
    source,
    /--remote-debugging-port=(?!0(?:['"`\s]|$))/,
    `${filename} must not select a fixed remote debugging port`,
  );
  assert.doesNotMatch(
    source,
    /\b(?:async\s+)?function\s+(?:waitForCdp|cdpIsUp)\b/,
    `${filename} must not implement private CDP ownership polling`,
  );
}

test('all packaged CDP launchers use OS-selected ports and ownership handshakes', () => {
  const filenames = discoverPackagedCdpChecks(fs.readdirSync(SCRIPTS_DIR));
  assert.ok(filenames.length > 0, 'must discover packaged CDP launchers');
  for (const filename of filenames) {
    assertUsesOwnedPackagedCdp(filename, fs.readFileSync(path.join(SCRIPTS_DIR, filename), 'utf8'));
  }
});

test('a packaged CDP launcher cannot restore fixed ports or private ownership polling', () => {
  assert.throws(
    () => assertUsesOwnedPackagedCdp(
      'check-packaged-future-feature-browser.mjs',
      [
        "import { packagedCdpLaunchArgs, waitForOwnedPackagedCdp } from './packaged-cdp.mjs';",
        'packagedCdpLaunchArgs("/absolute/profile");',
        'waitForOwnedPackagedCdp({ userDataDir: "/absolute/profile" });',
        'const args = ["--remote-debugging-port=9222"];',
        'async function waitForCdp() {}',
      ].join('\n'),
    ),
    /must not select a fixed remote debugging port/,
  );
});

function assertRegisteredPackagedCheckNames(registrationSources) {
  for (const [sourceName, source] of Object.entries(registrationSources)) {
    const registeredChecks = source.matchAll(
      /\bnode\s+scripts\/(?<filename>check-(?:[\w-]+-)?packaged(?:-[\w-]+)?\.mjs)\b/g,
    );
    for (const match of registeredChecks) {
      const filename = match.groups.filename;
      assert.ok(
        PACKAGED_BROWSER_CHECK_PATTERN.test(filename) ||
          PACKAGED_NON_BROWSER_CHECKS.has(filename),
        `${sourceName} registers unrecognized packaged check ${filename}; ` +
          'packaged Electron browser checks must be named check-packaged-*-browser.mjs',
      );
    }
  }
}

function findRegisteredPackagedBrowserChecks(
  registrationSources,
  { requireValidationMetadata = false } = {},
) {
  const registered = new Set();
  for (const source of Object.values(registrationSources)) {
    const registrationBlocks = requireValidationMetadata
      ? source.split(/\[\[workflows\.workflow\]\]/).filter(
        (block) => /\bisValidation\s*=\s*true\b/.test(block),
      )
      : [source];
    for (const block of registrationBlocks) {
      for (const match of block.matchAll(
        /\bnode\s+scripts\/(?<filename>check-packaged-.+-browser\.mjs)\b/g,
      )) {
        registered.add(match.groups.filename);
      }
    }
  }
  return registered;
}

function assertPackagedBrowserCheckRegistrationPolicy({
  discoveredChecks,
  releaseSources,
  validationSources,
  manualChecks = MANUAL_PACKAGED_BROWSER_CHECKS,
}) {
  const discovered = new Set(discoveredChecks);
  const releaseRegistered = findRegisteredPackagedBrowserChecks(releaseSources);
  const validationRegistered = findRegisteredPackagedBrowserChecks(
    validationSources,
    { requireValidationMetadata: true },
  );

  for (const [filename, reason] of manualChecks) {
    assert.ok(
      PACKAGED_BROWSER_CHECK_PATTERN.test(filename),
      `manual packaged browser check classification has an invalid filename: ${filename}`,
    );
    assert.ok(
      discovered.has(filename),
      `manual packaged browser check classification is stale: ${filename} does not exist`,
    );
    assert.ok(
      typeof reason === 'string' && reason.trim().length >= 40,
      `manual packaged browser check ${filename} must document a specific reason`,
    );
    assert.ok(
      !releaseRegistered.has(filename) && !validationRegistered.has(filename),
      `${filename} is registered; remove its obsolete manual classification`,
    );
  }

  const orphaned = discoveredChecks.filter(
    (filename) =>
      !releaseRegistered.has(filename) &&
      !validationRegistered.has(filename) &&
      !manualChecks.has(filename),
  );
  assert.deepEqual(
    orphaned,
    [],
    'orphaned packaged browser check(s): ' +
      `${orphaned.join(', ')}. Register each check in scripts/electron-build.sh or ` +
      '.github/workflows/build.yml as a release gate, register it as a validation in ' +
      '.replit, or add a narrowly documented entry to MANUAL_PACKAGED_BROWSER_CHECKS.',
  );
}

function assertUsesSharedBinaryDiscovery(filename, source) {
  assert.match(
    source,
    /import\s*\{[\s\S]*\bfindPackagedBinar(?:y|ies)\b[\s\S]*\}\s*from\s*['"]\.\/packaged-electron-binaries\.mjs['"]/,
    `${filename} must import the shared discovery helper`,
  );
  if (filename === 'check-packaged-wrong-password-browser.mjs') {
    assert.match(
      source,
      /findPackagedBinary\s*\(\s*\{[\s\S]*\.\.\.PACKAGED_BINARY_SPECS\.xvfb,[\s\S]*tag:\s*TAG,[\s\S]*\}\s*\)/,
      `${filename} must resolve Xvfb through the shared helper`,
    );
  } else {
    assert.match(
      source,
      /findPackagedBinaries\s*\(\s*\{\s*tag\s*:\s*TAG\s*\}\s*\)/,
      `${filename} must resolve both binaries through the shared helper`,
    );
  }
  assert.doesNotMatch(
    source,
    /function findNixBinary|\/nix\/store\/\*-electron-|\/nix\/store\/\*-xorg-server-/,
    `${filename} must not carry a private discovery copy`,
  );
}

function assertUsesSharedWindowsPortableSetup(filename, source) {
  if (!/process\.platform === ['"]win32['"]/.test(source)) return;
  const adHocPortablePattern =
    /function\s+findPortableArtifact|readFileSync\([^)]*package\.json|copyFileSync\([^)]*portable|KYUTXO-\$\{[^}]+\}-Portable\.exe|const\s*\{\s*PORTABLE_EXECUTABLE_DIR[^}]*\}\s*=\s*process\.env/;
  if (!/prepareWindowsPortableLaunch/.test(source)) {
    assert.doesNotMatch(
      source,
      adHocPortablePattern,
      `${filename} must use the shared Windows portable launch helper instead of ad hoc discovery or copying`,
    );
    return;
  }
  assert.match(
    source,
    /import\s*\{[\s\S]*prepareWindowsPortableLaunch[\s\S]*\}\s*from\s*['"]\.\/packaged-windows-portable\.mjs['"]/,
    `${filename} must import the shared Windows portable launch helper`,
  );
  assert.match(
    source,
    /prepareWindowsPortableLaunch\s*\(\s*\{/,
    `${filename} must prepare its Windows portable launch through the shared helper`,
  );
  assert.doesNotMatch(
    source,
    adHocPortablePattern,
    `${filename} must not carry ad hoc Windows portable artifact discovery or copying`,
  );
}

test('all packaged browser checks use the shared binary discovery module', () => {
  const filenames = discoverPackagedBrowserChecks(fs.readdirSync(SCRIPTS_DIR));
  assert.ok(filenames.length > 0, 'must discover packaged browser checks');

  for (const filename of filenames) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, filename), 'utf8');
    assertUsesSharedBinaryDiscovery(filename, source);
  }
});

test('a newly added packaged browser check cannot escape shared discovery assertions', () => {
  const filename = 'check-packaged-future-feature-browser.mjs';
  assert.deepEqual(discoverPackagedBrowserChecks([filename]), [filename]);
  assert.throws(
    () => assertUsesSharedBinaryDiscovery(
      filename,
      "function findNixBinary() { return '/nix/store/*-electron-private/bin/electron'; }\n",
    ),
    /check-packaged-future-feature-browser\.mjs must import the shared discovery helper/,
  );
});

test('all Windows packaged browser checks use the shared portable launch setup', () => {
  const filenames = discoverPackagedBrowserChecks(fs.readdirSync(SCRIPTS_DIR));
  for (const filename of filenames) {
    assertUsesSharedWindowsPortableSetup(
      filename,
      fs.readFileSync(path.join(SCRIPTS_DIR, filename), 'utf8'),
    );
  }
});

test('a future Windows packaged check cannot restore ad hoc portable discovery', () => {
  assert.throws(
    () => assertUsesSharedWindowsPortableSetup(
      'check-packaged-future-feature-browser.mjs',
      [
        "const IS_WINDOWS = process.platform === 'win32';",
        "const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;",
        'fs.copyFileSync(portableArtifact, launchExecutable);',
      ].join('\n'),
    ),
    /must use the shared Windows portable launch helper instead of ad hoc discovery or copying/,
  );
});

test('shared Windows portable lookup rejects missing, empty, and stale artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(SCRIPTS_DIR, '.portable-helper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, 'release');
  const asarPath = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}');
  fs.writeFileSync(asarPath, 'asar');

  assert.throws(
    () => findWindowsPortableArtifact({ root, asarPath, tag: '[test]' }),
    /generated portable artifact is missing or empty.*KYUTXO-1\.2\.3-Portable\.exe/,
  );
  const artifactPath = path.join(releaseDir, 'KYUTXO-1.2.3-Portable.exe');
  fs.writeFileSync(artifactPath, '');
  assert.throws(
    () => findWindowsPortableArtifact({ root, asarPath, tag: '[test]' }),
    /missing or empty/,
  );
  fs.writeFileSync(artifactPath, 'portable');
  const old = new Date(Date.now() - 10_000);
  const fresh = new Date();
  fs.utimesSync(artifactPath, old, old);
  fs.utimesSync(asarPath, fresh, fresh);
  assert.throws(
    () => findWindowsPortableArtifact({ root, asarPath, tag: '[test]' }),
    /portable artifact predates the validated app\.asar/,
  );
});

test('shared Windows portable verification binds embedded app.asar bytes to the validated package', (t) => {
  const root = fs.mkdtempSync(path.join(SCRIPTS_DIR, '.portable-integrity-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, 'KYUTXO-1.2.3-Portable.exe');
  const asarPath = path.join(root, 'validated', 'app.asar');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'fresh portable timestamp is not evidence');
  fs.writeFileSync(asarPath, 'validated bundle');

  const extractArchive = (archive, outputDir) => {
    if (archive === artifactPath) {
      fs.mkdirSync(path.join(outputDir, '$PLUGINSDIR'), { recursive: true });
      fs.writeFileSync(path.join(outputDir, '$PLUGINSDIR', 'app-64.7z'), 'archive');
      return;
    }
    fs.mkdirSync(path.join(outputDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'resources', 'app.asar'), 'validated bundle');
  };
  const result = verifyWindowsPortableBundle({
    artifactPath,
    asarPath,
    tag: '[test]',
    extractArchive,
  });
  assert.equal(result.embeddedDigest, result.validatedDigest);

  const mismatchedExtract = (archive, outputDir) => {
    extractArchive(archive, outputDir);
    if (archive !== artifactPath) {
      fs.writeFileSync(path.join(outputDir, 'resources', 'app.asar'), 'different build');
    }
  };
  assert.throws(
    () => verifyWindowsPortableBundle({
      artifactPath,
      asarPath,
      tag: '[test]',
      extractArchive: mismatchedExtract,
    }),
    /portable bundle integrity check failed: embedded app\.asar SHA-256 .* does not match validated app\.asar .*rebuild Portable\.exe/,
  );
});

test('shared Windows launch setup copies the fresh artifact and strips inherited portable state', (t) => {
  const root = fs.mkdtempSync(path.join(SCRIPTS_DIR, '.portable-helper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, 'release');
  const asarPath = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
  const artifactPath = path.join(releaseDir, 'KYUTXO-1.2.3-Portable.exe');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}');
  fs.writeFileSync(asarPath, 'asar');
  fs.writeFileSync(artifactPath, 'portable bytes');

  const setup = prepareWindowsPortableLaunch({
    root,
    asarPath,
    home,
    tag: '[test]',
    env: { KEEP_ME: 'yes', PORTABLE_EXECUTABLE_DIR: 'C:\\stale' },
    verifyBundle: () => {},
  });
  assert.equal(fs.readFileSync(setup.executable, 'utf8'), 'portable bytes');
  assert.equal(setup.launchDir, path.join(home, 'portable-launch'));
  assert.equal(setup.env.PORTABLE_EXECUTABLE_DIR, undefined);
  assert.equal(setup.env.KEEP_ME, 'yes');
  assert.equal(setup.env.USERPROFILE, home);
  assert.equal(setup.env.TEMP, path.join(home, 'temp'));
});

test('release and validation registrations enforce packaged browser check filenames', () => {
  assertRegisteredPackagedCheckNames({
    'scripts/electron-build.sh': fs.readFileSync(
      path.join(SCRIPTS_DIR, 'electron-build.sh'),
      'utf8',
    ),
    '.github/workflows/build.yml': fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'build.yml'),
      'utf8',
    ),
    '.replit': fs.readFileSync(path.join(ROOT, '.replit'), 'utf8'),
  });
});

test('every packaged browser check has an explicit release, validation, or manual policy', () => {
  assertPackagedBrowserCheckRegistrationPolicy({
    discoveredChecks: discoverPackagedBrowserChecks(fs.readdirSync(SCRIPTS_DIR)),
    releaseSources: {
      'scripts/electron-build.sh': fs.readFileSync(
        path.join(SCRIPTS_DIR, 'electron-build.sh'),
        'utf8',
      ),
      '.github/workflows/build.yml': fs.readFileSync(
        path.join(ROOT, '.github', 'workflows', 'build.yml'),
        'utf8',
      ),
    },
    validationSources: {
      '.replit': fs.readFileSync(path.join(ROOT, '.replit'), 'utf8'),
    },
  });
});

test('a newly added packaged browser check cannot remain orphaned', () => {
  assert.throws(
    () => assertPackagedBrowserCheckRegistrationPolicy({
      discoveredChecks: ['check-packaged-future-feature-browser.mjs'],
      releaseSources: { release: '' },
      validationSources: { validation: '' },
      manualChecks: new Map(),
    }),
    /orphaned packaged browser check\(s\): check-packaged-future-feature-browser\.mjs.*Register each check in scripts\/electron-build\.sh.*\.replit/s,
  );
});

test('a .replit workflow only counts when it is marked as validation', () => {
  assert.throws(
    () => assertPackagedBrowserCheckRegistrationPolicy({
      discoveredChecks: ['check-packaged-future-feature-browser.mjs'],
      releaseSources: { release: '' },
      validationSources: {
        '.replit': [
          '[[workflows.workflow]]',
          'name = "future-feature"',
          'args = "node scripts/check-packaged-future-feature-browser.mjs"',
          '[workflows.workflow.metadata]',
          'isValidation = false',
        ].join('\n'),
      },
      manualChecks: new Map(),
    }),
    /orphaned packaged browser check\(s\): check-packaged-future-feature-browser\.mjs/,
  );
});

test('manual packaged browser checks require a narrow documented classification', () => {
  assert.throws(
    () => assertPackagedBrowserCheckRegistrationPolicy({
      discoveredChecks: ['check-packaged-future-feature-browser.mjs'],
      releaseSources: { release: '' },
      validationSources: { validation: '' },
      manualChecks: new Map([
        ['check-packaged-future-feature-browser.mjs', 'manual'],
      ]),
    }),
    /must document a specific reason/,
  );
});

test('rejects an unconventional newly registered packaged browser check without launching it', () => {
  assert.throws(
    () => assertRegisteredPackagedCheckNames({
      fixture: [
        '- name: Verify future packaged Electron browser behavior',
        '  run: node scripts/check-future-packaged-electron.mjs',
      ].join('\n'),
    }),
    /fixture registers unrecognized packaged check check-future-packaged-electron\.mjs; .*check-packaged-\*-browser\.mjs/,
  );
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
  assert.match(source, /prepareWindowsPortableLaunch/);
  assert.match(source, /--use-fake-device-for-media-stream/);
  assert.doesNotMatch(source, new RegExp('--use-fake-' + 'ui-for-media-stream'));
  assert.match(source, /portableSetup\.executable/);
  assert.match(source, /portableSetup\.launchDir/);
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

test('the packaged wrong-password gate avoids relaunch and blocks desktop releases', () => {
  const source = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-wrong-password-browser.mjs'),
    'utf8',
  );
  const releaseWorkflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'build.yml'),
    'utf8',
  );

  assert.match(source, /process\.platform === 'win32'/);
  assert.match(source, /IS_WINDOWS \? 'win-unpacked' : 'linux-unpacked'/);
  assert.match(source, /IS_WINDOWS \? 'KYUTXO\.exe' : 'kyutxo'/);
  assert.match(source, /APPDATA: path\.join\(tmpHome, 'AppData', 'Roaming'\)/);
  assert.match(source, /LOCALAPPDATA: path\.join\(tmpHome, 'AppData', 'Local'\)/);
  assert.match(source, /delete inheritedEnv\.PORTABLE_EXECUTABLE_DIR/);
  assert.match(source, /USERPROFILE:\s*tmpHome/);
  assert.match(source, /taskkill', \['\/PID', String\(child\.pid\), '\/T', '\/F'\]/);
  assert.match(source, /waitForPackagedCdpDown\(cdpPort, 30_000\)/);
  assert.match(source, /waitForOwnedPackagedCdp/);
  assert.match(source, /packagedCdpLaunchArgs\(cdpUserDataDir\)/);
  assert.match(source, /getByTestId\('button-logout'\)\.click\(\)/);
  assert.match(source, /getByTestId\('text-error'\)/);
  assert.match(source, /errorText === 'Incorrect password'/);
  assert.doesNotMatch(source, /child = launchApp[\s\S]*child = launchApp/);
  assert.match(
    releaseWorkflow,
    /- name: Verify packaged wrong-password lock handling\s+env:\s+KYUTXO_PACKAGED_SKIP_BUILD: '1'\s+run: node scripts\/check-packaged-wrong-password-browser\.mjs/,
  );
});

test('the packaged network activity forced shutdown cannot become graceful', () => {
  const source = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-network-privacy-activity-browser.mjs'),
    'utf8',
  );
  const forcedHelper = source.match(
    /async function forceStopPackagedProcess\(child\) \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;
  assert.match(source, /path\.join\(portableSetup\.launchDir, 'KYUTXO_Data'\)/);
  assert.match(
    source,
    /fs\.rmSync\(tempHome, \{ recursive: true, force: true, maxRetries: 10, retryDelay: 250 \}\)/,
    'Windows cleanup must tolerate delayed executable handle release',
  );
  assert.ok(forcedHelper, 'forced shutdown helper must remain independently testable in source');

  assert.match(
    forcedHelper,
    /if \(IS_WINDOWS\) \{\s*killWindowsProcessTree\(child, true\);\s*return;/,
    'Windows forced shutdown must use the forced process-tree branch',
  );
  assert.match(
    source,
    /const args = \['\/PID', String\(child\.pid\), '\/T'\];\s*if \(force\) args\.push\('\/F'\);/,
    'Windows forced shutdown must pass both /T and /F to taskkill',
  );
  assert.match(
    forcedHelper,
    /process\.kill\(-child\.pid, 'SIGKILL'\)/,
    'POSIX forced shutdown must SIGKILL the detached process group',
  );
  assert.doesNotMatch(
    forcedHelper,
    /SIGTERM|browser\.close|page\.close/,
    'forced shutdown must not send SIGTERM or close CDP',
  );

  const forcedScenario = source.match(
    /\/\/ Do not close CDP first or send SIGTERM:(?<body>[\s\S]*?)if \(!\(await waitForPackagedCdpDown/,
  )?.groups?.body;
  assert.ok(forcedScenario, 'forced termination scenario must retain its explicit ordering guard');
  assert.match(forcedScenario, /await forceStopPackagedProcess\(child\)/);
  assert.doesNotMatch(
    forcedScenario,
    /browser\.close|page\.close|stopPackagedProcess|SIGTERM/,
    'the forced scenario must terminate before any graceful CDP or process shutdown',
  );
});

test('the packaged network activity relaunch rejects stale CDP ownership before connecting', () => {
  const source = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-network-privacy-activity-browser.mjs'),
    'utf8',
  );
  const relaunchScenario = source.match(
    /const abruptlyTerminatedCdp = cdp;(?<body>[\s\S]*?)browser = await chromium\.connectOverCDP/,
  )?.groups?.body;
  assert.ok(relaunchScenario, 'forced relaunch must retain the abruptly terminated CDP ownership');
  assert.match(
    relaunchScenario,
    /waitForPackagedCdpDown\(abruptlyTerminatedCdp\.port, 30_000\)/,
    'forced relaunch must prove the prior endpoint is unavailable',
  );
  assert.match(
    relaunchScenario,
    /clearPackagedCdpOwnership\(cdpUserDataDir\)[\s\S]*launchPackagedProcess\(\)/,
    'forced relaunch must clear stale ownership only after shutdown and before same-profile launch',
  );
  assert.match(
    relaunchScenario,
    /assert\.notEqual\(\s*cdp\.browserPath,\s*abruptlyTerminatedCdp\.browserPath,[\s\S]*reused stale packaged CDP ownership file\/token/,
    'forced relaunch must reject reuse of the prior browser ownership token',
  );

  const freshOwnershipIndex = relaunchScenario.indexOf('assert.notEqual(');
  const connectIndex = source.indexOf(
    'browser = await chromium.connectOverCDP',
    source.indexOf('const abruptlyTerminatedCdp = cdp;'),
  );
  assert.ok(freshOwnershipIndex >= 0, 'fresh ownership assertion must exist');
  assert.ok(
    source.indexOf('const abruptlyTerminatedCdp = cdp;') + freshOwnershipIndex < connectIndex,
    'fresh ownership must be asserted before Playwright connects to the relaunched process',
  );
  assert.match(
    source,
    /activityRows\.nth\(activity\.length\)\.waitFor\(\{ state: 'visible' \}\)[\s\S]*await activityRows\.count\(\)/,
    'activity labels must be checked only after every asynchronously queried row renders',
  );
  assert.doesNotMatch(
    source,
    /indexedDB\.open\('KYUTXODatabase'\)/,
    'packaged activity persistence must not be seeded through the obsolete IndexedDB mirror',
  );
  assert.match(source, /repository\.saveBatch\('networkPrivacyActivity', activity\)/);
  assert.match(source, /repository\.page\('networkPrivacyActivity', after, 1000, 'asc'\)/);
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
  assert.match(script, /prepareWindowsPortableLaunch/);
  assert.match(script, /path\.join\(portableSetup\.launchDir, 'KYUTXO_Data'\)/);
  assert.match(script, /waitForPackagedCdpDown\(cdpPort, 30_000\)/);
  assert.match(script, /maxRetries: 10, retryDelay: 250/);
  assert.match(script, /portable launch copy/);
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

test('the forgotten-source gate launches the copied Windows portable artifact and is release-wired', () => {
  const script = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-forgotten-network-source-browser.mjs'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'build.yml'),
    'utf8',
  );
  const buildScript = fs.readFileSync(path.join(SCRIPTS_DIR, 'electron-build.sh'), 'utf8');

  assert.match(script, /prepareWindowsPortableLaunch/);
  assert.match(script, /path\.join\(portableSetup\.launchDir, 'KYUTXO_Data'\)/);
  assert.match(script, /waitForPackagedCdpDown\(cdp\.port, 30_000\)/);
  assert.match(script, /maxRetries: 10, retryDelay: 250/);
  assert.match(script, /cwd: IS_WINDOWS \? portableSetup\.launchDir : home/);
  assert.match(script, /window\.location\.hash = '\/node-settings'/);
  assert.match(script, /getByRole\('heading', \{ name: 'Node Connection' \}\)\.waitFor/);
  assert.match(script, /seedConfiguredSourcePrecondition\(page\)/);
  assert.match(script, /id: 'default'/);
  assert.match(script, /networkPrivacyMode: 'own-node'/);
  assert.match(script, /getByTestId\('button-save-settings'\)\.click\(\)/);
  assert.match(script, /repository\.save\('nodeSettings'/);
  assert.match(script, /protectedStore\.lock\(\)/);
  assert.match(script, /readProtectedNodeSettings\(page\)/);
  assert.match(script, /providerType: retainedSettings\?\.providerType/);
  assert.doesNotMatch(script, /provider: retainedSettings\?\.provider/);
  assert.match(script, /waitForFunction\(\(\) => window\.location\.hash === '#\/'\)/);
  assert.doesNotMatch(script, /import\('\/src\/lib\/data\/node-settings-crud\.ts'\)/);
  assert.doesNotMatch(script, /page\.goto\('kyutxo-app:\/\/bundle\/#\/node-settings'\)/);
  assert.doesNotMatch(script, /path\.join\(UNPACKED_DIR, 'KYUTXO\.exe'\)/);
  assert.doesNotMatch(script, /'--dir',\s+IS_WINDOWS \? '--win'/);
  assert.match(
    workflow,
    /- name: Verify forgotten source stays offline in Windows portable app\s+env:\s+KYUTXO_PACKAGED_SKIP_BUILD: '1'\s+run: node scripts\/check-packaged-forgotten-network-source-browser\.mjs/,
  );
  assert.match(
    buildScript,
    /KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts\/check-packaged-forgotten-network-source-browser\.mjs/,
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
  assert.match(script, /prepareWindowsPortableLaunch/);
  assert.match(script, /path\.join\(portableSetup\.launchDir, 'KYUTXO_Data'\)/);
  assert.match(
    workflow,
    /- name: Verify Coin Origins wallet-scoped counts through packaged IPC\s+env:\s+KYUTXO_PACKAGED_SKIP_BUILD: '1'\s+run: node scripts\/check-packaged-coin-origins-browser\.mjs/,
  );
  assert.match(
    buildScript,
    /KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts\/check-packaged-coin-origins-browser\.mjs/,
  );
});

test('the packaged protected-vault gate waits for CDP shutdown before cleanup', () => {
  const script = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-vault-migration-browser.mjs'),
    'utf8',
  );
  assert.match(script, /waitForPackagedCdpDown\(cdpPort, 30_000\)/);
  assert.match(script, /maxRetries: 10, retryDelay: 250/);
  assert.match(script, /function readFileWithTransientRetries/);
  assert.match(script, /\['EBUSY', 'EPERM', 'EACCES'\]/);
  assert.match(script, /const bytes = readFileWithTransientRetries\(absolutePath\)/);
  assert.match(script, /for \(const scenario of PROTECTED_VAULT_SCENARIOS\) \{\s+const page = await startPackagedApp\(\)/);
  assert.match(script, /await stopPackagedApp\(\);\s+const scan = scanDisposableProfile\(tempHome\)/);
});