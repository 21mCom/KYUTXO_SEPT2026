#!/usr/bin/env node
// Guard: every packaged-app check must use the shared bundle-freshness guard.
//
// WHY: `npm run build` has been observed to "succeed" without refreshing
// dist/public, so electron-builder packaged a MONTHS-stale renderer and the
// packaged checks tested pre-fix code (.agents/memory/stale-dev-bundle-e2e.md).
// scripts/packaged-bundle-freshness.mjs (task 1925/1959) fixes that — but only
// for scripts that actually call it. A NEW packaged check added without the
// call would silently reintroduce the stale-bundle failure mode. This guard
// fails fast when one does (pattern: scripts/check-engine-bridge-shared.js).
//
// Rules — for every scripts/check-*.{mjs,js} (excluding *.test.*) that does
// packaged verification (references KYUTXO_PACKAGED_SKIP_BUILD, an app.asar
// path, or invokes 'electron-builder'):
//   1. must import assertPackagedBundleFresh from './packaged-bundle-freshness.mjs'
//      and CALL assertPackagedBundleFresh(...)
//   2. if it has a KYUTXO_PACKAGED_SKIP_BUILD reuse path, it must also import
//      and CALL assertPackagedAsarFresh(...) (stale reused asar = stale main
//      process, see task 1959)
//   3. must NOT re-implement the guard inline (no local mtime comparison of
//      dist/public against client/src outside the shared module)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
// Test hook: the node --test suite points this at fixture directories so a
// broken regex can't silently pass everything.
const SCRIPTS_DIR =
  process.env.CHECK_PACKAGED_FRESHNESS_SCRIPTS_DIR || path.dirname(__filename);

const allCheckScripts = fs
  .readdirSync(SCRIPTS_DIR)
  .filter(
    (f) =>
      /^check-.*\.(mjs|js)$/.test(f) &&
      !/\.test\.(mjs|js)$/.test(f) &&
      // this guard's own source contains the marker patterns as regex literals
      f !== 'check-packaged-freshness-guard.js',
  )
  .sort();

// Markers of a packaged-app verification script. Kept deliberately concrete:
// - KYUTXO_PACKAGED_SKIP_BUILD env usage
// - an app.asar path (packaged output layout)
// - invoking electron-builder as a command ('electron-builder' as a quoted
//   standalone token — prose mentions inside longer strings don't match)
const PACKAGED_MARKERS = [
  /KYUTXO_PACKAGED_SKIP_BUILD/,
  /app\.asar/,
  /['"`]electron-builder['"`]/,
];

const IMPORT_RE =
  /import\s*\{[^}]*\bassertPackagedBundleFresh\b[^}]*\}\s*from\s*['"]\.\/packaged-bundle-freshness\.mjs['"]/;
const CALL_RE = /\bassertPackagedBundleFresh\s*\(/;
const ASAR_IMPORT_RE =
  /import\s*\{[^}]*\bassertPackagedAsarFresh\b[^}]*\}\s*from\s*['"]\.\/packaged-bundle-freshness\.mjs['"]/;
const ASAR_CALL_RE = /\bassertPackagedAsarFresh\s*\(/;
const SKIP_BUILD_RE = /KYUTXO_PACKAGED_SKIP_BUILD/;

function stripComments(src) {
  // Remove // line comments and /* */ block comments so documentation prose
  // (e.g. "run electron-builder first") can't trigger or satisfy the rules.
  // Quoted strings are left intact — the markers are quote-aware.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/[^\n]*/g, '$1');
}

const packagedChecks = [];
const failures = [];

for (const file of allCheckScripts) {
  const raw = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
  const src = stripComments(raw);
  if (!PACKAGED_MARKERS.some((re) => re.test(src))) continue;
  packagedChecks.push(file);

  if (!IMPORT_RE.test(src)) {
    failures.push({
      file,
      problem:
        "missing import: import { assertPackagedBundleFresh } from './packaged-bundle-freshness.mjs'; — packaged checks must share the freshness guard",
    });
  } else if (!CALL_RE.test(src)) {
    failures.push({
      file,
      problem:
        'imports assertPackagedBundleFresh but never calls it — call it after the build step (and in the KYUTXO_PACKAGED_SKIP_BUILD reuse path)',
    });
  }

  if (SKIP_BUILD_RE.test(src)) {
    if (!ASAR_IMPORT_RE.test(src)) {
      failures.push({
        file,
        problem:
          "has a KYUTXO_PACKAGED_SKIP_BUILD reuse path but does not import assertPackagedAsarFresh from './packaged-bundle-freshness.mjs' — a reused asar can carry a stale main process",
      });
    } else if (!ASAR_CALL_RE.test(src)) {
      failures.push({
        file,
        problem:
          'imports assertPackagedAsarFresh but never calls it — call it in every KYUTXO_PACKAGED_SKIP_BUILD reuse path',
      });
    }
  }
}

if (packagedChecks.length === 0) {
  console.error(
    'check-packaged-freshness-guard: no packaged check scripts found under scripts/ ' +
      '(expected at least check-packaged-electron-browser.mjs) — glob, markers, or layout changed?',
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(
    'check-packaged-freshness-guard: bundle-freshness guard violation(s).\n' +
      'Every packaged check must fail fast on stale dist/public bundles and reused asars\n' +
      '(see .agents/memory/stale-dev-bundle-e2e.md):\n' +
      "  import { assertPackagedBundleFresh, assertPackagedAsarFresh } from './packaged-bundle-freshness.mjs';\n",
  );
  for (const { file, problem } of failures) {
    console.error(`  scripts/${file}: ${problem}`);
  }
  process.exit(1);
}

console.log(
  `check-packaged-freshness-guard: OK — ${packagedChecks.length} packaged check(s) ` +
    `[${packagedChecks.join(', ')}] all import and call the shared freshness guard(s).`,
);
