#!/usr/bin/env node
// Guard: prevent the `records` table from silently regaining a dead index.
//
// Task #2119 dropped four indexes from `records` (schema v40: `syncDepth`,
// `flowType`, the compound `[owner+id]`, and `[walletName+id]`) after
// auditing every `.where()`/`.orderBy()` call site — including the dynamic
// column-filter planner in records-query.ts, the vocabulary rename/count
// helpers, and the group-by-index ternary in record-crud.ts — and confirming
// none of the four is ever queried by index. Every `records` insert pays one
// IndexedDB B-tree write per declared index, so a careless copy-paste of an
// older `this.version(N).stores(...)` block (or a new index added without a
// real caller) silently reintroduces that bulk-insert cost.
//
// This guard has three layers:
//
//   1. PIN — the live `records` index token set (parsed out of the highest
//      `this.version(N).stores({...})` block in database.ts that declares
//      `records`) must exactly match the token set pinned below. Any
//      addition, removal, or rename is a deliberate, reviewed diff: update
//      EXPECTED_RECORDS_INDEX_TOKENS in the same change, with a comment
//      explaining the new index's real caller (mirroring the audit comment
//      already on the v40 declaration in database.ts).
//
//   2. DENYLIST — the four indexes removed by task #2119 are named
//      explicitly. Even if someone updates the pin above without noticing,
//      this still fails with a specific, actionable message naming exactly
//      why that index was dead. Removing an entry here is itself a
//      deliberate, reviewable edit to this script.
//
//   3. BEST-EFFORT USAGE SCAN — every pinned token is checked against real
//      `.where()`/`.orderBy()` usage in client/src. Fields that the query
//      planner or vocabulary helpers dispatch through a variable (so no
//      literal `.where('fieldName')` exists in source) are recognized via
//      their own dynamic-dispatch sites rather than trusted blindly.
//
// Test files (*.test.ts/tsx) are excluded from the usage scan: regression
// tests may exercise a dead-index shape deliberately.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATABASE_TS = path.resolve(ROOT, 'client/src/lib/database.ts');
const RECORDS_QUERY_TS = path.resolve(ROOT, 'client/src/lib/records-query.ts');

// ---- 1. Pinned expectation (update deliberately alongside a real schema change) ----

// Exact `records` index token set as of schema v40. Order does not matter —
// compared as a set — but every token here must be one this script (or a
// human auditor) has verified has a real caller.
const EXPECTED_RECORDS_INDEX_TOKENS = new Set([
  'type',
  'inputString',
  'inputStringLower',
  'label',
  'owner',
  'walletName',
  'seedName',
  'walletSoftware',
  'tags',
  'categories',
  'createdAt',
  'updatedAt',
  'chainType',
  'addressImportance',
  '[type+addressImportance]',
  '[addressImportance+id]',
  '[type+id]',
  'discoveredFromRecordId',
]);

// ---- 2. Denylist: indexes proven dead by the task #2119 audit ----------------

const DENYLISTED_TOKENS = new Map([
  ['syncDepth', 'read only in-memory off already-loaded rows; never queried by index (removed in schema v40)'],
  ['flowType', 'read only in-memory off already-loaded rows; never queried by index (removed in schema v40)'],
  ['[owner+id]', 'no literal `.where(\'[owner+id]\')` caller anywhere; owner narrowing uses the plain `owner` index instead (removed in schema v40)'],
  ['[walletName+id]', 'no literal `.where(\'[walletName+id]\')` caller anywhere; walletName narrowing uses the plain `walletName` index instead (removed in schema v40)'],
]);

// ---- 3. Fields dispatched through a variable, not a source-literal `.where()` ----

// records-query.ts's `classifyFilter` narrows via `db.records.where(n.field)`
// where `n.field` is one of the field names it switches on; vocabulary-crud.ts's
// `propagateStringFieldRename(field, ...)` and record-crud.ts's group-by
// `indexField` ternary do the same. A plain source grep for `.where('X')`
// will never find these, so they are verified by locating their own
// dynamic-dispatch call sites instead of being exempted blindly.
const DYNAMIC_DISPATCH_FIELDS = new Set([
  'type',
  'addressImportance',
  'chainType',
  'tags',
  'categories',
  'label',
  'owner',
  'walletName',
  'seedName',
  'walletSoftware',
]);

// ---- Parse the live `records` schema out of database.ts ---------------------

const databaseSrc = fs.readFileSync(DATABASE_TS, 'utf8');

const versionBlockPattern = /this\.version\((\d+)\)\.stores\(\{([\s\S]*?)\n\s*\}\)/g;
let liveVersion = -1;
let liveSchema = null;
for (const m of databaseSrc.matchAll(versionBlockPattern)) {
  const version = parseInt(m[1], 10);
  const body = m[2];
  const recordsMatch = body.match(/records:\s*'([^']*)'/);
  if (recordsMatch && version > liveVersion) {
    liveVersion = version;
    liveSchema = recordsMatch[1];
  }
}

if (!liveSchema) {
  console.error('check-records-index-usage: could not find a `records:` schema declaration in database.ts — script assumptions broke.');
  process.exit(1);
}

const liveTokens = liveSchema
  .split(',')
  .map(t => t.trim())
  .filter(Boolean)
  .filter(t => t !== '++id') // primary key, not an index
  .map(t => t.replace(/^\*/, '')); // multiEntry marker; token itself is unaffected for compound/bracket forms

const liveTokenSet = new Set(liveTokens);

// ---- Layer 2: denylist check (runs first — most specific failure message) ----

const reintroduced = [...DENYLISTED_TOKENS.keys()].filter(t => liveTokenSet.has(t));
if (reintroduced.length > 0) {
  console.error(`check-records-index-usage: schema v${liveVersion} of \`records\` reintroduces an index proven dead by the task #2119 audit:\n`);
  for (const t of reintroduced) {
    console.error(`  '${t}' — ${DENYLISTED_TOKENS.get(t)}`);
  }
  console.error('\nIf this index now has a real `.where()`/`.orderBy()` caller, remove it from DENYLISTED_TOKENS in scripts/check-records-index-usage.js and update EXPECTED_RECORDS_INDEX_TOKENS, explaining the caller in a comment (mirroring the v40 audit comment in database.ts).');
  process.exit(1);
}

// ---- Layer 1: pin check -------------------------------------------------------

const added = liveTokens.filter(t => !EXPECTED_RECORDS_INDEX_TOKENS.has(t));
const removed = [...EXPECTED_RECORDS_INDEX_TOKENS].filter(t => !liveTokenSet.has(t));

if (added.length > 0 || removed.length > 0) {
  console.error(`check-records-index-usage: live \`records\` index set (schema v${liveVersion}) no longer matches the pinned set in scripts/check-records-index-usage.js.\n`);
  if (added.length > 0) {
    console.error(`  Added (verify each has a real .where()/.orderBy() caller before pinning): ${added.join(', ')}`);
  }
  if (removed.length > 0) {
    console.error(`  Removed: ${removed.join(', ')}`);
  }
  console.error('\nThis is expected for a deliberate schema change — update EXPECTED_RECORDS_INDEX_TOKENS in scripts/check-records-index-usage.js in the same change, with a comment naming the real caller of any newly added index.');
  process.exit(1);
}

// ---- Layer 3: best-effort real-usage scan -------------------------------------

function escapeForRegex(token) {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

const sourceFiles = [...walk(path.resolve(ROOT, 'client/src'))];
const sourceByFile = new Map(sourceFiles.map(f => [f, fs.readFileSync(f, 'utf8')]));

function hasLiteralUsage(token) {
  const escaped = escapeForRegex(token);
  const pattern = new RegExp(`\\.(where|orderBy)\\(\\s*["']${escaped}["']\\s*\\)`);
  for (const src of sourceByFile.values()) {
    if (pattern.test(src)) return true;
  }
  return false;
}

// Dynamic-dispatch fields are verified via their own known call sites rather
// than a literal `.where('fieldName')` grep — see DYNAMIC_DISPATCH_FIELDS
// comment above for why a plain grep can't see them.
const recordsQuerySrc = fs.readFileSync(RECORDS_QUERY_TS, 'utf8');
function isDynamicallyDispatched(token) {
  if (!DYNAMIC_DISPATCH_FIELDS.has(token)) return false;
  // records-query.ts's classifyFilter switches on the field name as a string
  // literal (`case "X":`) before using it as a dynamic `.where(n.field)` key.
  const caseLiteral = new RegExp(`case\\s+["']${escapeForRegex(token)}["']\\s*:`);
  if (caseLiteral.test(recordsQuerySrc)) return true;
  // vocabulary-crud.ts / record-crud.ts pass the field name as a string
  // literal into a helper that then does `.where(field)` / `.where(indexField)`.
  const literalArg = new RegExp(`["']${escapeForRegex(token)}["']`);
  for (const [file, src] of sourceByFile) {
    if (path.basename(file) === 'vocabulary-crud.ts' || path.basename(file) === 'record-crud.ts') {
      if (literalArg.test(src)) return true;
    }
  }
  return false;
}

const unused = [];
for (const token of liveTokens) {
  if (hasLiteralUsage(token)) continue;
  if (isDynamicallyDispatched(token)) continue;
  unused.push(token);
}

if (unused.length > 0) {
  console.error(`check-records-index-usage: no \`.where()\`/\`.orderBy()\` usage (literal or known dynamic-dispatch) found for these \`records\` index tokens:\n`);
  for (const t of unused) console.error(`  '${t}'`);
  console.error('\nIf this is a genuine dead index, drop it from the schema (like task #2119) and remove it from EXPECTED_RECORDS_INDEX_TOKENS. If it is used but only via a dynamic field-name variable this script does not yet recognize, add that call site to the isDynamicallyDispatched() check in scripts/check-records-index-usage.js.');
  process.exit(1);
}

console.log(`check-records-index-usage: OK — schema v${liveVersion} \`records\` index set (${liveTokens.length} indexes) matches the pinned, audited list and every token has a real caller.`);
