#!/usr/bin/env node
// Guard: prevent other heavily-indexed Dexie tables from silently regaining
// (or newly gaining) a dead index — the same problem task #2119/#2123 solved
// for the `records` table (see scripts/check-records-index-usage.js), applied
// to every other multi-index table in client/src/lib/database.ts.
//
// Every insert into a table pays one IndexedDB B-tree write per declared
// index, so a careless copy-paste of an older `this.version(N).stores(...)`
// block (or a new index added without a real caller) silently reintroduces
// bulk-insert cost with zero read-side benefit.
//
// Task #2127's audit walked every `.where()`/`.orderBy()` call site (literal
// and dynamic-dispatch) for blockchainTransactions, transactionParticipants,
// utxoLineage, custodySegments, lineageSnapshots, priceData, skippedAddresses,
// addressSyncState, attachments, evidence, and derivationTemplates. That
// audit found a large amount of PRE-EXISTING dead-index bloat, catalogued per
// table with its reasoning at the time. Task #2142 re-verified every
// catalogued token against the current codebase (a fresh, multi-line-aware
// scan of every table-qualified `.where()`/`.orderBy()` call site — the
// original audit had one false positive: priceData's `[date+currency+asset]`
// compound index DOES have real callers via a call chain spanning multiple
// source lines) and removed the genuinely dead ones from their
// `this.version(N).stores({...})` declaration in schema v41, mirroring the
// v40 `records` cleanup. Each removed token now lives in that table's
// `denylist` map below so it can never silently reappear.
//
// This guard does not remove indexes itself — it PINS the current, audited
// index set for each table and fails the moment any new (uncatalogued) index
// shows up with no real caller, or a denylisted one reappears, so the bloat
// this audit found and removed cannot silently regress.
//
// This guard has the same three layers as check-records-index-usage.js:
//
//   1. PIN — the live index token set for each table (parsed out of the
//      highest `this.version(N).stores({...})` block in database.ts that
//      declares that table — tables use delta declarations, so most versions
//      omit a table that didn't change) must exactly match the pinned set
//      below. Any addition, removal, or rename is a deliberate, reviewed
//      diff: update that table's `expectedTokens` in the same change.
//
//   2. DENYLIST — indexes proven dead AND actually removed from a table's
//      schema (mirroring the `records` v40 precedent) are named explicitly
//      per table, so a reintroduction fails immediately with a specific,
//      actionable message. Task #2142 populated these from the audit above.
//
//   3. BEST-EFFORT USAGE SCAN — every pinned token is checked against real
//      `.where()`/`.orderBy()`/indexed-`.or()` usage in client/src. A token
//      already catalogued in that table's `knownUnused` map is skipped (with
//      its reason available via `--verbose`), everything else must have a
//      real caller (literal or recognized dynamic-dispatch) or the scan
//      fails.
//
// Test files (*.test.ts/tsx) are excluded from the usage scan: regression
// tests may exercise a dead-index shape deliberately.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATABASE_TS = path.resolve(ROOT, 'client/src/lib/database.ts');

// ---- Table configs (pin + denylist + known-unused catalog + dynamic dispatch) ----

const TABLE_CONFIGS = [
  {
    table: 'blockchainTransactions',
    expectedTokens: ['txid', 'blockTime'],
    denylist: new Map([
      ['blockHeight', 'no `.where()`/`.orderBy()` caller; blockHeight is only ever read as an in-memory row property, never used to look up or range-scan blockchainTransactions itself (removed in schema v41)'],
      ['syncedAt', 'no `.where()`/`.orderBy()` caller anywhere on blockchainTransactions (removed in schema v41)'],
      ['hasOpReturn', 'boolean field — IndexedDB rejects booleans as valid keys, so `.where(\'hasOpReturn\').equals(true)` throws a DataError; every real read filters in-memory via `.filter(tx => tx.hasOpReturn === true)` instead (removed in schema v41)'],
      ['rawFingerprintCaptured', 'boolean field — same unindexable-by-IndexedDB issue as hasOpReturn; only ever read as an in-memory property, never queried by index (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'transactionParticipants',
    expectedTokens: ['txid', 'role', 'address', 'recordId', '[prevTxid+prevVout]'],
    denylist: new Map([
      ['[txid+role]', 'no `.where(\'[txid+role]\')` caller anywhere; every real query narrows via the plain `txid`, `role`, `address`, `recordId`, or `[prevTxid+prevVout]` index instead (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'utxoLineage',
    expectedTokens: ['[spentTxid+spentVout]', '[createdTxid+createdVout]', 'spentAddress', 'createdAddress'],
    denylist: new Map([
      ['consumingTxid', 'no `.where()`/`.orderBy()` caller; read only as an in-memory row property (grouping/dedup, blockTime lookups) after loading rows by another index (removed in schema v41)'],
      ['segmentId', 'no `.where(\'segmentId\')` caller on utxoLineage anywhere — custodySegments has its OWN, separately-indexed `segmentId` field that IS queried; do not confuse the two when auditing this entry (removed in schema v41)'],
      ['spentOwned', 'boolean field — same unindexable-by-IndexedDB issue as blockchainTransactions.hasOpReturn; read only via in-memory `.filter()`/property access (removed in schema v41)'],
      ['createdOwned', 'boolean field — same unindexable-by-IndexedDB issue; only production reads are in-memory. A regression test queries it by index on a throwaway test DB, but that is fixture-only, never live app behavior (removed in schema v41)'],
      ['isChange', 'boolean field — same unindexable-by-IndexedDB issue; read only via in-memory property access (removed in schema v41)'],
      ['blockTime', 'no `.where()`/`.orderBy()` caller on utxoLineage; rows are sorted by blockTime only in-memory after being loaded by another index (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(['createdAddress', 'spentAddress']),
  },
  {
    table: 'custodySegments',
    expectedTokens: ['segmentId', '[originTxid+originVout]', 'originAddress', 'currentAddress'],
    denylist: new Map([
      ['status', 'no `.where(\'status\')` caller anywhere on custodySegments (removed in schema v41)'],
      ['parentSegmentId', 'no `.where(\'parentSegmentId\')` caller anywhere — and per the CustodySegment type comment this field is RESERVED and currently never populated (removed in schema v41)'],
      ['owner', 'no `.where(\'owner\')` caller on custodySegments (records.owner queries are a different table\'s index) (removed in schema v41)'],
      ['walletName', 'no `.where(\'walletName\')` caller on custodySegments (removed in schema v41)'],
      ['originDate', 'no `.where()`/`.orderBy()` caller; only read as an in-memory property for display/export (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'lineageSnapshots',
    expectedTokens: ['snapshotId'],
    denylist: new Map([
      ['targetType', 'no `.where()`/`.orderBy()` caller anywhere; lineageSnapshots rows are only ever looked up by `snapshotId` or paged by `id` (removed in schema v41)'],
      ['targetAddress', 'no `.where()`/`.orderBy()` caller anywhere on lineageSnapshots (removed in schema v41)'],
      ['targetSegmentId', 'no `.where()`/`.orderBy()` caller anywhere on lineageSnapshots (removed in schema v41)'],
      ['generatedAt', 'no `.where()`/`.orderBy()` caller anywhere on lineageSnapshots (removed in schema v41)'],
      ['disclosureLevel', 'no `.where()`/`.orderBy()` caller anywhere on lineageSnapshots (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'priceData',
    // NOTE: [date+currency+asset] was originally catalogued in KNOWN_UNUSED
    // by the task #2127 audit as having "no caller — the real lookup narrows
    // by the plain `date` index instead". Re-verification for this cleanup
    // (task #2142) found that catalogue entry was WRONG: price-data-crud.ts's
    // getPriceDataByKey() and getPriceDataByDateCurrencyAssetKeys() both do
    // `.where('[date+currency+asset]')`, and are called from real app code
    // (SourceOfFundsReport.tsx, PriceImport.tsx, StatementReport.tsx,
    // backup/analyze.ts) — a multi-line `db.priceData\n  .where(...)` call
    // chain that a naive same-line grep can miss. It stays pinned as used.
    expectedTokens: ['[date+currency+asset]', 'date', 'asset'],
    denylist: new Map([
      ['currency', 'no `.where(\'currency\')` caller; the one range query narrows by `date` alone and checks currency/asset via an in-memory `.and()` predicate (removed in schema v41)'],
      ['source', 'no `.where()`/`.orderBy()` caller anywhere on priceData (removed in schema v41)'],
      ['importedAt', 'no `.where()`/`.orderBy()` caller anywhere on priceData (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'skippedAddresses',
    expectedTokens: ['syncRunTimestamp'],
    denylist: new Map([
      ['address', 'no `.where(\'address\')` caller on skippedAddresses (addressBlacklist and addressSyncState have their OWN, separately-indexed `address` fields that ARE queried) (removed in schema v41)'],
      ['reason', 'no `.where()`/`.orderBy()` caller anywhere on skippedAddresses (removed in schema v41)'],
      ['dismissed', 'no `.where(\'dismissed\')` caller anywhere, despite being a numeric 0|1 flag that IS a valid IndexedDB key — dismiss/undismiss flows always filter the already-loaded list in memory (removed in schema v41)'],
      ['createdAt', 'no `.where()`/`.orderBy()` caller anywhere on skippedAddresses (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'addressSyncState',
    expectedTokens: ['address', 'lastSyncedAt'],
    denylist: new Map([
      ['recordId', 'no `.where(\'recordId\')` caller anywhere; addressSyncState is always looked up by `address`, paged by `id`, or ordered by `lastSyncedAt` (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'attachments',
    expectedTokens: ['recordId', 'identifier'],
    denylist: new Map([
      ['createdAt', 'no `.where()`/`.orderBy()` caller anywhere on attachments (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'evidence',
    expectedTokens: [],
    denylist: new Map([
      ['documentType', 'no `.where()`/`.orderBy()` caller anywhere; evidence-crud.ts reads the whole table via `.toArray()` and filters/sorts in memory (removed in schema v41)'],
      ['originalDate', 'no `.where()`/`.orderBy()` caller anywhere on evidence (removed in schema v41)'],
      ['tags', 'no `.where()`/`.orderBy()` caller anywhere on evidence (removed in schema v41)'],
      ['importance', 'no `.where()`/`.orderBy()` caller anywhere on evidence (removed in schema v41)'],
      ['createdAt', 'no `.where()`/`.orderBy()` caller anywhere on evidence (removed in schema v41)'],
      ['updatedAt', 'no `.where()`/`.orderBy()` caller anywhere on evidence (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
  {
    table: 'derivationTemplates',
    expectedTokens: [],
    denylist: new Map([
      ['fingerprint', 'no `.where()`/`.orderBy()` caller anywhere; derivation-templates-crud.ts reads the whole table via `.toArray()` (removed in schema v41)'],
      ['scriptType', 'no `.where()`/`.orderBy()` caller anywhere on derivationTemplates (removed in schema v41)'],
      ['owner', 'no `.where()`/`.orderBy()` caller anywhere on derivationTemplates (records.owner is a different table\'s index) (removed in schema v41)'],
      ['walletName', 'no `.where()`/`.orderBy()` caller anywhere on derivationTemplates (removed in schema v41)'],
      ['seedName', 'no `.where()`/`.orderBy()` caller anywhere on derivationTemplates (removed in schema v41)'],
      ['createdAt', 'no `.where()`/`.orderBy()` caller anywhere on derivationTemplates (removed in schema v41)'],
    ]),
    knownUnused: new Map(),
    dynamicDispatchFields: new Set(),
  },
];

// ---- Parse the live schema for a given table out of database.ts -------------

const databaseSrc = fs.readFileSync(DATABASE_TS, 'utf8');
const versionBlockPattern = /this\.version\((\d+)\)\.stores\(\{([\s\S]*?)\n\s*\}\)/g;
const versionBlocks = [...databaseSrc.matchAll(versionBlockPattern)].map(m => ({
  version: parseInt(m[1], 10),
  body: m[2],
}));

function findLiveSchema(table) {
  const tableFieldPattern = new RegExp(`\\b${table}:\\s*'([^']*)'`);
  let liveVersion = -1;
  let liveSchema = null;
  for (const { version, body } of versionBlocks) {
    const match = body.match(tableFieldPattern);
    if (match && version > liveVersion) {
      liveVersion = version;
      liveSchema = match[1];
    }
  }
  return { liveVersion, liveSchema };
}

function tokenize(schema) {
  return schema
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => t !== '++id' && t !== 'id') // primary key, not a secondary index
    .map(t => t.replace(/^[*&]/, '')); // multiEntry (*) / unique (&) markers don't affect the index name used in .where()
}

// ---- Usage scan helpers -------------------------------------------------------

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
  // .where('X') / .orderBy('X') use the index directly; .or('X') chains onto
  // an already-`.where()`'d collection but still requires X to be indexed
  // (Dexie throws a SchemaError otherwise), so it counts as real usage too.
  const pattern = new RegExp(`\\.(where|orderBy|or)\\(\\s*["']${escaped}["']\\s*\\)`);
  for (const src of sourceByFile.values()) {
    if (pattern.test(src)) return true;
  }
  return false;
}

function isDynamicallyDispatched(token, dynamicDispatchFields) {
  if (!dynamicDispatchFields.has(token)) return false;
  const literalArg = new RegExp(`["']${escapeForRegex(token)}["']`);
  for (const src of sourceByFile.values()) {
    if (literalArg.test(src)) return true;
  }
  return false;
}

// ---- Run the three layers for every configured table -------------------------

let failed = false;
const okSummaries = [];

for (const config of TABLE_CONFIGS) {
  const { table, expectedTokens, denylist, knownUnused, dynamicDispatchFields } = config;
  const { liveVersion, liveSchema } = findLiveSchema(table);

  if (!liveSchema) {
    console.error(`check-table-index-usage: could not find a \`${table}:\` schema declaration in database.ts — script assumptions broke.`);
    failed = true;
    continue;
  }

  const liveTokens = tokenize(liveSchema);
  const liveTokenSet = new Set(liveTokens);
  const expectedTokenSet = new Set(expectedTokens);

  // Layer 2: denylist — a proven-dead-and-removed index must not reappear.
  const reintroduced = [...denylist.keys()].filter(t => liveTokenSet.has(t));
  if (reintroduced.length > 0) {
    console.error(`check-table-index-usage: schema v${liveVersion} of \`${table}\` reintroduces an index proven dead by a prior audit:\n`);
    for (const t of reintroduced) {
      console.error(`  '${t}' — ${denylist.get(t)}`);
    }
    console.error(`\nIf this index now has a real .where()/.orderBy() caller, remove it from that denylist in scripts/check-table-index-usage.js and update its expectedTokens, explaining the caller in a comment.`);
    failed = true;
    continue;
  }

  // Layer 1: pin — any addition or removal must be a deliberate, reviewed diff.
  const added = liveTokens.filter(t => !expectedTokenSet.has(t));
  const removed = expectedTokens.filter(t => !liveTokenSet.has(t));
  if (added.length > 0 || removed.length > 0) {
    console.error(`check-table-index-usage: live \`${table}\` index set (schema v${liveVersion}) no longer matches the pinned set in scripts/check-table-index-usage.js.\n`);
    if (added.length > 0) {
      console.error(`  Added (verify each has a real .where()/.orderBy() caller before pinning): ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      console.error(`  Removed: ${removed.join(', ')}`);
    }
    console.error(`\nThis is expected for a deliberate schema change — update that table's expectedTokens entry in scripts/check-table-index-usage.js in the same change.`);
    failed = true;
    continue;
  }

  // Layer 3: best-effort usage scan, skipping already-catalogued dead tokens.
  const unused = [];
  for (const token of liveTokens) {
    if (knownUnused.has(token)) continue;
    if (hasLiteralUsage(token)) continue;
    if (isDynamicallyDispatched(token, dynamicDispatchFields)) continue;
    unused.push(token);
  }

  if (unused.length > 0) {
    console.error(`check-table-index-usage: no \`.where()\`/\`.orderBy()\` usage (literal or known dynamic-dispatch) found for these \`${table}\` index tokens:\n`);
    for (const t of unused) console.error(`  '${t}'`);
    console.error(`\nIf this is a genuine dead index, either drop it from the schema and expectedTokens, or catalogue it in that table's knownUnused map in scripts/check-table-index-usage.js with the audit evidence. If it is used but only via a dynamic field-name variable this script does not yet recognize, add it to that table's dynamicDispatchFields.`);
    failed = true;
    continue;
  }

  const pendingCount = [...knownUnused.keys()].filter(t => liveTokenSet.has(t)).length;
  okSummaries.push(
    `  \`${table}\` (schema v${liveVersion}): ${liveTokens.length} indexes pinned` +
    (pendingCount > 0 ? `, ${pendingCount} already-catalogued as dead pending a follow-up cleanup task` : '')
  );
}

if (failed) {
  process.exit(1);
}

console.log('check-table-index-usage: OK — every configured table\'s index set matches its pinned, audited list:');
for (const line of okSummaries) console.log(line);
