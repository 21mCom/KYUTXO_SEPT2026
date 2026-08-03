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
// Test hook (see scripts/check-ipc-error-sanitization.test.mjs): point the
// scanner at a fixture directory instead of electron/. The fixture dir must
// contain its own security-utils.cjs stub so the self-checks still exercise.
const ELECTRON_DIR = process.env.CHECK_IPC_SANITIZATION_DIR
  ? path.resolve(process.env.CHECK_IPC_SANITIZATION_DIR)
  : path.resolve(ROOT, 'electron');

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

// ---------------------------------------------------------------------------
// Pass 2: handler crash coverage.
//
// Pass 1 catches handlers that RETURN raw error text. But an ipcMain.handle
// callback that THROWS (or rejects) sends the exception's raw message to the
// renderer via the invoke rejection — a separate leak channel. Require every
// handler callback to be either:
//   - a call to a sanctioned wrapper (wrap(...) in engine-handlers.cjs), or
//   - a function whose ENTIRE body is a single top-level try/catch, so no
//     statement can throw outside the sanitizing catch.
// ---------------------------------------------------------------------------

// Wrapper helpers known to sanitize thrown errors before they cross IPC.
// Add a name here ONLY after verifying the helper catches everything and
// routes messages through sanitizeIpcError/toIpcError.
const SANCTIONED_WRAPPERS = ['wrap'];

// Skip whitespace and comments starting at i; returns next code index.
function skipTrivia(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      return i;
    }
  }
}

// Given src[i] === open, return index just past the matching close bracket,
// skipping strings, template literals, and comments. Returns -1 on failure.
function matchBalanced(src, i, open, close) {
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src.startsWith('${', i)) {
          const end = matchBalanced(src, i + 1, '{', '}');
          if (end === -1) return -1;
          i = end;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// Analyze the second argument of an ipcMain.handle(...) call. Returns null
// when compliant, otherwise a human-readable reason string.
function analyzeHandlerCallback(src, argStart, argEnd) {
  let i = skipTrivia(src, argStart);
  const rest = src.slice(i, argEnd);

  // Sanctioned wrapper call: wrap( ... )
  const wrapperMatch = rest.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (wrapperMatch && SANCTIONED_WRAPPERS.includes(wrapperMatch[1])) return null;

  // Parse a function expression: optional async, then function(...) or
  // arrow params.
  let m = rest.match(/^async\b/);
  if (m) i = skipTrivia(src, i + m[0].length);
  const afterAsync = src.slice(i, argEnd);
  if (/^function\b/.test(afterAsync)) {
    i = skipTrivia(src, i + 'function'.length);
    // optional name
    const nm = src.slice(i, argEnd).match(/^[A-Za-z_$][\w$]*/);
    if (nm) i = skipTrivia(src, i + nm[0].length);
    if (src[i] !== '(') return 'unrecognized handler callback shape';
    i = matchBalanced(src, i, '(', ')');
    if (i === -1) return 'unrecognized handler callback shape';
    i = skipTrivia(src, i);
  } else if (src[i] === '(') {
    i = matchBalanced(src, i, '(', ')');
    if (i === -1) return 'unrecognized handler callback shape';
    i = skipTrivia(src, i);
    if (!src.startsWith('=>', i)) return 'unrecognized handler callback shape';
    i = skipTrivia(src, i + 2);
  } else {
    const ident = src.slice(i, argEnd).match(/^[A-Za-z_$][\w$]*/);
    if (!ident) return 'unrecognized handler callback shape';
    i = skipTrivia(src, i + ident[0].length);
    if (!src.startsWith('=>', i)) {
      return 'handler callback is a bare reference — wrap it in wrap(...) or an inline try/catch function';
    }
    i = skipTrivia(src, i + 2);
  }

  if (src[i] !== '{') {
    return 'expression-bodied arrow handler — a throw here rejects the invoke with raw error text; use a body with try/catch or wrap(...)';
  }
  const bodyEnd = matchBalanced(src, i, '{', '}');
  if (bodyEnd === -1) return 'unrecognized handler callback shape';
  let j = skipTrivia(src, i + 1);

  if (!src.startsWith('try', j) || /[\w$]/.test(src[j + 3] || '')) {
    return 'handler body must START with try { ... } catch — statements before the try can throw raw error text across IPC';
  }
  j = skipTrivia(src, j + 3);
  if (src[j] !== '{') return 'unrecognized handler callback shape';
  j = matchBalanced(src, j, '{', '}');
  if (j === -1) return 'unrecognized handler callback shape';
  j = skipTrivia(src, j);
  if (!src.startsWith('catch', j)) {
    return 'handler try block has no catch — a rejection still leaks raw error text across IPC';
  }
  j = skipTrivia(src, j + 5);
  if (src[j] === '(') {
    j = matchBalanced(src, j, '(', ')');
    if (j === -1) return 'unrecognized handler callback shape';
    j = skipTrivia(src, j);
  }
  if (src[j] !== '{') return 'unrecognized handler callback shape';
  j = matchBalanced(src, j, '{', '}');
  if (j === -1) return 'unrecognized handler callback shape';
  j = skipTrivia(src, j);
  if (src.startsWith('finally', j)) {
    j = skipTrivia(src, j + 7);
    if (src[j] !== '{') return 'unrecognized handler callback shape';
    j = matchBalanced(src, j, '{', '}');
    if (j === -1) return 'unrecognized handler callback shape';
    j = skipTrivia(src, j);
  }
  if (j < bodyEnd - 1) {
    return 'handler body has statements AFTER the try/catch — they can throw raw error text across IPC';
  }
  return null;
}

const coverageViolations = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf-8');
  let from = 0;
  for (;;) {
    const idx = source.indexOf('ipcMain.handle', from);
    if (idx === -1) break;
    from = idx + 'ipcMain.handle'.length;
    let i = skipTrivia(source, from);
    if (source[i] !== '(') continue;
    const callEnd = matchBalanced(source, i, '(', ')');
    if (callEnd === -1) continue;
    // Find the top-level comma separating channel name from callback.
    let depth = 0;
    let commaIdx = -1;
    for (let k = i; k < callEnd - 1; k++) {
      const ch = source[k];
      if (ch === "'" || ch === '"' || ch === '`') {
        // strings can't nest here except template exprs; reuse matcher crude:
        const quote = ch;
        k++;
        while (k < callEnd - 1 && source[k] !== quote) {
          if (source[k] === '\\') k++;
          k++;
        }
        continue;
      }
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 1) { commaIdx = k; break; }
    }
    if (commaIdx === -1) continue;
    const reason = analyzeHandlerCallback(source, commaIdx + 1, callEnd - 1);
    if (reason) {
      coverageViolations.push({
        file: path.relative(ROOT, file),
        line: lineOf(source, idx),
        text: source.slice(idx, source.indexOf('\n', idx)).trim(),
        reason,
      });
    }
  }
}

if (coverageViolations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${coverageViolations.length} ipcMain.handle callback(s) whose thrown errors would leak raw text over IPC:\n`,
  );
  for (const v of coverageViolations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    -> ${v.reason}`);
    console.error(
      "    -> A throw/rejection inside an ipcMain.handle callback sends the raw exception message to the renderer via the invoke rejection. Wrap the ENTIRE body in try/catch returning { ok/success: false, error: sanitizeIpcError(error, '...') }, or register via a sanctioned wrapper (see SANCTIONED_WRAPPERS in scripts/check-ipc-error-sanitization.js).\n",
    );
  }
  process.exit(1);
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
