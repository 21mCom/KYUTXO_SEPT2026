#!/usr/bin/env node

// KYUTXO ships a browser bundle (Vite) that does NOT polyfill the Node `Buffer`
// global, and there is no global `Buffer` shim anywhere in the client. Any
// client/src module that runs in the browser and uses the `Buffer` global API
// (`Buffer.from`, `Buffer.alloc`, `Buffer.concat`, `new Buffer(...)`, etc.) will
// throw "Buffer is not defined" at runtime.
//
// This is a recurring trap: vitest runs in Node, where `Buffer` is a global, so
// such code passes unit tests green while crashing real users in the browser
// (the original Proof-of-Funds signature-verification crash was exactly this —
// a `Buffer.from(pubkey)` that worked in tests and threw in the browser).
//
// This guard scans non-test client/src files and fails if the `Buffer` GLOBAL
// API is used without an explicit `import { Buffer } from 'buffer'` (the opt-in
// escape hatch that bundles the polyfill). It deliberately does NOT flag:
//   - identifiers that merely END in "Buffer" (passwordBuffer, hashBuffer, ...)
//   - the `ArrayBuffer` / `SharedArrayBuffer` constructors and `BufferSource`
//   - the word "Buffer" inside comments or strings
// Only the bare global `Buffer.` member access and `new Buffer(...)` are flagged.
//
// Run `node scripts/check-no-buffer-global.js` to verify.
// Run `scripts/install-hooks.sh` to (re)install the pre-commit hook.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SCAN_DIR = path.resolve(ROOT, 'client/src');
const EXTENSIONS = new Set(['.ts', '.tsx']);

// Test-only helpers that run exclusively under vitest/Node (never in the
// browser bundle), so the Node `Buffer` global is legitimately available.
const ALLOWED_FILES = new Set([
  path.resolve(ROOT, 'client/src/test/pdfAssertions.ts'),
]);

// Files that opt into the polyfill with an explicit Buffer import are allowed.
// Matches: import { Buffer } from 'buffer' | 'node:buffer' (in any import-clause
// position, e.g. `import { x, Buffer } from 'buffer'`).
const BUFFER_IMPORT = /import\s+[^;]*\bBuffer\b[^;]*\bfrom\s+['"](?:node:)?buffer['"]/;

// Global Buffer API usage:
//   - member access on the global:  Buffer.from / Buffer.alloc / Buffer.concat …
//   - constructor:                  new Buffer(...)
// The `(?<![\w$])` lookbehind ensures we only match a STANDALONE `Buffer`
// identifier, so `ArrayBuffer.`, `passwordBuffer.`, `myBuffer.` are NOT flagged.
const BUFFER_MEMBER = /(?<![\w$])Buffer\s*\./;
const BUFFER_NEW = /(?<![\w$])new\s+Buffer\s*\(/;

function isViolation(line) {
  return BUFFER_MEMBER.test(line) || BUFFER_NEW.test(line);
}

// Blank out comments and string literals while preserving newlines (so line
// numbers stay accurate). This prevents false positives from "Buffer." appearing
// inside a comment (signatureVerify.ts documents the trap) or a string.
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        out += '  ';
        i += 2;
        state = 'line';
      } else if (c === '/' && next === '*') {
        out += '  ';
        i += 2;
        state = 'block';
      } else if (c === "'") {
        out += ' ';
        i += 1;
        state = 'sq';
      } else if (c === '"') {
        out += ' ';
        i += 1;
        state = 'dq';
      } else if (c === '`') {
        out += ' ';
        i += 1;
        state = 'tpl';
      } else {
        out += c;
        i += 1;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        out += '\n';
        state = 'code';
      } else {
        out += ' ';
      }
      i += 1;
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        out += '  ';
        i += 2;
        state = 'code';
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
    } else if (state === 'sq' || state === 'dq' || state === 'tpl') {
      const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
      if (c === '\\') {
        out += '  ';
        i += 2;
      } else if (c === quote) {
        out += ' ';
        i += 1;
        state = 'code';
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
    }
  }
  return out;
}

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (
      EXTENSIONS.has(path.extname(entry.name)) &&
      !full.endsWith('.test.ts') &&
      !full.endsWith('.test.tsx')
    ) {
      files.push(full);
    }
  }
  return files;
}

// Self-check: fail loudly if any hardcoded path this guard depends on no longer
// exists (mirrors scripts/check-crud-guards.js). Otherwise a rename of an
// allow-listed file (or the scan dir) would silently degrade the guard.
const missingRefs = [...ALLOWED_FILES].filter((f) => !fs.existsSync(f));
if (!fs.existsSync(SCAN_DIR)) missingRefs.push(SCAN_DIR);
if (missingRefs.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    'check-no-buffer-global self-check failed: expected file(s) missing:\n',
  );
  for (const f of missingRefs) {
    const label = f === SCAN_DIR ? ' (SCAN_DIR)' : ' (ALLOWED_FILES entry)';
    console.error(`  ${path.relative(ROOT, f)}${label}`);
  }
  console.error(
    '\n  -> If a file was renamed/moved, update ALLOWED_FILES / SCAN_DIR in scripts/check-no-buffer-global.js.',
  );
  console.error('     If it was deleted, remove the stale entry.');
  process.exit(1);
}

const violations = [];

for (const file of collectFiles(SCAN_DIR)) {
  const resolved = path.resolve(file);
  if (ALLOWED_FILES.has(resolved)) continue;

  const raw = fs.readFileSync(file, 'utf-8');
  // A file that explicitly imports the Buffer polyfill has opted in.
  if (BUFFER_IMPORT.test(raw)) continue;

  const code = stripCommentsAndStrings(raw);
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isViolation(lines[i])) {
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: lines[i].trim(),
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} use(s) of the Node 'Buffer' global in browser code:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    '\nThe Vite browser bundle does not polyfill the Node `Buffer` global, so this\n' +
      'will throw "Buffer is not defined" at runtime even though unit tests (run in\n' +
      'Node) pass. Fix by using `Uint8Array` end to end (bitcoinjs-lib v7 and\n' +
      '@bitcoinerlab/secp256k1 accept it directly) and `atob`/`btoa` or the\n' +
      '`base64ToBuffer` helper in client/src/lib/crypto.ts for base64. If you truly\n' +
      "need it, add `import { Buffer } from 'buffer'` to opt into the polyfill.\n",
  );
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    "No use of the Node 'Buffer' global in browser code (client/src).",
  );
}
