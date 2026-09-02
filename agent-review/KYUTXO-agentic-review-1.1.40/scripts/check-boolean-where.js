#!/usr/bin/env node
// Guard: flag Dexie `.where('<booleanField>')` lookups on boolean-typed fields.
//
// Booleans are not valid IndexedDB keys, so `where(field).equals(true)`
// throws DataError at query time, and `where(field).equals(1)` silently
// matches ZERO rows. Both failure modes have shipped stale-count bugs
// (OP_RETURN totals via hasOpReturn; custody-segment origin scan via
// createdOwned). Readers must use boolean-safe `.filter()` scans instead.
//
// The boolean field list is derived automatically:
//   1. Every `name: boolean` / `name?: boolean` property in
//      client/src/lib/db-types.ts.
//   2. Intersected with every index token declared in a `.stores({...})`
//      schema string in client/src/lib/database.ts.
// So newly indexed boolean fields are guarded without touching this script.
//
// Test files (*.test.ts/tsx) are excluded: regression tests deliberately
// exercise the throwing indexed path to pin the failure mode.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---- 1. Boolean-typed field names from db-types.ts --------------------------

const dbTypesSrc = fs.readFileSync(
  path.resolve(ROOT, 'client/src/lib/db-types.ts'),
  'utf8',
);
const booleanFields = new Set();
for (const m of dbTypesSrc.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:\s*boolean\b/gm)) {
  booleanFields.add(m[1]);
}

// Names that appear as `x: boolean` somewhere in db-types.ts (UI-preference
// interfaces like fieldVisibility/tableColumns/pdf options) but whose
// SAME-NAMED indexed table column is a non-boolean type (string/array on
// records, vocabulary tables, etc.). These are safe to query with .where().
const NON_BOOLEAN_INDEX_HOMONYMS = new Set([
  'walletName', 'seedName', 'owner', 'tags', 'categories',
  'walletSoftware', 'source', 'balance', 'firstSeen', 'txCount',
  'lastTxDate', 'privateKeyStatus', 'hasAttachments', 'name', 'type',
]);
for (const f of NON_BOOLEAN_INDEX_HOMONYMS) booleanFields.delete(f);

// ---- 2. Indexed field names from database.ts schema strings ------------------

const databaseSrc = fs.readFileSync(
  path.resolve(ROOT, 'client/src/lib/database.ts'),
  'utf8',
);
const indexedTokens = new Set();
// Schema strings look like: tableName: '++id, &txid, blockHeight, hasOpReturn, ...'
for (const m of databaseSrc.matchAll(/:\s*'([^']*)'/g)) {
  const schema = m[1];
  if (!/(\+\+|&|\[|,)/.test(schema)) continue; // not a stores() index string
  for (const raw of schema.split(',')) {
    const token = raw.trim().replace(/^(\+\+|&|\*)/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) indexedTokens.add(token);
  }
}

const guardedFields = [...booleanFields].filter(f => indexedTokens.has(f)).sort();

if (guardedFields.length === 0) {
  console.error('check-boolean-where: derived guarded field list is empty — script assumptions broke.');
  process.exit(1);
}

// ---- 3. Scan client/src for .where('<guardedField>') -------------------------

const wherePattern = new RegExp(
  `\\.where\\(\\s*["'](${guardedFields.join('|')})["']\\s*\\)`,
);

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

function stripComments(line) {
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

const violations = [];
for (const file of walk(path.resolve(ROOT, 'client/src'))) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = stripComments(line);
    const m = code.match(wherePattern);
    if (m) {
      violations.push(`${path.relative(ROOT, file)}:${i + 1}: .where('${m[1]}') — '${m[1]}' is a boolean field; booleans are not valid IndexedDB keys. Use a .filter() scan (see transaction-crud.ts countTransactionsWithOpReturn or lineageEngine.ts scanOwnedLineageOrigins).`);
    }
  });
}

if (violations.length > 0) {
  console.error('check-boolean-where: indexed-boolean Dexie lookups found (silent stale-data risk):\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\nGuarded boolean fields (auto-derived): ${guardedFields.join(', ')}`);
  process.exit(1);
}

console.log(`check-boolean-where: OK — no .where() lookups on indexed boolean fields (guarding: ${guardedFields.join(', ')}).`);
