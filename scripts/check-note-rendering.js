#!/usr/bin/env node

// KYUTXO renders free-text notes that may contain URLs. Those URLs must only be
// linkified through the shared safe renderer (client/src/lib/renderSourceNote.tsx),
// which refuses to turn dangerous URI schemes (javascript:, data:, file:,
// vbscript:) into clickable links. If a surface renders a note field directly as
// a JSX child, a future change could linkify it unsafely or diverge from the
// shared, audited behavior.
//
// This guard scans non-test .tsx files for free-text note fields (`.notes`,
// `.sourceNote`) rendered directly as a JSX child expression and fails if any of
// them is not routed through renderSourceNote(...). Attribute values
// (value={...}, title={...}), function arguments (foo(x.notes)), method/property
// access (x.notes.length), conditionals (x.notes && (...)) and anything already
// wrapped in renderSourceNote(...) are intentionally not flagged.
//
// Run `node scripts/check-note-rendering.js` to verify.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SCAN_DIR = path.resolve(ROOT, 'client/src');

// Free-text note fields whose values can contain user-supplied URLs.
const NOTE_FIELDS = ['notes', 'sourceNote'];

// A brace group whose entire content is a bare member access ending in a note
// field, optionally with a string fallback (`?? "(none)"`). The presence of any
// "(" inside the group means it is either a function call (renderSourceNote(...),
// .slice(...)) or a method access, so such groups are never flagged.
const PURE_RENDER = new RegExp(
  `^[\\w.\\[\\]'" ]*\\.(${NOTE_FIELDS.join('|')})\\s*(\\?\\?\\s*["'][^"']*["'])?$`,
);

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (
      full.endsWith('.tsx') &&
      !full.endsWith('.test.tsx')
    ) {
      files.push(full);
    }
  }
  return files;
}

function prevNonSpaceChar(line, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (!/\s/.test(line[i])) return line[i];
  }
  return '';
}

const violations = [];

for (const file of collectFiles(SCAN_DIR)) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Find every brace group on the line that contains a note field and no
    // nested braces, then check whether it is a raw (unwrapped) render.
    const braceGroup = /\{([^{}]*)\}/g;
    let m;
    while ((m = braceGroup.exec(line)) !== null) {
      const content = m[1].trim();
      if (!PURE_RENDER.test(content)) continue;
      // Skip attribute values (foo={...}) and function arguments ((x.notes)).
      const before = prevNonSpaceChar(line, m.index);
      if (before === '=' || before === '(' || before === ',') continue;
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: line.trim(),
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} note field(s) rendered without the safe link renderer:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    -> Wrap with renderSourceNote(...) from @/lib/renderSourceNote\n`);
  }
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    'All note renders route through renderSourceNote (no raw .notes/.sourceNote JSX children).',
  );
}
