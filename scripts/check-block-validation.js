#!/usr/bin/env node

// Guard: any client code that validates a manually-entered block hash or
// block height must go through the shared validators in
// client/src/lib/block-validation.ts instead of re-implementing inline
// `[0-9a-f]{64}` regexes or ad-hoc height parsing. This keeps the validation
// rules (lowercase-only hashes, positive-integer heights) from drifting
// across UI surfaces.
//
// Legitimate 64-hex regexes exist for txids and attachment hash directories;
// those files are allow-listed below. Test files are also skipped — asserting
// on hex output in a test is not validation of user input.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SCAN_DIR = path.resolve(ROOT, 'client/src');
const EXTENSIONS = new Set(['.ts', '.tsx']);

// The shared validator itself.
const SHARED_LIB = path.resolve(ROOT, 'client/src/lib/block-validation.ts');

// Files with legitimate 64-hex regexes (txids, attachment content hashes).
const ALLOWED_FILES = new Set([
  SHARED_LIB,
  path.resolve(ROOT, 'client/src/components/RecordFormDialog.tsx'),
  path.resolve(ROOT, 'client/src/pages/QRScanner.tsx'),
  path.resolve(ROOT, 'client/src/lib/records-query.ts'),
  path.resolve(ROOT, 'client/src/lib/bitcoin.ts'),
  path.resolve(ROOT, 'client/src/lib/attachments.ts'),
  path.resolve(ROOT, 'client/src/lib/txid-backfill.ts'),
  // BIP-329 export: legitimate txid / txid:vout outpoint regexes, not block hashes.
  path.resolve(ROOT, 'client/src/lib/bip329.ts'),
]);

// Inline 64-hex regexes in any case/charset variant, e.g.
//   /^[0-9a-f]{64}$/   /^[a-fA-F0-9]{64}$/i   new RegExp("[0-9a-f]{64}")
const HEX64_PATTERN = /\[[^\]\n]*(?:0-9|a-f|A-F)[^\]\n]*\]\s*\{64\}/;

// Ad-hoc block-height validation: parsing/validating a *height* variable or
// literal "block height" strings alongside integer checks. Kept narrow so
// generic numeric parsing elsewhere doesn't false-positive.
const HEIGHT_PATTERNS = [
  /(?:parseInt|Number|Number\.isInteger|Number\.isSafeInteger)\s*\(\s*[A-Za-z_$.]*[Hh]eight\b/,
  /\/\^\\d\+\$\/\s*\.test\s*\(\s*[A-Za-z_$.]*[Hh]eight\b/,
];

function isTestFile(file) {
  return /\.(test|spec)\.[jt]sx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`);
}

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

// Self-check: if the shared validator or any allow-listed file no longer
// exists (renamed/moved/deleted), fail loudly instead of silently guarding
// nothing / allow-listing stale paths.
const missing = [...ALLOWED_FILES].filter(f => !fs.existsSync(f));
if (missing.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    'check-block-validation self-check failed: expected file(s) missing:\n'
  );
  for (const f of missing) {
    const label = f === SHARED_LIB ? ' (shared validator SHARED_LIB)' : ' (ALLOWED_FILES entry)';
    console.error(`  ${path.relative(ROOT, f)}${label}`);
  }
  console.error(
    '\n  -> If a file was renamed/moved, update SHARED_LIB / ALLOWED_FILES in scripts/check-block-validation.js.'
  );
  console.error('     If it was deleted, remove the stale allow-list entry.');
  process.exit(1);
}

const violations = [];

for (const file of collectFiles(SCAN_DIR)) {
  const resolved = path.resolve(file);
  if (ALLOWED_FILES.has(resolved) || isTestFile(resolved)) continue;

  const source = fs.readFileSync(file, 'utf-8');
  const importsSharedLib = /from\s+["'](?:@\/lib\/block-validation|.*\/block-validation)["']/.test(source);

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (HEX64_PATTERN.test(line)) {
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: line.trim(),
        kind: 'inline 64-hex regex (block hash?)',
      });
      continue;
    }

    // Height parsing is only a violation when the file doesn't already use
    // the shared validators (using them means heights are validated there;
    // subsequent parseInt on a validated value is fine).
    if (!importsSharedLib && HEIGHT_PATTERNS.some(p => p.test(line))) {
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: line.trim(),
        kind: 'ad-hoc block height parsing',
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} inline block hash/height validation(s) outside the shared validator:\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.kind}]`);
    console.error(`    ${v.text}`);
    console.error(
      `    -> Use isValidBlockHash / isValidBlockHeight / blockHashInputError / blockHeightInputError from @/lib/block-validation.`
    );
    console.error(
      `       If this is a legitimate txid/content-hash regex, add the file to ALLOWED_FILES in scripts/check-block-validation.js.\n`
    );
  }
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    'Block validation clean: no inline block hash/height validation found outside @/lib/block-validation.'
  );
}
