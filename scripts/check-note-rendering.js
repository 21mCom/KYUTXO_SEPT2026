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
// Privacy Audit / Reports finding text uses the generic field names
// `.description` and `.correction` (remediation). Those embed user-controlled
// text from the imported entity-list snapshot (entity names, source notes), so
// they must also route through renderSourceNote(...). Because `.description`
// appears widely as static config (CardDescription, option lists, etc.), the
// finding-field scan is scoped to the specific files that render finding text
// (see FINDING_FILES) rather than scanning generically.
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

// Privacy Audit / Reports finding-text fields. These are scoped to FINDING_FILES
// because the generic names (`description` especially) are used widely as static
// config elsewhere (CardDescription, option lists), which would cause false
// positives if scanned across every file.
const FINDING_FIELDS = ['description', 'correction'];
const FINDING_FILES = new Set([
  'client/src/pages/PrivacyAudit.tsx',
  'client/src/pages/Reports.tsx',
]);

// Builds a regex matching a brace group whose entire content is a bare member
// access ending in one of `fields`, optionally with a string fallback
// (`?? "(none)"`). The presence of any "(" inside the group means it is either a
// function call (renderSourceNote(...), .slice(...)) or a method access, so such
// groups are never flagged.
function pureRenderRegex(fields) {
  return new RegExp(
    `^[\\w.\\[\\]'" ]*\\.(${fields.join('|')})\\s*(\\?\\?\\s*["'][^"']*["'])?$`,
  );
}

const NOTE_RENDER = pureRenderRegex(NOTE_FIELDS);
const FINDING_RENDER = pureRenderRegex(FINDING_FIELDS);

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

// Scans one line for raw (unwrapped) JSX-child renders of any field matched by
// `renderRegex`, pushing violations. Returns nothing.
function scanLine(line, lineNo, relFile, renderRegex, out) {
  // Find every brace group on the line that contains no nested braces, then
  // check whether it is a raw render of a guarded field.
  const braceGroup = /\{([^{}]*)\}/g;
  let m;
  while ((m = braceGroup.exec(line)) !== null) {
    const content = m[1].trim();
    if (!renderRegex.test(content)) continue;
    // Skip attribute values (foo={...}) and function arguments ((x.notes)).
    const before = prevNonSpaceChar(line, m.index);
    if (before === '=' || before === '(' || before === ',') continue;
    out.push({ file: relFile, line: lineNo + 1, text: line.trim() });
  }
}

const violations = [];

for (const file of collectFiles(SCAN_DIR)) {
  const relFile = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const scanFindings = FINDING_FILES.has(relFile);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    scanLine(line, i, relFile, NOTE_RENDER, violations);
    // Finding-text fields are only scanned in the files that render findings.
    if (scanFindings) {
      scanLine(line, i, relFile, FINDING_RENDER, violations);
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
    'All note renders route through renderSourceNote (no raw .notes/.sourceNote, or finding .description/.correction, JSX children).',
  );
}
