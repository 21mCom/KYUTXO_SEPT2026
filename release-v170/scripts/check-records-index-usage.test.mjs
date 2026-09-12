// Tests for the `records` index-usage guard: verifies it fires on each of
// its three protection layers (denylist, pin, best-effort usage scan)
// instead of only ever passing on the current, already-clean schema.
//
// Run with: node --test scripts/check-records-index-usage.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SCANNER = path.resolve(path.dirname(__filename), 'check-records-index-usage.js');
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

const EXPECTED_TOKENS_CLOSE_NEEDLE = "  'discoveredFromRecordId',\n]);";
assert.ok(
  scannerSrc.includes(EXPECTED_TOKENS_CLOSE_NEEDLE),
  `EXPECTED_RECORDS_INDEX_TOKENS closing needle not found — update EXPECTED_TOKENS_CLOSE_NEEDLE in this test:\n  ${EXPECTED_TOKENS_CLOSE_NEEDLE}`
);

const baseSrc = scannerSrc.replace(ROOT_NEEDLE, ROOT_REPLACEMENT);

// Real, currently-live records schema string (schema v40) minus the trailing
// quote/close, so each test can splice in its own modification.
const LIVE_SCHEMA_TOKENS =
  "++id, type, inputString, inputStringLower, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, chainType, addressImportance, [type+addressImportance], [addressImportance+id], [type+id], discoveredFromRecordId";

function makeDatabaseFixture(schemaTokens) {
  return `
export const CURRENT_SCHEMA_VERSION = 40;
class FixtureDb {
  constructor() {
    this.version(40).stores({
      records: '${schemaTokens}',
    });
  }
}
`;
}

/**
 * Write a modified copy of the scanner (and an optional database.ts fixture)
 * to a temp dir, run it, then clean up. Returns the spawnSync result.
 */
function runScanner({ scriptPatches = [], schemaTokens = LIVE_SCHEMA_TOKENS } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'records-index-guard-test-'));
  try {
    const fixtureDbPath = path.join(tmpDir, 'database.fixture.ts');
    fs.writeFileSync(fixtureDbPath, makeDatabaseFixture(schemaTokens));

    let src = baseSrc.replace(
      DATABASE_TS_NEEDLE,
      `const DATABASE_TS = ${JSON.stringify(fixtureDbPath)};`
    );
    for (const [needle, replacement] of scriptPatches) {
      assert.ok(src.includes(needle), `patch needle not found in scanner source: ${needle}`);
      src = src.replace(needle, replacement);
    }

    const tmpScanner = path.join(tmpDir, 'check-records-index-usage.js');
    fs.writeFileSync(tmpScanner, src);
    return spawnSync('node', [tmpScanner], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Sanity: the guard passes against the real, unmodified live schema.
// ---------------------------------------------------------------------------

test('passes against the real, unmodified records schema', () => {
  const result = runScanner({});
  assert.equal(
    result.status,
    0,
    `expected exit 0 against the live schema, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stdout, /OK/);
});

// ---------------------------------------------------------------------------
// Layer 2 (denylist): a proven-dead index reappearing must fail immediately,
// with an actionable message, even before the pin comparison.
// ---------------------------------------------------------------------------

test('fails when a task #2119 denylisted index reappears (syncDepth)', () => {
  const result = runScanner({ schemaTokens: `${LIVE_SCHEMA_TOKENS}, syncDepth` });
  assert.equal(
    result.status,
    1,
    `expected exit 1 when syncDepth reappears, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /proven dead by the task #2119 audit/);
  assert.match(result.stderr, /'syncDepth'/);
});

test('fails when a task #2119 denylisted compound index reappears ([owner+id])', () => {
  const result = runScanner({ schemaTokens: `${LIVE_SCHEMA_TOKENS}, [owner+id]` });
  assert.equal(
    result.status,
    1,
    `expected exit 1 when [owner+id] reappears, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /\[owner\+id\]/);
});

// ---------------------------------------------------------------------------
// Layer 1 (pin): any addition or removal not already denylisted must force a
// deliberate update to EXPECTED_RECORDS_INDEX_TOKENS.
// ---------------------------------------------------------------------------

test('fails when a brand-new, unpinned index is added', () => {
  const result = runScanner({ schemaTokens: `${LIVE_SCHEMA_TOKENS}, brandNewIndexField` });
  assert.equal(
    result.status,
    1,
    `expected exit 1 for an unpinned new index, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /no longer matches the pinned set/);
  assert.match(result.stderr, /Added.*brandNewIndexField/);
});

test('fails when a pinned index is removed from the live schema', () => {
  const withoutChainType = LIVE_SCHEMA_TOKENS.replace(', chainType', '');
  assert.notEqual(withoutChainType, LIVE_SCHEMA_TOKENS, 'fixture setup should actually drop chainType');
  const result = runScanner({ schemaTokens: withoutChainType });
  assert.equal(
    result.status,
    1,
    `expected exit 1 when a pinned index is removed, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /no longer matches the pinned set/);
  assert.match(result.stderr, /Removed.*chainType/);
});

// ---------------------------------------------------------------------------
// Layer 3 (best-effort usage scan): even an index that has been deliberately
// pinned must have a real caller, or the scan must still fail.
// ---------------------------------------------------------------------------

test('fails when a pinned index has no real .where()/.orderBy() caller', () => {
  // Pin the same fake token that the fixture schema declares, so Layer 1
  // (pin comparison) passes and only Layer 3 (usage scan) is exercised.
  const result = runScanner({
    schemaTokens: `${LIVE_SCHEMA_TOKENS}, phantomUnusedIndex`,
    scriptPatches: [
      [
        EXPECTED_TOKENS_CLOSE_NEEDLE,
        "  'discoveredFromRecordId',\n  'phantomUnusedIndex',\n]);",
      ],
    ],
  });
  assert.equal(
    result.status,
    1,
    `expected exit 1 for a pinned-but-unused index, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(result.stderr, /no `\.where\(\)`\/`\.orderBy\(\)` usage/);
  assert.match(result.stderr, /'phantomUnusedIndex'/);
});
