#!/usr/bin/env node
// Guard: every real-Chromium check script must serialize via the shared lock.
//
// WHY: completion validation runs many scripts/check-*-browser* checks in
// parallel. They share the port-5000 dev server and starve each other of
// CPU/memory, causing random SIGTRAP / goto-timeout flakes. Each check must
// therefore import scripts/browser-check-lock.mjs and `await
// acquireBrowserCheckLock();` before doing any work. Nothing else enforces
// this for NEW check scripts — this guard fails fast when one forgets.
//
// Rule: every file matching scripts/check-*-browser*.js/.mjs/.ts must contain BOTH:
//   1. an import of acquireBrowserCheckLock from ./browser-check-lock.mjs
//   2. a top-level `await acquireBrowserCheckLock(` call
//
// Test hook: set CHECK_BROWSER_CHECK_LOCK_SCRIPTS_DIR to scan a different
// directory (used by check-browser-check-lock.test.mjs).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = process.env.CHECK_BROWSER_CHECK_LOCK_SCRIPTS_DIR
  ? path.resolve(process.env.CHECK_BROWSER_CHECK_LOCK_SCRIPTS_DIR)
  : __dirname;
const SUPPORTED_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
const SELF_FILE = path.basename(fileURLToPath(import.meta.url));

function isTestFile(name) {
  return (
    name.endsWith('.test.js') ||
    name.endsWith('.test.mjs') ||
    name.endsWith('.test.ts')
  );
}

const files = fs
  .readdirSync(SCRIPTS_DIR)
  .filter(
    (f) =>
      /^check-.*-browser.*$/.test(f) &&
      SUPPORTED_SOURCE_EXTENSIONS.has(path.extname(f)) &&
      !isTestFile(f) &&
      f !== SELF_FILE,
  )
  .sort();

if (files.length === 0) {
  console.error(
    'check-browser-check-lock: no scripts/check-*-browser*.js/.mjs/.ts files found — glob or layout changed?',
  );
  process.exit(1);
}

const IMPORT_RE =
  /import\s*\{[^}]*\bacquireBrowserCheckLock\b[^}]*\}\s*from\s*['"]\.\/browser-check-lock\.mjs['"]/;
const AWAIT_RE = /await\s+acquireBrowserCheckLock\s*\(/;

const failures = [];

for (const file of files) {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
  const problems = [];
  if (!IMPORT_RE.test(src)) {
    problems.push(
      "missing import: import { acquireBrowserCheckLock } from './browser-check-lock.mjs';",
    );
  }
  if (!AWAIT_RE.test(src)) {
    problems.push('missing call: await acquireBrowserCheckLock();');
  }
  if (problems.length > 0) {
    failures.push({ file, problems });
  }
}

if (failures.length > 0) {
  console.error(
    'check-browser-check-lock: browser check script(s) missing the serialization lock.\n' +
      'Parallel validation runs will crash each other\'s Chromium (SIGTRAP / goto timeouts).\n' +
      'Add at the top of each script (before any other work):\n' +
      "  import { acquireBrowserCheckLock } from './browser-check-lock.mjs';\n" +
      '  await acquireBrowserCheckLock();\n',
  );
  for (const { file, problems } of failures) {
    for (const p of problems) {
      console.error(`  scripts/${file}: ${p}`);
    }
  }
  process.exit(1);
}

console.log(
  `check-browser-check-lock: OK — ${files.length} browser check script(s) all acquire the serialization lock.`,
);
