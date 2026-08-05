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

import { assertPackagedBundleFresh } from './packaged-bundle-freshness.mjs';

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
