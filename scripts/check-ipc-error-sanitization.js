#!/usr/bin/env node

// Lint-style guard for the desktop app's IPC error-sanitization guarantee.
//
// Task 1756 sanitized every IPC error payload in the Electron main process via
// sanitizeIpcError()/toIpcError() (electron/security-utils.cjs). The helper
// unit tests cannot catch a FUTURE handler that returns raw exception text
// again — e.g. a new `ipcMain.handle` catch block ending in
// `return { success: false, error: error.message }` — because the helpers
// themselves still pass. This script scans every electron/*.cjs file for that
// regression pattern and fails validation when found.
//
// Flagged patterns (raw exception text placed on an IPC `error:` field):
//   error: error.message          error: err.message         error: e.message
//   error: String(error)          error: `${err.message} ...` (template form)
//
// Legitimate sanitized returns look like:
//   error: sanitizeIpcError(error, 'Failed to ...')
//   error: toIpcError(error, 'Failed to ...')
//   error: 'Fixed literal text'
// and are not matched.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.resolve(ROOT, 'electron');

// Common catch-binding identifiers.
const ERR_IDENT = '(?:error|err|e|e2|e3|ex|cause)';

// `error: err.message` (with optional optional-chaining / fallback the regex
// still catches the head of).
const RAW_MESSAGE = new RegExp(`\\berror:\\s*${ERR_IDENT}(?:\\?)?\\.message\\b`);
// `error: String(err)` — stringifying the exception leaks the same raw text.
const RAW_STRING = new RegExp(`\\berror:\\s*String\\(\\s*${ERR_IDENT}\\b`);
// Template-literal interpolation of raw exception text into the error field:
// `error: \`...${err.message}...\``. The backtick must directly follow
// `error:` so log strings like `Socket error: ${err.message}` (inside a
// larger template) are not false-positived.
const RAW_TEMPLATE = new RegExp(
  '\\berror:\\s*`[^`]*\\$\\{\\s*' + ERR_IDENT + '(?:\\?)?\\.message\\b',
);

const PATTERNS = [
  { re: RAW_MESSAGE, label: 'raw error.message on an IPC error field' },
  { re: RAW_STRING, label: 'String(error) on an IPC error field' },
  { re: RAW_TEMPLATE, label: 'raw error.message interpolated into an IPC error field' },
];

// Self-check: the sanitization helpers this guard protects must still exist,
// and the electron dir must still contain IPC handlers — otherwise this check
// is silently guarding nothing (e.g. after a rename/move).
const SECURITY_UTILS = path.resolve(ELECTRON_DIR, 'security-utils.cjs');
if (!fs.existsSync(ELECTRON_DIR)) {
  console.error('\x1b[31m%s\x1b[0m', 'check-ipc-error-sanitization self-check failed: electron/ directory not found.');
  console.error('  -> If the Electron sources moved, update ELECTRON_DIR in scripts/check-ipc-error-sanitization.js.');
  process.exit(1);
}
if (!fs.existsSync(SECURITY_UTILS)) {
  console.error('\x1b[31m%s\x1b[0m', 'check-ipc-error-sanitization self-check failed: electron/security-utils.cjs not found.');
  console.error('  -> If the sanitization helpers moved, update SECURITY_UTILS in scripts/check-ipc-error-sanitization.js.');
  process.exit(1);
}
const securityUtilsSource = fs.readFileSync(SECURITY_UTILS, 'utf-8');
if (!securityUtilsSource.includes('sanitizeIpcError')) {
  console.error('\x1b[31m%s\x1b[0m', 'check-ipc-error-sanitization self-check failed: sanitizeIpcError no longer defined in electron/security-utils.cjs.');
  console.error('  -> If the helper was renamed, update this script to match.');
  process.exit(1);
}

const files = fs
  .readdirSync(ELECTRON_DIR)
  .filter((name) => name.endsWith('.cjs'))
  .map((name) => path.join(ELECTRON_DIR, name));

if (files.length === 0) {
  console.error('\x1b[31m%s\x1b[0m', 'check-ipc-error-sanitization self-check failed: no .cjs files found under electron/.');
  process.exit(1);
}

let sawIpcHandle = false;
const violations = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf-8');
  if (source.includes('ipcMain.handle')) sawIpcHandle = true;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip pure comment lines (pattern text quoted in explanatory comments).
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    for (const { re, label } of PATTERNS) {
      if (re.test(line)) {
        violations.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          text: trimmed,
          label,
        });
        break;
      }
    }
  }
}

if (!sawIpcHandle) {
  console.error('\x1b[31m%s\x1b[0m', 'check-ipc-error-sanitization self-check failed: no ipcMain.handle found in any electron/*.cjs file.');
  console.error('  -> If IPC handler registration moved, update this script so it keeps scanning the right files.');
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} unsanitized IPC error payload(s) in electron/*.cjs:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (${v.label})`);
    console.error(`    ${v.text}`);
    console.error(
      "    -> Raw exception text can embed filesystem paths, hosts, and URLs. Route it through sanitizeIpcError(error, 'Fixed fallback text') from electron/security-utils.cjs (or toIpcError in electrum-client.cjs), and log details main-side via logMainError.\n",
    );
  }
  process.exit(1);
}

console.log(
  '\x1b[32m%s\x1b[0m',
  `IPC error sanitization clean: no raw error.message returns found in ${files.length} electron/*.cjs file(s).`,
);
