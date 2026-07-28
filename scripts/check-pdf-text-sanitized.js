#!/usr/bin/env node

// KYUTXO's PDF exports use jsPDF's Standard-14 Helvetica font with no embedded
// Unicode font. When a character outside the WinAnsi (Windows-1252) 8-bit range
// reaches jsPDF, the affected text run is emitted as a UTF-16BE byte-stream and
// renders as garbled "ÔÇö"-style glyphs in most PDF viewers. The shared helper
// `sanitizePdfText` (client/src/lib/pdfText.ts) remaps that punctuation back to
// renderable WinAnsi bytes, so EVERY user/string value drawn into a PDF must be
// routed through it.
//
// The browser glyph guard proves `sanitizePdfText` itself renders remapped
// punctuation correctly, but it cannot prove that every PDF-export surface
// actually CALLS it. If a report draws text via jsPDF's `doc.text(...)`,
// `doc.cell(...)`, or an `autoTable(...)` cell without sanitizing, that report
// still ships garbled glyphs in production and no existing check would catch it.
//
// This guard scans non-test client/src files that build a PDF (`new jsPDF`) and
// fails when text reaching a jsPDF text sink is not safe. For every sink
// argument it transitively expands the local variables / function params that
// feed it (so a non-ASCII literal hidden one or two assignments upstream — e.g.
// `headingText` -> `splitTextToSize(...)` -> `doc.text(headingLines)` — is still
// caught) and then applies two checks:
//
//   (A) Non-ASCII literal check: any literal character outside the ASCII range
//       that is NOT inside a `sanitizePdfText(...)` call is a violation. This
//       catches a raw em-dash / curly-quote / ellipsis typed straight into a PDF
//       string (the real latent bugs this guard was written to surface).
//
//   (B) Bare-user-text check: a sink argument that resolves to a bare member
//       expression (`record.note`, `entity.name`, `node.groupLabel`) with no
//       formatting call and no `sanitizePdfText(...)` wrapper is a violation —
//       this is exactly "a report writes user text directly via doc.text(...)
//       without sanitizing". Arguments that contain a call (sanitizePdfText,
//       splitTextToSize, formatBtc, String, .toLocaleString(), ...) or are pure
//       ASCII string/template literals are considered safe.
//
// Pure ASCII string literals are always safe, so well-known ASCII constants need
// no special handling. Genuinely-safe exceptions can be added to ALLOWED_LINES.
//
// Limitations (documented, deliberate): a non-ASCII value that only exists at
// RUNTIME inside a `${...}` template interpolation cannot be seen statically, so
// the convention is to wrap user free-text in `sanitizePdfText(...)`. autoTable
// rows are checked as a whole expression (they almost always contain a
// formatting call), so this guard mainly hardens the `doc.text(...)` surface —
// the path the task calls out — while still flagging literal punctuation
// anywhere in the PDF text flow.
//
// Run `node scripts/check-pdf-text-sanitized.js` to verify.
// Run `scripts/install-hooks.sh` to (re)install the pre-commit hook.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SCAN_DIR = path.resolve(ROOT, 'client/src');
const EXTENSIONS = new Set(['.ts', '.tsx']);

const SANITIZER = 'sanitizePdfText';

// Identifiers that are never user text and must not be treated as expandable
// local variables (builtins / the jsPDF + autoTable handles / the sanitizer).
const NON_EXPANDABLE = new Set([
  'String', 'Number', 'Boolean', 'Math', 'Date', 'JSON', 'Array', 'Object',
  'Set', 'Map', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false',
  'doc', 'autoTable', SANITIZER,
]);

// Escape hatch for genuinely-safe exceptions, keyed as "relative/path:line".
const ALLOWED_LINES = new Set([]);

// The shared sanitizer module every PDF text sink must route through. If it
// moves, this guard's premise (and its advice) is stale — fail loudly.
const SANITIZER_FILE = path.resolve(ROOT, 'client/src/lib/pdfText.ts');

// Self-check: if any hardcoded file (the sanitizer module, SCAN_DIR, or a file
// referenced by an ALLOWED_LINES entry) no longer exists (renamed/moved/
// deleted), fail loudly instead of silently scanning nothing / allow-listing
// stale paths.
{
  const missing = [];
  if (!fs.existsSync(SANITIZER_FILE)) missing.push([SANITIZER_FILE, ' (sanitizer SANITIZER_FILE)']);
  if (!fs.existsSync(SCAN_DIR)) missing.push([SCAN_DIR, ' (SCAN_DIR)']);
  for (const key of ALLOWED_LINES) {
    const rel = key.slice(0, key.lastIndexOf(':'));
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) missing.push([abs, ' (ALLOWED_LINES entry)']);
  }
  if (missing.length > 0) {
    console.error(
      '\x1b[31m%s\x1b[0m',
      'check-pdf-text-sanitized self-check failed: expected file(s) missing:\n',
    );
    for (const [f, label] of missing) {
      console.error(`  ${path.relative(ROOT, f)}${label}`);
    }
    console.error(
      '\n  -> If a file was renamed/moved, update SANITIZER_FILE / ALLOWED_LINES in scripts/check-pdf-text-sanitized.js.',
    );
    console.error('     If it was deleted, remove the stale entry.');
    process.exit(1);
  }
}

// ───────────────────────── lexical helpers ──────────────────────────────────

// Blank out comments while preserving strings and newlines (keeps line numbers
// stable). Comments are full of em-dashes / arrows that must never be scanned.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Given src[i] is a string/template delimiter, return the index just past the
// matching closer (handling escapes and template ${ } interpolation).
function skipString(src, i) {
  const q = src[i];
  i++;
  if (q === '`') {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') return i + 1;
      if (c === '$' && src[i + 1] === '{') {
        i = skipBraces(src, i + 1);
        continue;
      }
      i++;
    }
    return i;
  }
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    i++;
  }
  return i;
}

// Given src[i] === '{', return the index just past the matching '}'.
function skipBraces(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

// Return the first top-level argument substring; `parenIdx` points at the '('.
function firstArg(src, parenIdx) {
  let i = parenIdx + 1;
  let depth = 0;
  const start = i;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return src.slice(start, i);
      depth--;
    } else if (c === ',' && depth === 0) {
      return src.slice(start, i);
    }
    i++;
  }
  return src.slice(start);
}

// Read a balanced (...) / [...] / {...} group; `openIdx` points at the opener.
function readGroup(src, openIdx) {
  const open = src[openIdx];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let i = openIdx + 1;
  let depth = 0;
  const start = i;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      if (depth === 0) return { body: src.slice(start, i), end: i + 1 };
      depth--;
    }
    i++;
  }
  return { body: src.slice(start), end: i };
}

// Read an expression value up to the next top-level ';' or ',' (or the end of
// the enclosing group). Used for both assignment RHS and object-property values,
// so it must stop at commas (e.g. `head: [...], body: [...]`).
function readToTerminator(src, i) {
  let depth = 0;
  const start = i;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ';' || c === ',')) break;
    i++;
  }
  return src.slice(start, i);
}

// Remove every balanced `fnName(...)` call group from text.
function removeCallGroups(text, fnName) {
  let out = '';
  let i = 0;
  const re = new RegExp(`(?<![\\w$.])${fnName}\\s*\\(`);
  while (i < text.length) {
    const rest = text.slice(i);
    const m = rest.match(re);
    if (!m) {
      out += rest;
      break;
    }
    out += rest.slice(0, m.index);
    const parenIdx = i + m.index + m[0].length - 1;
    const { end } = readGroup(text, parenIdx);
    i = end;
  }
  return out;
}

// Drop all string/template literal contents (including ${ } interpolations).
function stripStringLiterals(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// True when the text contains a function/method call: an identifier or a `)`
// immediately followed by `(`.
function hasCall(text) {
  return /[\w$)]\s*\(/.test(text);
}

// ───────────────────── per-file variable resolution ─────────────────────────

// Build a map of local identifier -> array of RHS expression strings, covering
// `const/let/var x = …`, `x = …`, `x += …`, `for (const x of SRC)` /
// `for (const [a, b] of SRC)`, and function parameters resolved from call sites.
function buildVarMap(code) {
  const map = new Map();
  const add = (name, rhs) => {
    if (!name) return;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(rhs);
  };

  // Plain assignments (=, +=) that are not ==, ===, =>, <=, >=, !=.
  const assignRe = /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(\+?=)(?![=>])/g;
  let m;
  while ((m = assignRe.exec(code)) !== null) {
    const opStart = m.index + m[0].length - m[2].length;
    const prev = code[opStart - 1];
    // Guard against comparison/arrow operators bleeding in (e.g. `a <= b`).
    if (prev && '=!<>'.includes(prev)) continue;
    const rhs = readToTerminator(code, m.index + m[0].length);
    add(m[1], rhs);
  }

  // for-of loops bind the loop variable(s) to an element of the source.
  const forOfRe = /for\s*\(\s*(?:const|let|var)\s+(\[[^\]]+\]|[A-Za-z_$][\w$]*)\s+of\s+([^)]+?)\)/g;
  while ((m = forOfRe.exec(code)) !== null) {
    const names = m[1].startsWith('[')
      ? m[1].slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : [m[1].trim()];
    const src = m[2].trim();
    for (const name of names) add(name, `__elem__(${src})`);
  }

  // Function definitions -> parameter names, resolved against their call sites.
  const fnParams = new Map(); // fnName -> [paramName, ...]
  const arrowRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  while ((m = arrowRe.exec(code)) !== null) {
    const parenIdx = m.index + m[0].length - 1;
    const { body, end } = readGroup(code, parenIdx);
    const after = code.slice(end, end + 40);
    if (!/^\s*(?::[^=]*)?=>/.test(after)) continue; // must be an arrow function
    fnParams.set(m[1], parseParamNames(body));
  }
  const fnDeclRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnDeclRe.exec(code)) !== null) {
    const parenIdx = m.index + m[0].length - 1;
    const { body } = readGroup(code, parenIdx);
    fnParams.set(m[1], parseParamNames(body));
  }

  // For each declared function, gather positional args from every call site and
  // bind them to the matching parameter name.
  for (const [fn, params] of fnParams) {
    if (params.length === 0) continue;
    const callRe = new RegExp(`(?<![\\w$.])${fn}\\s*\\(`, 'g');
    let cm;
    while ((cm = callRe.exec(code)) !== null) {
      // Skip the declaration itself (`function fn(...)`) — its "arguments" are
      // the parameter list (`record: any`), not real call-site values.
      if (/\bfunction\s+$/.test(code.slice(0, cm.index))) continue;
      const parenIdx = cm.index + cm[0].length - 1;
      const { body } = readGroup(code, parenIdx);
      const args = splitTopLevel(body);
      params.forEach((p, idx) => {
        if (idx < args.length) add(p, args[idx]);
      });
    }
  }

  return map;
}

function parseParamNames(paramText) {
  return splitTopLevel(paramText)
    .map((p) => {
      const name = p.trim().split(/[:=]/)[0].trim();
      return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
    })
    .filter(Boolean);
}

// Split a comma-separated list at top level (respecting nesting and strings).
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  const tail = text.slice(start);
  if (tail.trim()) parts.push(tail);
  return parts;
}

// Collect identifiers locally bound inside an expression (arrow / function
// params and for-of / for-in loop variables). These shadow any file-level
// variable of the same name, so they must NOT be inlined — otherwise a short
// callback param like `m` in `rows.map((m) => …)` collides with an unrelated
// `for (const m of …)` elsewhere and pulls in the wrong value.
function identsFrom(text) {
  return (text.match(/[A-Za-z_$][\w$]*/g) || []).filter(
    (t) => !['const', 'let', 'var', 'of', 'in', 'async', 'await'].includes(t),
  );
}

function boundNamesIn(expr) {
  const names = new Set();
  let m;
  const arrowParen = /\(([^()]*)\)\s*=>/g;
  while ((m = arrowParen.exec(expr)) !== null) {
    for (const n of identsFrom(m[1])) names.add(n);
  }
  const arrowBare = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowBare.exec(expr)) !== null) names.add(m[1]);
  const forBind = /for\s*\(\s*(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/g;
  while ((m = forBind.exec(expr)) !== null) {
    for (const n of identsFrom(m[1])) names.add(n);
  }
  return names;
}

// Recursively inline known local variables so upstream literals/members surface.
function expand(expr, varMap, seen, depth, blocked) {
  if (depth <= 0) return expr;
  const localBlocked = new Set(blocked);
  for (const n of boundNamesIn(expr)) localBlocked.add(n);
  return expr.replace(/(?<![.\w$])([A-Za-z_$][\w$]*)(?![\w$])/g, (whole, name) => {
    if (NON_EXPANDABLE.has(name) || seen.has(name) || localBlocked.has(name)) return whole;
    const rhsList = varMap.get(name);
    // Only inline UNAMBIGUOUS variables (exactly one assignment / binding).
    // Multiply-assigned identifiers (re-used locals like `lines`, layout
    // counters like `y`/`cursorY`, params with several call sites) are left as
    // bare identifiers — expanding the cartesian product of every assignment
    // both explodes memory and is meaningless, and a lone identifier is treated
    // as safe by the checks below anyway.
    if (!rhsList || rhsList.length !== 1) return whole;
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    const expanded = expand(rhsList[0], varMap, nextSeen, depth - 1, localBlocked);
    return `(${expanded})`;
  });
}

// ───────────────────────────── checks ───────────────────────────────────────

// (A) Non-ASCII literal that is not inside a sanitizePdfText(...) call.
function findNonAsciiViolation(expanded) {
  const stripped = removeCallGroups(expanded, SANITIZER);
  return /[^\x00-\x7F]/.test(stripped);
}

// (B) Bare member-expression user text with no formatting call / sanitizer.
function findBareMemberViolation(expanded) {
  let s = removeCallGroups(expanded, SANITIZER);
  s = stripStringLiterals(s);
  if (hasCall(s)) return false; // a formatting/transform call is present
  // Normalize optional-chaining / nullish so they are not mistaken for the
  // ternary operator below.
  s = s.replace(/\?\./g, '.').replace(/\?\?/g, ' ');
  // A ternary draws one of its (already string-literal / value) branches — the
  // condition is not the text, so do not treat a member in it as user text.
  if (/[?:]/.test(s)) return false;
  // A member access (x.y or x[...]) that reached a text sink unformatted is user
  // text — UNLESS its root is a SCREAMING_SNAKE_CASE constant (a fixed string
  // table, never user input).
  const memberRe = /([A-Za-z_$][\w$]*)\s*(?:\.\s*[A-Za-z_$]|\[)/g;
  let mm;
  while ((mm = memberRe.exec(s)) !== null) {
    if (/^[A-Z][A-Z0-9_]*$/.test(mm[1])) continue; // constant object
    return true;
  }
  return false;
}

// ───────────────────────────── scanning ─────────────────────────────────────

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (
      EXTENSIONS.has(path.extname(entry.name)) &&
      !full.endsWith('.test.ts') &&
      !full.endsWith('.test.tsx') &&
      !full.includes(`${path.sep}__tests__${path.sep}`)
    ) {
      files.push(full);
    }
  }
  return files;
}

function docNamesFor(code) {
  const names = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+jsPDF\b/g;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return names;
}

function lineOf(code, index) {
  return code.slice(0, index).split('\n').length;
}

const violations = [];

for (const file of collectFiles(SCAN_DIR)) {
  const raw = fs.readFileSync(file, 'utf-8');
  if (!/\bnew\s+jsPDF\b/.test(raw)) continue; // not a PDF-building module

  const relFile = path.relative(ROOT, file);
  const code = stripComments(raw);
  const docNames = docNamesFor(code);
  if (docNames.size === 0) continue;
  const varMap = buildVarMap(code);

  const record = (index, arg, kind) => {
    const line = lineOf(code, index);
    if (ALLOWED_LINES.has(`${relFile}:${line}`)) return;
    const expanded = expand(arg, varMap, new Set(), 6, new Set());
    if (kind === 'text') {
      if (findNonAsciiViolation(expanded)) {
        violations.push({ file: relFile, line, kind: 'non-ascii', text: arg.trim() });
      } else if (findBareMemberViolation(expanded)) {
        violations.push({ file: relFile, line, kind: 'unsanitized', text: arg.trim() });
      }
    } else {
      // autoTable cells: only the deterministic non-ASCII literal check.
      if (findNonAsciiViolation(expanded)) {
        violations.push({ file: relFile, line, kind: 'non-ascii', text: arg.trim() });
      }
    }
  };

  // doc.text(...) / doc.cell(...) — the primary user-text surface.
  const docPattern = Array.from(docNames).map((n) => n.replace(/[$]/g, '\\$&')).join('|');
  const textRe = new RegExp(`(?<![\\w$.])(?:${docPattern})\\s*\\.\\s*(text|cell)\\s*\\(`, 'g');
  let m;
  while ((m = textRe.exec(code)) !== null) {
    const parenIdx = m.index + m[0].length - 1;
    record(m.index, firstArg(code, parenIdx), 'text');
  }

  // autoTable(doc, { head: …, body: … }) — check the head/body cell expressions.
  const autoRe = /(?<![\w$.])autoTable\s*\(/g;
  while ((m = autoRe.exec(code)) !== null) {
    const parenIdx = m.index + m[0].length - 1;
    const { body: callArgs } = readGroup(code, parenIdx);
    const objIdx = callArgs.indexOf('{');
    if (objIdx === -1) continue;
    const absObjIdx = parenIdx + 1 + objIdx;
    const { body: optsBody } = readGroup(code, absObjIdx);
    for (const key of ['head', 'body']) {
      const keyRe = new RegExp(`(?<![\\w$.])${key}\\s*:`, 'g');
      let km;
      while ((km = keyRe.exec(optsBody)) !== null) {
        const valStart = km.index + km[0].length;
        const value = readToTerminator(optsBody, valStart);
        if (value.trim()) record(m.index, value, 'table');
      }
    }
  }
}

if (violations.length > 0) {
  const nonAscii = violations.filter((v) => v.kind === 'non-ascii');
  const unsanitized = violations.filter((v) => v.kind === 'unsanitized');
  console.error(
    '\x1b[31m%s\x1b[0m',
    `Found ${violations.length} unsanitized jsPDF text sink(s):\n`,
  );
  for (const v of violations) {
    const label =
      v.kind === 'non-ascii'
        ? 'non-ASCII text reaches jsPDF outside sanitizePdfText(...)'
        : 'user text reaches jsPDF without sanitizePdfText(...)';
    console.error(`  ${v.file}:${v.line}  [${label}]`);
    console.error(`    ${v.text}`);
  }
  console.error(
    `\njsPDF's Standard-14 Helvetica font cannot draw characters outside the\n` +
      `WinAnsi (Windows-1252) range; such text renders as garbled glyphs. Route\n` +
      `the text through sanitizePdfText(...) from client/src/lib/pdfText.ts (it\n` +
      `remaps em-dashes, curly quotes, ellipses, etc. to renderable bytes). Pure\n` +
      `ASCII string literals are already safe; if a flagged line is a genuine\n` +
      `false positive, add "file:line" to ALLOWED_LINES in this script.\n`,
  );
  if (nonAscii.length) console.error(`  non-ASCII literals : ${nonAscii.length}`);
  if (unsanitized.length) console.error(`  unsanitized values : ${unsanitized.length}`);
  process.exit(1);
} else {
  console.log(
    '\x1b[32m%s\x1b[0m',
    'All jsPDF text sinks route user/non-ASCII text through sanitizePdfText.',
  );
}
