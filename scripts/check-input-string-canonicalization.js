#!/usr/bin/env node
//
// Guard: record lookups by inputString must canonicalize their keys.
//
// Records are stored with canonical identifiers (see
// client/src/lib/bitcoin.ts -> canonicalizeRecordIdentifier). Any NEW raw
// `db.records.where('inputString').equals(<uncanonicalized key>)` (or
// .anyOf / .equalsIgnoreCase / object-form .where({ inputString }) /
// .get({ inputString })) call site silently reintroduces the
// duplicate/invisible-record bug class that canonicalization fixed: the
// lookup key may be padded/uppercased while the stored value is canonical,
// so the lookup misses records.
//
// This script (same style as scripts/check-crud-guards.js) statically scans
// client/src for inputString / inputStringLower keyed lookups and:
//   - treats a call site as canonicalized when the lookup-key expression
//     mentions `canonical` (canonicalizeRecordIdentifier(...) itself, or a
//     local variable derived from it, conventionally named `canonical*`);
//   - ratchets the known raw call sites per file (they receive keys that are
//     already canonical upstream, or intentionally do fuzzy matching);
//   - fails when a NEW raw call site appears, or when the ratchet is stale
//     (fewer raw sites than expected -> tighten the ratchet).
//
// Dynamic-field call sites (e.g. `where(n.field)` in records-query.ts) are
// covered two ways: the narrow DESCRIPTORS that feed them
// (`{ ..., field: "inputString"|"inputStringLower", value: <expr> }`) are
// scanned here with the same canonical-mention heuristic, and the
// records-search-visibility / records-query unit suites prove the behavior.
//
// Test files (*.test.ts / *.test.tsx, client/src/test/) are excluded: tests
// intentionally seed and look up rows verbatim to emulate
// pre-canonicalization data.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SCAN_DIR = path.resolve(ROOT, 'client/src');
const EXTENSIONS = new Set(['.ts', '.tsx']);

// Ratchet: relative file path -> number of allowed RAW (uncanonicalized)
// inputString lookup call sites. These call sites receive keys that are
// canonical upstream (batch lookups over inputStrings read back from the DB
// itself, or sync paths whose addresses are already canonical), or perform
// deliberate case-insensitive fallback matching (merge-utils).
//
// If you add a NEW inputString lookup, canonicalize the key with
// canonicalizeRecordIdentifier (client/src/lib/bitcoin.ts) instead of adding
// to this list. Only bump a count here when the raw key is provably
// canonical already — and say why in a code comment at the call site.
const RAW_CALLSITE_RATCHET = {
  // Deliberate case-insensitive lookups via the inputStringLower index
  // (picker search prefix match, hidden-tier scans, targeted sync mapping):
  'client/src/lib/data/record-crud.ts': 3,
  'client/src/lib/psbt-metadata.ts': 1,
  'client/src/pages/TransactionSync.tsx': 1,
  // Dev-only seed helper; addresses are hardcoded canonical fixtures:
  'client/src/lib/testSeedData.ts': 1,
  'client/src/lib/wallet-import/merge-utils.ts': 2,
  'client/src/lib/data/address-stats.ts': 1,
  'client/src/lib/data/transaction-crud.ts': 1,
  'client/src/lib/data/fund-trail-engine.ts': 1,
  'client/src/lib/provenance.ts': 2,
  'client/src/lib/transaction-sync.ts': 2,
  'client/src/lib/lineageEngine.ts': 1,
  'client/src/lib/txid-backfill.ts': 2,
};

// Self-check: ratcheted files and the canonicalizer must exist, otherwise the
// guard silently rots.
const CANONICALIZER_FILE = path.resolve(ROOT, 'client/src/lib/bitcoin.ts');
const missing = [];
if (!fs.existsSync(SCAN_DIR)) missing.push('client/src (SCAN_DIR)');
if (!fs.existsSync(CANONICALIZER_FILE)) {
  missing.push('client/src/lib/bitcoin.ts (canonicalizer home)');
} else if (
  !fs
    .readFileSync(CANONICALIZER_FILE, 'utf-8')
    .includes('function canonicalizeRecordIdentifier')
) {
  missing.push(
    'canonicalizeRecordIdentifier in client/src/lib/bitcoin.ts (moved/renamed?)'
  );
}
for (const rel of Object.keys(RAW_CALLSITE_RATCHET)) {
  if (!fs.existsSync(path.resolve(ROOT, rel))) missing.push(`${rel} (ratchet entry)`);
}
if (missing.length > 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    'check-input-string-canonicalization self-check failed: expected reference(s) missing:\n'
  );
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    '\n  -> If a file was renamed/moved, update RAW_CALLSITE_RATCHET / CANONICALIZER_FILE in scripts/check-input-string-canonicalization.js.'
  );
  process.exit(1);
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

function isTestFile(rel) {
  return (
    /\.test\.(ts|tsx)$/.test(rel) ||
    rel.startsWith('client/src/test/') ||
    rel.includes('/__tests__/')
  );
}

// Extract a balanced-paren argument expression starting at `start` (index of
// the opening paren) in `src`. Best-effort: does not parse strings, which is
// fine for these call sites.
function extractArg(src, start) {
  let depth = 0;
  for (let i = start; i < src.length && i < start + 2000; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return src.slice(start + 1, start + 300); // unbalanced: return a window
}

const LOOKUP_METHODS =
  '(equals|equalsIgnoreCase|anyOf|anyOfIgnoreCase|startsWith|startsWithIgnoreCase|noneOf)';

// .where('inputString') / .where("inputString") / same for inputStringLower,
// followed (possibly across lines) by a lookup method call.
const WHERE_PATTERN = new RegExp(
  String.raw`\.where\(\s*['"\`](inputString|inputStringLower)['"\`]\s*\)\s*(?:\r?\n\s*)?\.${LOOKUP_METHODS}\s*\(`,
  'g'
);
// Object-form lookups: .where({ inputString: X }) / .get({ inputString: X })
const OBJECT_PATTERN = new RegExp(
  String.raw`\.(where|get)\(\s*\{[^}]*\binputString(?:Lower)?\s*:`,
  'g'
);
// Query-planner narrow descriptors (records-query.ts style): an object literal
// that targets the inputString/inputStringLower index by name and carries the
// lookup key in a sibling `value:` property. These descriptors are executed
// later via a dynamic `db.records.where(n.field)`, which the WHERE_PATTERN can
// never see — so the canonicalization heuristic is applied to the value
// expression here instead.
const NARROW_DESCRIPTOR_PATTERN = new RegExp(
  String.raw`\bfield:\s*["'\`](inputString|inputStringLower)["'\`]\s*,\s*value:\s*([^,}\r\n]+)`,
  'g'
);

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

const files = collectFiles(SCAN_DIR);
const rawByFile = new Map(); // rel -> [{line, snippet}]
let canonicalizedSites = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (isTestFile(rel)) continue;
  const src = fs.readFileSync(file, 'utf-8');
  if (!src.includes('inputString')) continue;

  const rawHits = [];

  WHERE_PATTERN.lastIndex = 0;
  let m;
  while ((m = WHERE_PATTERN.exec(src)) !== null) {
    const argStart = m.index + m[0].length - 1; // index of '('
    const arg = extractArg(src, argStart);
    if (/canonical/i.test(arg)) {
      canonicalizedSites++;
    } else {
      rawHits.push({
        line: lineOf(src, m.index),
        snippet: src.slice(m.index, argStart + 1 + Math.min(arg.length, 80)).replace(/\s+/g, ' ').trim(),
      });
    }
  }

  OBJECT_PATTERN.lastIndex = 0;
  while ((m = OBJECT_PATTERN.exec(src)) !== null) {
    // Look at the full object literal window for a canonicalized value.
    const window = src.slice(m.index, m.index + 300);
    if (/canonical/i.test(window)) {
      canonicalizedSites++;
    } else {
      rawHits.push({
        line: lineOf(src, m.index),
        snippet: window.split('\n')[0].trim(),
      });
    }
  }

  NARROW_DESCRIPTOR_PATTERN.lastIndex = 0;
  while ((m = NARROW_DESCRIPTOR_PATTERN.exec(src)) !== null) {
    const valueExpr = m[2];
    if (/canonical/i.test(valueExpr)) {
      canonicalizedSites++;
    } else {
      rawHits.push({
        line: lineOf(src, m.index),
        snippet: m[0].replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }

  if (rawHits.length > 0) rawByFile.set(rel, rawHits);
}

// Sanity: the canonicalized call sites we know about must be detectable. If
// the pattern ever matches zero canonicalized sites, the regexes have rotted.
if (canonicalizedSites === 0) {
  console.error(
    '\x1b[31m%s\x1b[0m',
    'check-input-string-canonicalization self-check failed: found ZERO canonicalized inputString lookups.\n' +
      '  The detection patterns have likely rotted (record-crud.ts alone has several). Fix the script.'
  );
  process.exit(1);
}

let failed = false;

// New raw call sites (file not ratcheted, or count grew).
for (const [rel, hits] of [...rawByFile.entries()].sort()) {
  const allowed = RAW_CALLSITE_RATCHET[rel] ?? 0;
  if (hits.length > allowed) {
    failed = true;
    console.error(
      '\x1b[31m%s\x1b[0m',
      `${rel}: ${hits.length} raw inputString lookup(s), ratchet allows ${allowed}:`
    );
    for (const h of hits) console.error(`  line ${h.line}: ${h.snippet}`);
    console.error(
      '  -> Canonicalize the lookup key with canonicalizeRecordIdentifier (client/src/lib/bitcoin.ts).\n' +
        '     Records store canonical identifiers; raw keys can silently miss records.\n'
    );
  }
}

// Stale ratchet (call sites removed or file no longer raw) — tighten it.
for (const [rel, allowed] of Object.entries(RAW_CALLSITE_RATCHET)) {
  const actual = rawByFile.get(rel)?.length ?? 0;
  if (actual < allowed) {
    failed = true;
    console.error(
      '\x1b[31m%s\x1b[0m',
      `${rel}: ratchet is stale — allows ${allowed} raw lookup(s) but only ${actual} found.`
    );
    console.error(
      '  -> Lower this file\'s count in RAW_CALLSITE_RATCHET (scripts/check-input-string-canonicalization.js)\n' +
        '     so removed raw call sites cannot silently come back.\n'
    );
  }
}

if (failed) {
  process.exit(1);
}

const totalRaw = [...rawByFile.values()].reduce((n, v) => n + v.length, 0);
console.log(
  '\x1b[32m%s\x1b[0m',
  `inputString lookup canonicalization clean: ${canonicalizedSites} canonicalized site(s), ${totalRaw} ratcheted raw site(s), no new raw lookups.`
);
