#!/usr/bin/env node
// Guard: no Windows-unsafe filesystem path derivations in scripts/.
//
// WHY: `new URL(import.meta.url).pathname` yields `/D:/a/repo/scripts/x.mjs`
// on Windows, and path.win32.resolve mangles it into an invalid UNC-ish
// `\\D:\a\repo` path. readdirSync/statSync then throw — often swallowed by a
// catch-and-continue guard, producing confusing false negatives that only
// surface on the windows-2022 CI runner (it burned a release build; see
// .agents/memory/win32-import-meta-pathname.md and task 2017). Linux
// validation cannot see this bug class, so this static guard catches the
// pattern before push (pattern: scripts/check-packaged-freshness-guard.js).
//
// Rule — for every non-test scripts/**/*.{js,mjs} file:
//   deriving a filesystem path via `new URL(import.meta.url).pathname` is
//   only allowed when the SAME file also contains a win32-safe conversion:
//     - fileURLToPath(...) (the preferred fix), or
//     - a drive-letter strip on the pathname, e.g.
//       .pathname.replace(/^\/(?=[A-Za-z]:)/, '')
//   Prefer fileURLToPath — the shared helper repoRootFromModuleUrl in
//   scripts/packaged-bundle-freshness.mjs is the pinned implementation.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
// Test hook: the node --test suite points this at fixture directories so a
// broken regex can't silently pass everything.
const SCRIPTS_DIR =
  process.env.CHECK_WIN32_PATH_SCRIPTS_DIR || path.dirname(__filename);

// Directories under scripts/ that never contain our own runnable scripts.
const SKIP_DIRS = new Set(['node_modules', 'cache', '.git']);

function collectScripts(dir, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectScripts(path.join(dir, entry.name), relPath));
    } else if (
      /\.(mjs|js)$/.test(entry.name) &&
      !/\.test\.(mjs|js)$/.test(entry.name) &&
      // this guard's own source contains the trap pattern as regex/prose
      relPath !== 'check-win32-path-derivation.js'
    ) {
      out.push(relPath);
    }
  }
  return out.sort();
}

// The Windows-unsafe derivation: taking .pathname off a URL built from
// import.meta.url (allowing whitespace/newlines inside the call).
const NAIVE_PATHNAME_RE =
  /new\s+URL\s*\(\s*import\.meta\.url\s*[^)]*\)\s*\.\s*pathname/;
// Win32-safe conversions that make the pattern acceptable in the same file:
// 1) fileURLToPath usage (import or call — call is what actually matters).
const FILE_URL_TO_PATH_RE = /\bfileURLToPath\s*\(/;
// 2) an explicit drive-letter strip applied to the pathname, e.g.
//    .pathname.replace(/^\/(?=[A-Za-z]:)/, '')
const DRIVE_STRIP_RE =
  /\.pathname\s*\.\s*replace\s*\(\s*\/\^\\\/\(\?=\[A-Za-z\]:\)\//;

function stripComments(src) {
  // Remove // line comments and /* */ block comments so documentation prose
  // about the trap can't trigger or satisfy the rule.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/[^\n]*/g, '$1');
}

const scripts = collectScripts(SCRIPTS_DIR);
const failures = [];
let scanned = 0;

for (const rel of scripts) {
  const raw = fs.readFileSync(path.join(SCRIPTS_DIR, rel), 'utf8');
  const src = stripComments(raw);
  scanned++;
  if (!NAIVE_PATHNAME_RE.test(src)) continue;
  if (FILE_URL_TO_PATH_RE.test(src) || DRIVE_STRIP_RE.test(src)) continue;
  failures.push(rel);
}

if (scanned === 0) {
  console.error(
    'check-win32-path-derivation: no scripts found to scan — directory layout changed?',
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(
    'check-win32-path-derivation: Windows-unsafe path derivation(s) found.\n' +
      '`new URL(import.meta.url).pathname` is /D:/... on Windows and path.resolve\n' +
      'mangles it into an invalid \\\\D: UNC path (broke the windows-2022 release\n' +
      'build; see .agents/memory/win32-import-meta-pathname.md). Derive paths via\n' +
      "  import { fileURLToPath } from 'node:url';\n" +
      "  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')\n" +
      'instead:\n',
  );
  for (const rel of failures) {
    console.error(
      `  scripts/${rel}: uses new URL(import.meta.url).pathname without fileURLToPath or a win32 drive-letter strip in the same file`,
    );
  }
  process.exit(1);
}

console.log(
  `check-win32-path-derivation: OK — scanned ${scanned} script(s), no Windows-unsafe import.meta.url pathname derivations.`,
);
