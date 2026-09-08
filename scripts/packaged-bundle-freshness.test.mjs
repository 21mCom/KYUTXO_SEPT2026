// Offline tests for the packaged-bundle-freshness guard (task 1960).
//
// scripts/packaged-bundle-freshness.mjs is the only thing standing between
// packaged checks and months-stale renderer bundles (task 1925). These tests
// exercise the real assertPackagedBundleFresh() against fixture project trees
// (via its `root` option) so a refactor that breaks the tree walk, the
// index-*.js glob, or the skip rules can't silently disable the protection.
//
// Run with: node --test scripts/packaged-bundle-freshness.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPackagedBundleFresh,
  assertPackagedAsarFresh,
  repoRootFromModuleUrl,
  ROOT as FRESHNESS_ROOT,
} from './packaged-bundle-freshness.mjs';
import { writePackagedBuildProvenance } from './packaged-build-provenance.mjs';

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const OLD = NOW - 24 * HOUR; // "source built a day ago"
const BUNDLE_TIME = NOW - 12 * HOUR; // bundle built after OLD sources
const NEW = NOW - 1 * HOUR; // newer than the bundle

function writeFileAt(root, relPath, mtimeMs, contents = '// fixture') {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  const t = new Date(mtimeMs);
  fs.utimesSync(full, t, t);
  return full;
}

/**
 * Builds a minimal fixture project tree: OLD renderer sources plus a bundle
 * built at BUNDLE_TIME. Returns the fixture root; caller mutates from there.
 */
function makeFixtureRoot({ withBundle = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-freshness-test-'));
  writeFileAt(root, 'client/src/App.tsx', OLD);
  writeFileAt(root, 'client/src/pages/deep/Nested.tsx', OLD);
  writeFileAt(root, 'client/index.html', OLD);
  writeFileAt(root, 'shared/schema.ts', OLD);
  writeFileAt(root, 'vite.config.ts', OLD);
  if (withBundle) {
    writeFileAt(root, 'dist/public/assets/index-abc123.js', BUNDLE_TIME);
  }
  return root;
}

function withFixture(opts, fn) {
  if (typeof opts === 'function') {
    fn = opts;
    opts = undefined;
  }
  const root = makeFixtureRoot(opts);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('passes when the bundle is newer than every renderer source', () => {
  withFixture((root) => {
    const result = assertPackagedBundleFresh({ root, tag: '[test]' });
    assert.ok(result.bundle.mtimeMs >= result.source.mtimeMs);
    assert.match(path.basename(result.bundle.file), /^index-.*\.js$/);
  });
});

test('fails when a client/src file is newer than the bundle', () => {
  withFixture((root) => {
    writeFileAt(root, 'client/src/pages/deep/Nested.tsx', NEW);
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /STALE BUNDLE.*Nested\.tsx/s,
    );
  });
});

test('fails when a shared/ file is newer than the bundle', () => {
  withFixture((root) => {
    writeFileAt(root, 'shared/schema.ts', NEW);
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /STALE BUNDLE.*schema\.ts/s,
    );
  });
});

test('fails when client/index.html is newer than the bundle', () => {
  withFixture((root) => {
    writeFileAt(root, 'client/index.html', NEW);
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /STALE BUNDLE.*index\.html/s,
    );
  });
});

test('fails when vite.config.ts is newer than the bundle', () => {
  withFixture((root) => {
    writeFileAt(root, 'vite.config.ts', NEW);
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /STALE BUNDLE.*vite\.config\.ts/s,
    );
  });
});

test('fails when no dist/public/assets/index-*.js bundle exists', () => {
  withFixture({ withBundle: false }, (root) => {
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /no dist\/public\/assets\/index-\*\.js bundle found/,
    );
  });
});

test('ignores non-index assets when looking for the bundle', () => {
  withFixture({ withBundle: false }, (root) => {
    writeFileAt(root, 'dist/public/assets/vendor-xyz.js', NEW);
    writeFileAt(root, 'dist/public/assets/index-styles.css', NEW);
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /no dist\/public\/assets\/index-\*\.js bundle found/,
    );
  });
});

test('excludes node_modules, dist, release, .git and dot-dirs from the source scan', () => {
  withFixture((root) => {
    // All of these are NEWER than the bundle but must not trip the guard.
    writeFileAt(root, 'client/src/node_modules/pkg/index.js', NEW);
    writeFileAt(root, 'shared/node_modules/pkg/index.js', NEW);
    writeFileAt(root, 'client/src/dist/out.js', NEW);
    writeFileAt(root, 'client/src/release/out.js', NEW);
    writeFileAt(root, 'shared/.git/HEAD', NEW);
    writeFileAt(root, 'client/src/.cache/tmp.js', NEW);
    writeFileAt(root, 'client/src/.hidden-file.ts', NEW);
    const result = assertPackagedBundleFresh({ root, tag: '[test]' });
    assert.ok(result.bundle.mtimeMs >= result.source.mtimeMs);
  });
});

test('newest excluded-dir mtime never wins over real sources in the failure message', () => {
  withFixture((root) => {
    writeFileAt(root, 'client/src/node_modules/pkg/index.js', NOW);
    writeFileAt(root, 'client/src/RealSource.tsx', NEW);
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      (err) => {
        assert.match(err.message, /STALE BUNDLE/);
        assert.match(err.message, /RealSource\.tsx/);
        assert.doesNotMatch(err.message, /node_modules/);
        return true;
      },
    );
  });
});

test('fails when no renderer source files exist at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-freshness-test-'));
  try {
    writeFileAt(root, 'dist/public/assets/index-abc123.js', BUNDLE_TIME);
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /could not find any renderer source files/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('newest source across multiple roots is compared, not just the first root', () => {
  withFixture((root) => {
    // client/src stays old; only shared/ has the newest file.
    writeFileAt(root, 'shared/deep/nested/util.ts', NEW);
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /STALE BUNDLE.*util\.ts/s,
    );
  });
});

test('picks the newest index-*.js when several bundles exist', () => {
  withFixture((root) => {
    // An ancient leftover bundle must not make the check fail when a fresh
    // one is present alongside it.
    writeFileAt(root, 'dist/public/assets/index-old111.js', OLD - 48 * HOUR);
    writeFileAt(root, 'client/src/App.tsx', OLD);
    const result = assertPackagedBundleFresh({ root, tag: '[test]' });
    assert.match(path.basename(result.bundle.file), /index-abc123\.js/);
  });
});

// ── assertPackagedAsarFresh (task 1959 stale-asar guard; task 1983 tests) ────
//
// A KYUTXO_PACKAGED_SKIP_BUILD=1 run reuses release/.../app.asar, which also
// carries the MAIN PROCESS (electron/**) — these tests keep the guard honest
// against fixture trees, and the static checks below keep it WIRED into the
// three packaged check scripts' skip-build paths.

/** Fixture with electron/ + dist/public inputs at OLD and an asar at asarTime. */
function makeAsarFixture({ asarTime = BUNDLE_TIME, withAsar = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-freshness-test-'));
  writeFileAt(root, 'electron/main.cjs', OLD);
  writeFileAt(root, 'electron/engine/engine-worker.bundle.cjs', OLD);
  writeFileAt(root, 'dist/public/assets/index-abc123.js', OLD);
  const asarPath = path.join(root, 'release', 'linux-unpacked', 'resources', 'app.asar');
  if (withAsar) writeFileAt(root, path.relative(root, asarPath), asarTime, 'asar-bytes');
  return { root, asarPath };
}

function withAsarFixture(opts, fn) {
  if (typeof opts === 'function') {
    fn = opts;
    opts = undefined;
  }
  const { root, asarPath } = makeAsarFixture(opts);
  try {
    return fn(root, asarPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('asar guard passes when the asar is newer than electron/ and dist/public', () => {
  withAsarFixture((root, asarPath) => {
    const result = assertPackagedAsarFresh({ root, asarPath, tag: '[test]' });
    assert.equal(result.asar.file, asarPath);
    assert.ok(result.asar.mtimeMs >= result.source.mtimeMs);
  });
});

test('asar guard fails when an electron/ main-process file is newer than the asar', () => {
  withAsarFixture((root, asarPath) => {
    writeFileAt(root, 'electron/main.cjs', NEW);
    assert.throws(
      () => assertPackagedAsarFresh({ root, asarPath, tag: '[test]' }),
      /STALE ASAR.*main\.cjs/s,
    );
  });
});

test('asar guard fails when dist/public is newer than the asar', () => {
  withAsarFixture((root, asarPath) => {
    writeFileAt(root, 'dist/public/assets/index-abc123.js', NEW);
    assert.throws(
      () => assertPackagedAsarFresh({ root, asarPath, tag: '[test]' }),
      /STALE ASAR.*index-abc123\.js/s,
    );
  });
});

test('asar guard fails clearly when the asar is missing', () => {
  withAsarFixture({ withAsar: false }, (root, asarPath) => {
    assert.throws(
      () => assertPackagedAsarFresh({ root, asarPath, tag: '[test]' }),
      /asar not found.*run electron-builder/s,
    );
  });
});

test('asar guard requires an asarPath', () => {
  withAsarFixture((root) => {
    assert.throws(() => assertPackagedAsarFresh({ root, tag: '[test]' }), /requires an asarPath/);
  });
});

test('asar guard fails when there are no electron/ or dist/public inputs to compare', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-freshness-test-'));
  try {
    const asarPath = path.join(root, 'app.asar');
    writeFileAt(root, 'app.asar', BUNDLE_TIME, 'asar-bytes');
    assert.throws(
      () => assertPackagedAsarFresh({ root, asarPath, tag: '[test]' }),
      /could not find any files under electron\/ or dist\/public/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asar guard ignores dot-dirs and skip-dirs under electron/', () => {
  withAsarFixture((root, asarPath) => {
    writeFileAt(root, 'electron/node_modules/pkg/index.js', NEW);
    writeFileAt(root, 'electron/.cache/tmp.js', NEW);
    const result = assertPackagedAsarFresh({ root, asarPath, tag: '[test]' });
    assert.ok(result.asar.mtimeMs >= result.source.mtimeMs);
  });
});

// ── Static wiring checks (task 1983): the three packaged check scripts must
// keep calling assertPackagedAsarFresh in their KYUTXO_PACKAGED_SKIP_BUILD
// reuse paths. A refactor that drops the call would silently test stale
// main-process code again. Pattern: scripts/check-engine-bridge-shared.test.mjs.
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_CHECK_SCRIPTS = [
  'check-packaged-wrong-password-browser.mjs',
  'check-packaged-electron-browser.mjs',
  'check-packaged-electrum-cancel-browser.mjs',
  'check-packaged-native-engine.mjs',
];

for (const script of PACKAGED_CHECK_SCRIPTS) {
  test(`${script} imports assertPackagedAsarFresh and calls it in its skip-build path`, () => {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, script), 'utf8');

    // Imported from the shared module (not copy-pasted).
    assert.match(
      source,
      /import\s*\{[^}]*\bassertPackagedAsarFresh\b[^}]*\}\s*from\s*['"]\.\/packaged-bundle-freshness\.mjs['"]/,
      `${script} must import assertPackagedAsarFresh from ./packaged-bundle-freshness.mjs`,
    );

    // Called inside the KYUTXO_PACKAGED_SKIP_BUILD reuse branch: the call must
    // appear between the skip-build env check and the end of that early-return
    // block (the first `return;` after it).
    const skipIdx = source.indexOf('KYUTXO_PACKAGED_SKIP_BUILD');
    assert.ok(skipIdx !== -1, `${script} must have a KYUTXO_PACKAGED_SKIP_BUILD reuse path`);
    const returnIdx = source.indexOf('return;', skipIdx);
    assert.ok(returnIdx !== -1, `${script}: skip-build branch must end with an early return`);
    const branch = source.slice(skipIdx, returnIdx);
    assert.match(
      branch,
      /assertPackagedAsarFresh\s*\(\s*\{[^}]*asarPath\s*:/s,
      `${script} must call assertPackagedAsarFresh({ ..., asarPath: ... }) in its skip-build reuse path`,
    );
    // The bundle-freshness guard must stay alongside it.
    assert.match(
      branch,
      /assertPackagedBundleFresh\s*\(/,
      `${script} must also keep assertPackagedBundleFresh in its skip-build reuse path`,
    );
  });
}

// ── Windows-safe root derivation (task 2017) ────────────────────────────────
//
// The module used to compute ROOT via `new URL(import.meta.url).pathname`,
// which on Windows is `/D:/a/.../scripts/x.mjs`; path.win32.resolve mangles
// that into `\\D:\a\repo`, readdirSync throws (silently caught), and the guard
// reported "no dist/public/assets/index-*.js bundle found" on windows-2022
// even though vite had just emitted the bundle. These tests pin the
// fileURLToPath-based derivation so a refactor back to a platform-naive
// pathname derivation fails the suite on any OS.

test('repoRootFromModuleUrl handles a win32-style /D:/... module URL without UNC mangling', () => {
  const winUrl = 'file:///D:/a/KYUTXO/repo/scripts/packaged-bundle-freshness.mjs';
  const root = repoRootFromModuleUrl(winUrl);
  assert.ok(path.isAbsolute(root), `derived root must be absolute, got ${root}`);
  // The exact failure mode: a leading `\\D:` UNC-ish path that readdirSync
  // rejects on Windows. Never acceptable, on any platform.
  assert.ok(
    !root.startsWith('\\\\'),
    `derived root must not be UNC-ish (the win32 breakage), got ${root}`,
  );
  if (process.platform === 'win32') {
    // Drive-absolute, e.g. D:\a\KYUTXO\repo — not /D:/... and not \\D:\...
    assert.match(root, /^D:[\\/]/i);
    assert.match(root.replace(/\\/g, '/'), /\/repo$/);
  } else {
    assert.equal(root, path.resolve('/D:/a/KYUTXO/repo'));
  }
});

test('repoRootFromModuleUrl agrees with the naive derivation on POSIX paths', () => {
  const posixUrl = 'file:///home/runner/repo/scripts/packaged-bundle-freshness.mjs';
  assert.equal(repoRootFromModuleUrl(posixUrl), path.resolve('/home/runner/repo'));
});

test('the module default ROOT is the real repo root and contains repo landmarks', () => {
  const expected = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(FRESHNESS_ROOT, expected);
  for (const landmark of ['package.json', 'vite.config.ts', 'scripts', 'client', 'shared']) {
    assert.ok(
      fs.existsSync(path.join(FRESHNESS_ROOT, landmark)),
      `default ROOT must contain ${landmark} (got ROOT=${FRESHNESS_ROOT})`,
    );
  }
});

test('verified provenance survives cross-job timestamp changes and rejects changed bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-provenance-test-'));
  const revision = 'a'.repeat(40);
  const previousProvenance = process.env.KYUTXO_PACKAGED_PROVENANCE;
  const previousSha = process.env.GITHUB_SHA;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileAt(root, 'client/src/App.tsx', NEW, '// checkout extracted after package');
    writeFileAt(root, 'electron/main.cjs', NEW, '// checkout extracted after package');
    writeFileAt(root, 'dist/public/assets/index-built.js', OLD, '// verified renderer');
    const asarPath = writeFileAt(
      root,
      'release/win-unpacked/resources/app.asar',
      OLD,
      'verified asar',
    );
    writeFileAt(root, 'release/KYUTXO-1.2.3-Portable.exe', OLD, 'verified executable');
    const { outputPath } = writePackagedBuildProvenance({ root, revision });
    process.env.KYUTXO_PACKAGED_PROVENANCE = path.relative(root, outputPath);
    process.env.GITHUB_SHA = revision;

    assert.doesNotThrow(() => assertPackagedBundleFresh({ root, tag: '[test]' }));
    assert.doesNotThrow(() => assertPackagedAsarFresh({ root, asarPath, tag: '[test]' }));

    fs.appendFileSync(path.join(root, 'dist/public/assets/index-built.js'), 'tampered');
    assert.throws(
      () => assertPackagedBundleFresh({ root, tag: '[test]' }),
      /renderer bytes do not match verified provenance/,
    );
  } finally {
    if (previousProvenance === undefined) delete process.env.KYUTXO_PACKAGED_PROVENANCE;
    else process.env.KYUTXO_PACKAGED_PROVENANCE = previousProvenance;
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
