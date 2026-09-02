#!/usr/bin/env node
// Guard: catch Playwright `waitForFunction(fn, { timeout: ... })` calls.
//
// Playwright's page.waitForFunction signature is (fn, arg, options) — options
// is the THIRD argument. Passing `{ timeout: ... }` as the SECOND argument
// silently treats it as `arg`, so the wait runs with the 30s default timeout.
// This shipped as flaky browser-check failures 13 times across 11 scripts.
// The correct pattern is `waitForFunction(fn, undefined, { timeout: ... })`
// (or null as the arg placeholder).
//
// This guard scans supported scripts source files for waitForFunction calls
// whose second top-level argument is an object literal and fails with
// file:line output.
//
// Test hook: set CHECK_WAITFORFUNCTION_SCRIPTS_DIR to scan a different
// directory (used by check-waitforfunction-options.test.mjs).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = process.env.CHECK_WAITFORFUNCTION_SCRIPTS_DIR
  ? path.resolve(process.env.CHECK_WAITFORFUNCTION_SCRIPTS_DIR)
  : __dirname;
const ROOT = path.resolve(__dirname, '..');
const SUPPORTED_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
const SELF_FILE = path.basename(fileURLToPath(import.meta.url));

function isTestFile(name) {
  return (
    name.endsWith('.test.js') ||
    name.endsWith('.test.mjs') ||
    name.endsWith('.test.ts')
  );
}

// Split the argument list of a call starting at `openParenIdx` (index of the
// '(' character) into top-level argument source strings. Tracks strings,
// template literals (with nested ${}), comments, and bracket depth. Returns
// { args, endIdx } or null if the call never closes (malformed source).
function splitTopLevelArgs(src, openParenIdx) {
  const args = [];
  let current = '';
  let depth = 0; // depth of (), [], {} inside the arg list
  let i = openParenIdx + 1;
  const templateStack = []; // tracks ${} nesting inside template literals

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // Comments
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return null;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }

    // Strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      current += ch;
      i++;
      while (i < src.length) {
        current += src[i];
        if (src[i] === '\\') {
          current += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }

    // Template literals (handle nested ${ ... } by recursion via stack)
    if (ch === '`') {
      current += ch;
      i++;
      let tDepth = 0;
      while (i < src.length) {
        const c = src[i];
        current += c;
        if (c === '\\') {
          current += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === '$' && src[i + 1] === '{') {
          current += '{';
          tDepth++;
          i += 2;
          continue;
        }
        if (tDepth > 0) {
          if (c === '{') tDepth++;
          if (c === '}') tDepth--;
          i++;
          continue;
        }
        if (c === '`') break;
        i++;
      }
      i++;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === ')' && depth === 0) {
        if (current.trim()) args.push(current);
        return { args, endIdx: i };
      }
      depth--;
      current += ch;
      i++;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  return null;
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src[i] === '\n') line++;
  return line;
}

const violations = [];
const files = fs
  .readdirSync(SCRIPTS_DIR)
  .filter(
    (f) =>
      SUPPORTED_SOURCE_EXTENSIONS.has(path.extname(f)) &&
      !isTestFile(f) &&
      f !== SELF_FILE,
  )
  .sort();

for (const name of files) {
  const full = path.join(SCRIPTS_DIR, name);
  const src = fs.readFileSync(full, 'utf8');
  const rel = path.relative(ROOT, full);
  const re = /waitForFunction\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const parsed = splitTopLevelArgs(src, openParen);
    if (!parsed) {
      violations.push(
        `${rel}:${lineOf(src, m.index)}: waitForFunction call could not be parsed (unbalanced parens?) — please check its argument order manually.`,
      );
      continue;
    }
    // Only two-argument calls are suspect: with a third argument present,
    // an object-literal second argument is an intentional `arg` payload.
    if (parsed.args.length === 2) {
      const second = parsed.args[1].trim();
      if (second.startsWith('{')) {
        violations.push(
          `${rel}:${lineOf(src, m.index)}: waitForFunction's SECOND argument is an object literal — Playwright treats it as \`arg\`, not options, so \`timeout\` is silently ignored (30s default). Use waitForFunction(fn, undefined, { timeout: ... }).`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    'check-waitforfunction-options: silently-ignored waitForFunction options found:\n',
  );
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}

console.log(
  `check-waitforfunction-options: OK — no object-literal second arguments to waitForFunction in ${files.length} script(s) (${[...SUPPORTED_SOURCE_EXTENSIONS].join(', ')}).`,
);
