// Tests for the generalized multi-table index-usage guard (task #2127):
// verifies it fires on each of its three protection layers (denylist, pin,
// best-effort usage scan) for the tables it covers, instead of only ever
// passing on the current, already-audited schema.
//
// Run with: node --test scripts/check-table-index-usage.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SCANNER = path.resolve(path.dirname(__filename), 'check-table-index-usage.js');
const scannerSrc = fs.readFileSync(SCANNER, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The scanner derives ROOT from __dirname (breaks when copied to a temp
// dir) and reads DATABASE_TS off of it. We fix ROOT to the real project root
// (so the client/src usage scan still runs against real source) and swap
// DATABASE_TS for a fixture file the test controls.
const ROOT_NEEDLE = "const ROOT = path.resolve(__dirname, '..');";
const ROOT_REPLACEMENT = `const ROOT = ${JSON.stringify(ROOT)};`;
assert.ok(
  scannerSrc.includes(ROOT_NEEDLE),
  `ROOT derivation line not found in scanner source — update ROOT_NEEDLE in this test:\n  ${ROOT_NEEDLE}`
);

const DATABASE_TS_NEEDLE = "const DATABASE_TS = path.resolve(ROOT, 'client/src/lib/database.ts');";
assert.ok(
  scannerSrc.includes(DATABASE_TS_NEEDLE),
  `DATABASE_TS derivation line not found in scanner source — update DATABASE_TS_NEEDLE in this test:\n  ${DATABASE_TS_NEEDLE}`
);

const baseSrc = scannerSrc.replace(ROOT_NEEDLE, ROOT_REPLACEMENT);

// Real, currently-live schema strings (copied verbatim from database.ts) for
// every table this guard covers, minus the leading `++id, ` primary key.
const LIVE_SCHEMAS = {
  attachments: 'recordId, createdAt, identifier',
  blockchainTransactions: '&txid, blockHeight, blockTime, syncedAt, hasOpReturn, rawFingerprintCaptured',
  transactionParticipants: '[txid+role], txid, role, address, recordId, [prevTxid+prevVout]',
  addressSyncState: '&address, recordId, lastSyncedAt',
  derivationTemplates: 'fingerprint, scriptType, owner, walletName, seedName, createdAt',
  utxoLineage: '[spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime',
  custodySegments: '&segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate',
  lineageSnapshots: '&snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel',
  evidence: 'documentType, originalDate, *tags, importance, createdAt, updatedAt',
  priceData: '[date+currency+asset], date, asset, currency, source, importedAt',
  skippedAddresses: 'address, reason, syncRunTimestamp, dismissed, createdAt',
};

function makeDatabaseFixture(overrides = {}) {
  const schemas = { ...LIVE_SCHEMAS, ...overrides };
  const storesBody = Object.entries(schemas)
    .map(([table, tokens]) => `      ${table}: '++id, ${tokens}',`)
    .join('\n');
  return `
export const CURRENT_SCHEMA_VERSION = 999;
class FixtureDb {
  constructor() {
    this.version(999).stores({
${storesBody}
    });
  }
}
`;
}

/**
 * Write a modified copy of the scanner (and a database.ts fixture) to a temp
 * dir, run it, then clean up. Returns the spawnSync result.
 */
function runScanner({ scriptPatches = [], schemaOverrides = {} } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-index-guard-test-'));
  try {
    const fixtureDbPath = path.join(tmpDir, 'database.fixture.ts');
    fs.writeFileSync(fixtureDbPath, makeDatabaseFixture(schemaOverrides));

    let src = baseSrc.replace(
      DATABASE_TS_NEEDLE,
      `const DATABASE_TS = ${JSON.stringify(fixtureDbPath)};`
    );
    for (const [needle, replacement] of scriptPatches) {
      assert.ok(src.includes(needle), `patch needle not found in scanner source: ${needle}`);
      src = src.replace(needle, replacement);
    }

    const tmpScanner = path.join(tmpDir, 'check-table-index-usage.js');
    fs.writeFileSync(tmpScanner, src);
    return spawnSync('node', [tmpScanner], { cwd: ROOT, encoding: 'utf8' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Sanity: the guard passes against the real, unmodified live schema for
// every configured table.
// ---------------------------------------------------------------------------

test('passes against the real, unmodified schema for every configured table', () => {
  const result = runScanner({});
  assert.equal(
    result.status,
    0,
    `expected exit 0 against the live schema, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stdout, /OK/);
  for (const table of Object.keys(LIVE_SCHEMAS)) {
    assert.match(result.stdout, new RegExp(`\`${table}\``));
  }
});

// ---------------------------------------------------------------------------
// Layer 2 (denylist): a proven-dead-and-removed index reappearing must fail
// immediately, with an actionable message, even before the pin comparison.
// Since no index has actually been removed from any of these tables yet
// (that is deliberately left to a follow-up cleanup task — see the guard's
// header comment), this exercises the mechanism with a synthetic denylist
// entry patched into blockchainTransactions' config.
// ---------------------------------------------------------------------------

const BLOCKCHAIN_TX_DENYLIST_NEEDLE = "table: 'blockchainTransactions',\n    expectedTokens: ['txid', 'blockHeight', 'blockTime', 'syncedAt', 'hasOpReturn', 'rawFingerprintCaptured'],\n    denylist: new Map(),";
const BLOCKCHAIN_TX_DENYLIST_REPLACEMENT = "table: 'blockchainTransactions',\n    expectedTokens: ['txid', 'blockHeight', 'blockTime', 'syncedAt', 'hasOpReturn', 'rawFingerprintCaptured'],\n    denylist: new Map([['syncedAt', 'synthetic test denylist entry']]),";

test('fails when a synthetically denylisted index reappears', () => {
  const result = runScanner({
    scriptPatches: [[BLOCKCHAIN_TX_DENYLIST_NEEDLE, BLOCKCHAIN_TX_DENYLIST_REPLACEMENT]],
  });
  assert.equal(
    result.status,
    1,
    `expected exit 1 when a denylisted index reappears, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /proven dead by a prior audit/);
  assert.match(result.stderr, /'syncedAt'/);
});

// ---------------------------------------------------------------------------
// Layer 1 (pin): any addition or removal not already denylisted must force a
// deliberate update to that table's expectedTokens.
// ---------------------------------------------------------------------------

test('fails when a brand-new, unpinned index is added to a covered table', () => {
  const result = runScanner({
    schemaOverrides: { addressSyncState: `${LIVE_SCHEMAS.addressSyncState}, brandNewIndexField` },
  });
  assert.equal(
    result.status,
    1,
    `expected exit 1 for an unpinned new index, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /no longer matches the pinned set/);
  assert.match(result.stderr, /addressSyncState/);
  assert.match(result.stderr, /Added.*brandNewIndexField/);
});

test('fails when a pinned index is removed from a covered table', () => {
  const withoutLastSyncedAt = LIVE_SCHEMAS.addressSyncState.replace(', lastSyncedAt', '');
  assert.notEqual(withoutLastSyncedAt, LIVE_SCHEMAS.addressSyncState, 'fixture setup should actually drop lastSyncedAt');
  const result = runScanner({
    schemaOverrides: { addressSyncState: withoutLastSyncedAt },
  });
  assert.equal(
    result.status,
    1,
    `expected exit 1 when a pinned index is removed, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /no longer matches the pinned set/);
  assert.match(result.stderr, /Removed.*lastSyncedAt/);
});

// ---------------------------------------------------------------------------
// Layer 3 (best-effort usage scan): even a pinned index must have a real
// caller (or be explicitly catalogued as already-known-dead), or the scan
// must still fail for a brand-new, uncatalogued token.
// ---------------------------------------------------------------------------

const ADDRESS_SYNC_STATE_CONFIG_NEEDLE = "table: 'addressSyncState',\n    expectedTokens: ['address', 'recordId', 'lastSyncedAt'],\n    denylist: new Map(),";
const ADDRESS_SYNC_STATE_CONFIG_REPLACEMENT = "table: 'addressSyncState',\n    expectedTokens: ['address', 'recordId', 'lastSyncedAt', 'phantomUnusedIndex'],\n    denylist: new Map(),";

test('fails when a pinned index has no real .where()/.orderBy() caller and is not catalogued as known-unused', () => {
  const result = runScanner({
    schemaOverrides: { addressSyncState: `${LIVE_SCHEMAS.addressSyncState}, phantomUnusedIndex` },
    scriptPatches: [[ADDRESS_SYNC_STATE_CONFIG_NEEDLE, ADDRESS_SYNC_STATE_CONFIG_REPLACEMENT]],
  });
  assert.equal(
    result.status,
    1,
    `expected exit 1 for a pinned-but-unused, uncatalogued index, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /no `\.where\(\)`\/`\.orderBy\(\)` usage/);
  assert.match(result.stderr, /'phantomUnusedIndex'/);
});

test('does not fail on a token already catalogued in knownUnused (e.g. addressSyncState.recordId)', () => {
  // recordId is already catalogued as known-dead in the real config; sanity
  // check it doesn't trip Layer 3 even though it genuinely has no caller.
  const result = runScanner({});
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /'recordId'/);
});

// ---------------------------------------------------------------------------
// Dynamic-dispatch exemption: utxoLineage.createdAddress/spentAddress are
// used via a `role === 'created' ? 'createdAddress' : 'spentAddress'`
// ternary in fund-trail-engine.ts as well as directly — confirm the real
// scan recognizes at least the literal usage (regression guard for the
// dynamicDispatchFields mechanism itself).
// ---------------------------------------------------------------------------

test('recognizes utxoLineage.createdAddress/spentAddress as used', () => {
  const result = runScanner({});
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /'createdAddress'/);
  assert.doesNotMatch(result.stderr, /'spentAddress'/);
});
