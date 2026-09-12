#!/usr/bin/env node

// Guards against hardcoded KYUTXO_APP_VERSION strings in source files outside
// package.json. Every consumer must import from package.json instead so that a
// release bump never needs to touch more than one file.
//
// Pattern detected:
//   KYUTXO_APP_VERSION = "x.y.z"   (the assignment form, not the usage)
//
// Allowed locations: none — the export in declaration-prefs.ts now derives the
// value from package.json, so no source file should ever assign a literal.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Directories / extensions to scan
const SCAN_DIRS = [
  path.resolve(ROOT, 'client/src'),
  path.resolve(ROOT, 'electron'),
  path.resolve(ROOT, 'server'),
];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// Regex: matches the literal-assignment form  KYUTXO_APP_VERSION = "..."
// This intentionally does NOT flag usages like  `v${KYUTXO_APP_VERSION}`.
const VERSION_LITERAL_RE = /KYUTXO_APP_VERSION\s*=\s*["']\d+\.\d+\.\d+/;

function walkDir(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, files);
    } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walkDir(dir)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (VERSION_LITERAL_RE.test(lines[i])) {
        violations.push(`  ${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('[check-version-literal] Hardcoded KYUTXO_APP_VERSION literal found.');
  console.error('  Derive the version from package.json instead:');
  console.error('  import { version } from "../../../package.json";');
  console.error('');
  console.error('Violations:');
  for (const v of violations) {
    console.error(v);
  }
  process.exit(1);
}

console.log('[check-version-literal] OK — no hardcoded KYUTXO_APP_VERSION literals found.');
