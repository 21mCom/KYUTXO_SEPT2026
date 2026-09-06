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
} from './packaged-windows-portable.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPTS_DIR);
const PACKAGED_NON_BROWSER_CHECKS = new Set([
  // These validate packaged internals without launching a renderer under
  // Electron/Xvfb, so the browser-check filename convention does not apply.
  'check-packaged-native-engine.mjs',
  'check-packaged-vault-lock-native.mjs',
]);
const PACKAGED_BROWSER_CHECK_PATTERN = /^check-packaged-.+-browser\.mjs$/;
const MANUAL_PACKAGED_BROWSER_CHECKS = new Map([
  [
    'check-packaged-wrong-password-browser.mjs',
    'Manual regression reproduction: its single-session lock/unlock flow is intentionally excluded from release automation because packaged relaunch state is unreliable.',
  ],
]);

function discoverPackagedBrowserChecks(filenames) {
  return filenames
    .filter((filename) => PACKAGED_BROWSER_CHECK_PATTERN.test(filename))
    .sort();
}

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

test('the packaged network activity forced shutdown cannot become graceful', () => {
  const source = fs.readFileSync(
    path.join(SCRIPTS_DIR, 'check-packaged-network-privacy-activity-browser.mjs'),
    'utf8',
  );
  const forcedHelper = source.match(
    /async function forceStopPackagedProcess\(child\) \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;
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
    /\/\/ Do not close CDP first or send SIGTERM:(?<body>[\s\S]*?)if \(!\(await waitForCdpDown/,
  )?.groups?.body;
  assert.ok(forcedScenario, 'forced termination scenario must retain its explicit ordering guard');
  assert.match(forcedScenario, /await forceStopPackagedProcess\(child\)/);
  assert.doesNotMatch(
    forcedScenario,
    /browser\.close|page\.close|stopPackagedProcess|SIGTERM/,
    'the forced scenario must terminate before any graceful CDP or process shutdown',
  );
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
  assert.match(script, /cwd: IS_WINDOWS \? portableSetup\.launchDir : home/);
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
  assert.match(
    workflow,
    /- name: Verify Coin Origins wallet-scoped counts through packaged IPC\s+env:\s+KYUTXO_PACKAGED_SKIP_BUILD: '1'\s+run: node scripts\/check-packaged-coin-origins-browser\.mjs/,
  );
  assert.match(
    buildScript,
    /KYUTXO_PACKAGED_SKIP_BUILD=1 node scripts\/check-packaged-coin-origins-browser\.mjs/,
  );
});