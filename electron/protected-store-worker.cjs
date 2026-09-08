/* Native worker boundary.  It deliberately exposes no filesystem paths or SQL. */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { PROTECTED_TABLES } = require('./protected-store.cjs');
const {
  calculateOwnerCostBasisFromStoredRows,
  ownerCostBasisEditorRows,
  pageOwnerCostBasis,
  parseOwnerCostBasisReport,
  selectOwnerCostBasisReport,
} = require('./owner-cost-basis.bundle.cjs');

const ROOT = workerData && workerData.dataDir;
if (typeof ROOT !== 'string' || !ROOT) throw new Error('protected store configuration invalid');
const TEST_FIXTURES_ENABLED = workerData && workerData.enableTestFixtures === true;
const HEADER = path.join(ROOT, 'protected-store.header.json');
const DB_FILE = path.join(ROOT, 'protected-store.sqlite');
const OBJECTS = path.join(ROOT, 'protected-objects');
const FORMAT = 1;
const CHUNK_SIZE = 64 * 1024;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const TABLES = new Set(PROTECTED_TABLES);
const attachmentWrites = new Map();
const COLLECTIONS = new Set([
  'records', 'attachments', 'tags', 'categories', 'owners', 'ownerResidencies', 'walletNames',
  'seedNames', 'walletSoftware', 'recordOrigins', 'customFields', 'settings',
  'priceData', 'blockchainTransactions', 'transactionParticipants',
  'addressSyncState', 'nodeSettings', 'derivationTemplates', 'utxoLineage',
  'custodySegments', 'lineageSnapshots', 'evidence', 'evidenceAttachments',
  'pausedSyncState', 'skippedAddresses', 'addressBlacklist',
  'partialExportBundles', 'trashedAttachments', 'privacyAuditHistory',
  'dustFlags', 'savedPsbts', 'adversaryScenarios', 'vault',
  // v44 normalized record-model projection. These rows have the same encrypted
  // protected_rows boundary as legacy records; never route them to a sidecar.
  'entities', 'wallets', 'addressOwnership', 'transactionMetadata',
   'transactionLegMetadata', 'recordModelMigrationState', 'ownershipReviewDecisions',
  'networkPrivacyActivity', 'recordSearchIndex', 'recordSearchIndexState',
]);
// The IPC names are deliberately domain groups, rather than a remote table or
// Dexie-like API.  A group is allowed to address only its own persisted
// entities.  This keeps the renderer from turning this worker into a generic
// SQL/row transport.
const REPOSITORIES = Object.freeze({
  records: new Set([
    'records', 'attachments', 'recordOrigins', 'tags', 'categories', 'owners', 'ownerResidencies',
    'walletNames', 'seedNames', 'walletSoftware', 'customFields', 'entities',
    'wallets', 'addressOwnership', 'transactionMetadata',
     'transactionLegMetadata', 'recordModelMigrationState', 'ownershipReviewDecisions',
    'recordSearchIndex', 'recordSearchIndexState',
  ]),
  transactions: new Set(['blockchainTransactions', 'transactionParticipants', 'priceData', 'savedPsbts']),
  sync: new Set(['addressSyncState', 'nodeSettings', 'pausedSyncState', 'skippedAddresses', 'addressBlacklist']),
  lineage: new Set(['derivationTemplates', 'utxoLineage', 'custodySegments', 'lineageSnapshots']),
  evidence: new Set(['evidence', 'evidenceAttachments', 'partialExportBundles', 'trashedAttachments']),
  privacy: new Set(['privacyAuditHistory', 'dustFlags', 'adversaryScenarios', 'networkPrivacyActivity']),
  vault: new Set(['settings', 'vault']),
});
const REPOSITORY_OPERATIONS = new Set([
  'save', 'find', 'page', 'remove', 'saveBatch', 'removeBatch', 'batch', 'count', 'clear', 'query', 'command',
  // Fixed cross-collection commands.  These are commands, not a renderer
  // transaction callback or a generic multi-table mutation language.
  'deleteOrArchiveRecords', 'saveTransactionWithParticipants', 'saveSettingsWithHistory', 'clearAll', 'restoreCommit', 'commitOwnershipReview',
  'ownerCostBasisPage', 'ownerCostBasisProjection',
]);

let db = null;
let vdk = null;
let header = null;
let keys = null;
let Database = null;
let dataRevision = 0;
let ownerBookCheckpoint = null;
const OWNER_BOOK_CALCULATOR_VERSION = 'owner-cost-basis:v1';
const OWNER_BOOK_SOURCE_TABLES = Object.freeze([
  'records', 'blockchainTransactions', 'transactionParticipants', 'transactionMetadata',
  'transactionLegMetadata', 'entities', 'addressOwnership', 'recordModelMigrationState',
  'owners', 'ownerResidencies',
]);
const OWNER_BOOK_POLICY_TABLES = Object.freeze([
  'owners', 'ownerResidencies', 'transactionLegMetadata', 'entities',
  'addressOwnership', 'recordModelMigrationState',
]);
const OWNER_BOOK_CACHE_ID = 'owner-cost-basis';
try { Database = require('better-sqlite3-multiple-ciphers'); } catch {}

function fail() { throw new Error('Protected store operation failed'); }
function locked() { if (!db || !vdk || !keys) fail(); }
function b64(bytes) { return Buffer.from(bytes).toString('base64'); }
function fromB64(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail();
  const out = Buffer.from(value, 'base64');
  if (expected && out.length !== expected) fail();
  return out;
}
function random(n) { return crypto.randomBytes(n); }
function aadForHeader(h) {
  return Buffer.from(`kyutxo-protected-store|${h.version}|${h.vaultId}|${h.salt}|${JSON.stringify(h.kdf)}`);
}
function aesEncrypt(key, plaintext, aad) {
  const nonce = random(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return { nonce: b64(nonce), ciphertext: b64(Buffer.concat([cipher.update(plaintext), cipher.final()])), tag: b64(cipher.getAuthTag()) };
}
function aesDecrypt(key, envelope, aad) {
  const nonce = fromB64(envelope.nonce, 12);
  const tag = fromB64(envelope.tag, 16);
  const ciphertext = fromB64(envelope.ciphertext);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
async function derive(password, h) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 4096) fail();
  const { argon2id } = await import('hash-wasm');
  const result = await argon2id({
    password, salt: fromB64(h.salt, 16), parallelism: h.kdf.parallelism,
    iterations: h.kdf.timeCost, memorySize: h.kdf.memoryKiB,
    hashLength: 32, outputType: 'binary',
  });
  return Buffer.from(result);
}
function deriveSubkey(label) {
  return crypto.hkdfSync('sha256', vdk, Buffer.from(header.vaultId), Buffer.from(`kyutxo/${label}/v1`), 32);
}
function readHeader() {
  let value;
  try { value = JSON.parse(fs.readFileSync(HEADER, 'utf8')); } catch { fail(); }
  if (!value || value.version !== FORMAT || typeof value.vaultId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.vaultId) || !value.kdf || value.kdf.algorithm !== 'argon2id' ||
      !Number.isInteger(value.kdf.memoryKiB) || value.kdf.memoryKiB < 8192 ||
      !Number.isInteger(value.kdf.timeCost) || value.kdf.timeCost < 1 ||
      !Number.isInteger(value.kdf.parallelism) || value.kdf.parallelism < 1 || !value.wrappedVdk) fail();
  return value;
}
function loadDatabase() {
  if (!Database) fail();
  try {
    db = new Database(DB_FILE);
    // Hex key avoids SQL escaping and the VDK-derived key never enters SQL text.
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`key = "x'${keys.sql.toString('hex')}'"`);
    db.pragma('cipher_memory_security = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    // Upgrade an existing FORMAT 1 vault before creating indexes which refer
    // to the newer projection columns. Fresh tables receive these columns in
    // the CREATE statement below.
    const projectionMigrations = [
      'block_time INTEGER', 'curation_state TEXT', 'txid TEXT', 'role TEXT',
      'prev_txid TEXT', 'prev_vout INTEGER', 'date_value TEXT', 'currency TEXT',
      'asset TEXT', 'last_synced_at INTEGER', 'sync_run_timestamp INTEGER',
      'dismissed INTEGER', 'spent_txid TEXT', 'spent_vout INTEGER',
      'created_txid TEXT', 'created_vout INTEGER', 'spent_address TEXT',
      'created_address TEXT', 'segment_id TEXT', 'snapshot_id TEXT',
      'origin_txid TEXT', 'origin_vout INTEGER', 'origin_address TEXT',
      'current_address TEXT', 'evidence_id INTEGER',
    ];
    for (const collection of COLLECTIONS) {
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(collection);
      if (exists) for (const projection of projectionMigrations) {
        try { db.exec(`ALTER TABLE "${collection}" ADD COLUMN ${projection}`); } catch {}
      }
    }
    const entityTables = [...COLLECTIONS].map((collection) => {
      // Each entity has its own table.  The explicit id key type retains the
      // IndexedDB distinction between numeric auto ids and string singleton
      // ids (and therefore retains 0, null-valued fields, and ordering).
      const safe = `"${collection}"`;
      return `
        CREATE TABLE IF NOT EXISTS ${safe} (
          id_key TEXT UNIQUE NOT NULL,
          id_sort INTEGER NOT NULL,
          value_json TEXT NOT NULL,
          record_type TEXT,
          input_string_lower TEXT,
          label_lower TEXT,
          transaction_id TEXT,
          address TEXT,
          record_id_key TEXT,
          status TEXT,
          created_at INTEGER,
          updated_at INTEGER,
           block_time INTEGER,
           curation_state TEXT,
           txid TEXT,
           role TEXT,
           prev_txid TEXT,
           prev_vout INTEGER,
           date_value TEXT,
           currency TEXT,
           asset TEXT,
           last_synced_at INTEGER,
           sync_run_timestamp INTEGER,
           dismissed INTEGER,
           spent_txid TEXT,
           spent_vout INTEGER,
           created_txid TEXT,
           created_vout INTEGER,
           spent_address TEXT,
           created_address TEXT,
           segment_id TEXT,
           snapshot_id TEXT,
           origin_txid TEXT,
           origin_vout INTEGER,
           origin_address TEXT,
           current_address TEXT,
           evidence_id INTEGER,
          PRIMARY KEY(id_sort,id_key)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS "idx_${collection}_created_id" ON ${safe}(created_at, id_key);
        CREATE INDEX IF NOT EXISTS "idx_${collection}_updated_id" ON ${safe}(updated_at, id_key);
        CREATE INDEX IF NOT EXISTS "idx_${collection}_record_id" ON ${safe}(record_id_key);
        CREATE INDEX IF NOT EXISTS "idx_${collection}_transaction_id" ON ${safe}(transaction_id);
        CREATE INDEX IF NOT EXISTS "idx_${collection}_address" ON ${safe}(address);
        CREATE INDEX IF NOT EXISTS "idx_${collection}_input_lower" ON ${safe}(input_string_lower);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_txid" ON ${safe}(txid);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_prevout" ON ${safe}(prev_txid,prev_vout);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_block_time" ON ${safe}(block_time);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_price_key" ON ${safe}(date_value,currency,asset);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_sync_time" ON ${safe}(last_synced_at);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_spent" ON ${safe}(spent_txid,spent_vout);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_created" ON ${safe}(created_txid,created_vout);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_spent_address" ON ${safe}(spent_address);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_created_address" ON ${safe}(created_address);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_segment" ON ${safe}(segment_id);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_snapshot" ON ${safe}(snapshot_id);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_origin" ON ${safe}(origin_txid,origin_vout);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_origin_address" ON ${safe}(origin_address);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_lineage_current_address" ON ${safe}(current_address);
         CREATE INDEX IF NOT EXISTS "idx_${collection}_evidence_id" ON ${safe}(evidence_id);
      `;
    }).join('\n');
    db.exec(`
      ${entityTables}
      CREATE TABLE IF NOT EXISTS protected_sentinel (value TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS protected_attachment_refs (
        alias TEXT PRIMARY KEY,
        object_id TEXT NOT NULL,
        object_name TEXT NOT NULL,
        plaintext_size INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS protected_derived_cache (
        cache_id TEXT PRIMARY KEY,
        calculator_version TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        value_json TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS protected_derived_state (
        cache_id TEXT PRIMARY KEY,
        calculator_version TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    // Source mutations invalidate the matching cache and fingerprint state in
    // the same SQLite transaction as the write. This makes a cold-unlock hit
    // O(cache size), without trusting a revision that could survive a crash.
    for (const collection of OWNER_BOOK_SOURCE_TABLES) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS "invalidate_owner_book_${collection}_${action.toLowerCase()}"
          AFTER ${action} ON "${collection}"
          BEGIN
            DELETE FROM protected_derived_cache WHERE cache_id='${OWNER_BOOK_CACHE_ID}';
            DELETE FROM protected_derived_state WHERE cache_id='${OWNER_BOOK_CACHE_ID}';
          END
        `);
      }
    }
    // FORMAT 1 shipped before the query projections below. ADD COLUMN is
    // backwards compatible, while the fixed names keep migrations private.
    const projections = projectionMigrations;
    for (const collection of COLLECTIONS) {
      for (const projection of projections) {
        try { db.exec(`ALTER TABLE "${collection}" ADD COLUMN ${projection}`); } catch {}
      }
    }
    db.prepare('INSERT OR IGNORE INTO protected_sentinel(value) VALUES (?)').run(b64(crypto.createHmac('sha256', keys.sql).update('sentinel').digest()));
    const sentinel = db.prepare('SELECT value FROM protected_sentinel LIMIT 1').get();
    if (!sentinel || sentinel.value !== b64(crypto.createHmac('sha256', keys.sql).update('sentinel').digest())) fail();
  } catch {
    closeUnlocked();
    fail();
  }
}
function closeUnlocked() {
  ownerBookCheckpoint = null;
  dataRevision++;
  if (db) { try { db.close(); } catch {} }
  db = null;
  if (vdk) vdk.fill(0);
  vdk = null;
  keys = null;
  header = null;
}

function allRows(collection) {
  return db.prepare(`SELECT value_json FROM "${collection}" ORDER BY id_sort,id_key`)
    .all().map((row) => JSON.parse(row.value_json));
}

/** Hash encrypted-store canonical JSON incrementally; never concatenate the vault. */
function ownerBookFingerprint(collections) {
  const hash = crypto.createHash('sha256');
  hash.update(`${OWNER_BOOK_CALCULATOR_VERSION}\0`);
  for (const collection of collections) {
    hash.update(`table:${collection}\0`);
    const statement = db.prepare(
      `SELECT id_key,value_json FROM "${collection}" ORDER BY id_sort,id_key`,
    );
    for (const row of statement.iterate()) {
      // Length framing prevents ambiguous concatenations while retaining the
      // exact stored value_json (including same-id/same-revision replacements).
      hash.update(`${Buffer.byteLength(row.id_key)}:`);
      hash.update(row.id_key);
      hash.update(`${Buffer.byteLength(row.value_json)}:`);
      hash.update(row.value_json);
    }
  }
  return hash.digest('hex');
}

function getOwnerBookCheckpoint() {
  if (ownerBookCheckpoint && ownerBookCheckpoint.revision === dataRevision) return ownerBookCheckpoint;
  const persisted = db.prepare(`
    SELECT cache.value_json,cache.source_fingerprint,cache.policy_fingerprint
      FROM protected_derived_cache cache
      JOIN protected_derived_state state
        ON state.cache_id=cache.cache_id
       AND state.calculator_version=cache.calculator_version
       AND state.vault_id=cache.vault_id
       AND state.source_fingerprint=cache.source_fingerprint
       AND state.policy_fingerprint=cache.policy_fingerprint
     WHERE cache.cache_id=? AND cache.calculator_version=? AND cache.vault_id=?
  `).get(OWNER_BOOK_CACHE_ID, OWNER_BOOK_CALCULATOR_VERSION, header.vaultId);
  if (persisted) {
    const report = parseOwnerCostBasisReport(persisted.value_json);
    if (report) {
      const keyBase = `owner-book:protected:v4:${OWNER_BOOK_CALCULATOR_VERSION}:${header.vaultId}:${persisted.source_fingerprint}:${persisted.policy_fingerprint}`;
      ownerBookCheckpoint = { revision: dataRevision, report, keyBase };
      return ownerBookCheckpoint;
    }
    db.transaction(() => {
      db.prepare('DELETE FROM protected_derived_cache WHERE cache_id=?').run(OWNER_BOOK_CACHE_ID);
      db.prepare('DELETE FROM protected_derived_state WHERE cache_id=?').run(OWNER_BOOK_CACHE_ID);
    })();
  }
  const sourceFingerprint = ownerBookFingerprint(OWNER_BOOK_SOURCE_TABLES);
  const policyFingerprint = ownerBookFingerprint(OWNER_BOOK_POLICY_TABLES);
  const keyBase = `owner-book:protected:v4:${OWNER_BOOK_CALCULATOR_VERSION}:${header.vaultId}:${sourceFingerprint}:${policyFingerprint}`;
  const migrations = allRows('recordModelMigrationState');
  const report = calculateOwnerCostBasisFromStoredRows({
    records: allRows('records'),
    transactions: allRows('blockchainTransactions'),
    participants: allRows('transactionParticipants'),
    metadata: allRows('transactionMetadata'),
    legMetadata: allRows('transactionLegMetadata'),
    entities: allRows('entities'),
    ownership: allRows('addressOwnership'),
    owners: allRows('owners'),
    residencies: allRows('ownerResidencies'),
    migrationComplete: migrations.some((row) => row.id === 'v44' && row.phase === 'complete'),
  });
  db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO protected_derived_cache(
        cache_id,calculator_version,vault_id,source_fingerprint,policy_fingerprint,value_json
      ) VALUES (?,?,?,?,?,?)
    `).run(OWNER_BOOK_CACHE_ID, OWNER_BOOK_CALCULATOR_VERSION, header.vaultId,
      sourceFingerprint, policyFingerprint, JSON.stringify(report));
    db.prepare(`
      INSERT OR REPLACE INTO protected_derived_state(
        cache_id,calculator_version,vault_id,source_fingerprint,policy_fingerprint
      ) VALUES (?,?,?,?,?)
    `).run(OWNER_BOOK_CACHE_ID, OWNER_BOOK_CALCULATOR_VERSION, header.vaultId,
      sourceFingerprint, policyFingerprint);
  })();
  ownerBookCheckpoint = { revision: dataRevision, report, keyBase };
  return ownerBookCheckpoint;
}

function ownerCostBasisPage(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail();
  if (options.selectedOwner !== undefined && (typeof options.selectedOwner !== 'string' || options.selectedOwner.length > 512)) fail();
  const limit = Number.isInteger(options.limit) ? Math.min(250, Math.max(1, options.limit)) : 100;
  const checkpoint = getOwnerBookCheckpoint();
  const key = ownerCheckpointKey(checkpoint, options.selectedOwner || '');
  if (options.expectedCheckpointKey !== undefined && options.expectedCheckpointKey !== key) fail();
  const report = selectOwnerCostBasisReport(checkpoint.report, options.selectedOwner);
  return pageOwnerCostBasis(report, key, limit, ownerCostBasisEditorRows(report));
}

function testDamageOwnerReportCache() {
  locked();
  if (!TEST_FIXTURES_ENABLED) fail();
  const cached = db.prepare(
    'SELECT value_json FROM protected_derived_cache WHERE cache_id=?',
  ).get(OWNER_BOOK_CACHE_ID);
  if (!cached) fail();
  const report = JSON.parse(cached.value_json);
  if (!Array.isArray(report.batches) || report.batches.length === 0) fail();
  report.batches[0] = { ...report.batches[0], remainingSats: 'malformed' };
  db.prepare(
    'UPDATE protected_derived_cache SET value_json=? WHERE cache_id=?',
  ).run(JSON.stringify(report), OWNER_BOOK_CACHE_ID);
  ownerBookCheckpoint = null;
  return { damaged: true };
}

function ownerCheckpointKey(checkpoint, selectedOwner = '') {
  return `${checkpoint.keyBase}:${crypto.createHash('sha256').update(selectedOwner).digest('hex').slice(0, 12)}`;
}

function ownerCostBasisProjection(addresses) {
  if (!Array.isArray(addresses) || addresses.length > 1000 ||
      addresses.some((address) => typeof address !== 'string' || !address || address.length > 512)) fail();
  const wanted = new Set(addresses);
  const checkpoint = getOwnerBookCheckpoint();
  const addressByOutpoint = new Map();
  for (const participant of allRows('transactionParticipants')) {
    if (participant.role === 'output' && Number.isSafeInteger(participant.vout) &&
        wanted.has(participant.address)) addressByOutpoint.set(`${participant.txid}:${participant.vout}`, participant.address);
  }
  const batches = checkpoint.report.batches.flatMap((batch) => {
    if (batch.remainingSats <= 0) return [];
    const address = addressByOutpoint.get(`${batch.acquiredTxid}:${batch.lotId.split(':').at(-1)}`);
    return address ? [{ address, batch }] : [];
  }).sort((a, b) => a.address.localeCompare(b.address) || a.batch.lotId.localeCompare(b.batch.lotId));
  for (const address of wanted) if (batches.filter((row) => row.address === address).length > 250) fail();
  if (batches.length > 1000) fail();
  return {
    checkpointKey: ownerCheckpointKey(checkpoint),
    declaredAddresses: [...wanted].sort(),
    batches,
    perAddressLimit: 250,
    globalLimit: 1000,
  };
}
async function atomicWrite(file, bytes) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${random(12).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await fsp.rename(tmp, file);
    try { const dir = await fsp.open(path.dirname(file), 'r'); await dir.sync(); await dir.close(); } catch {}
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}
function validTable(table) { return typeof table === 'string' && TABLES.has(table); }
function validId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 512 &&
    !id.includes('\0')) || Number.isSafeInteger(id);
}
function rowKey(id) {
  if (!validId(id)) fail();
  return typeof id === 'number'
    ? `n:${(BigInt(id) + 9007199254740991n).toString().padStart(17, '0')}`
    : `s:${id}`;
}
function idFromRowKey(key) {
  return key.startsWith('n:')
    ? Number(BigInt(key.slice(2)) - 9007199254740991n)
    : key.slice(2);
}
function validCollection(collection) { return typeof collection === 'string' && COLLECTIONS.has(collection); }
function idKey(id) { return `${typeof id === 'number' ? 'n' : 's'}:${id}`; }
function idSort(id) { return typeof id === 'number' ? id : 0; }
function idFromKey(key) {
  const split = key.indexOf(':');
  if (split < 1) fail();
  const value = key.slice(split + 1);
  if (key.slice(0, split) === 'n' && /^-?\d+$/.test(value)) return Number(value);
  if (key.slice(0, split) === 's') return value;
  fail();
}
function optionalText(value, max = 4096) {
  return typeof value === 'string' && value.length <= max ? value : null;
}
function extracted(row) {
  // These fields are intentionally duplicated from the encrypted JSON payload.
  // They cover the indexed predicates used by the data modules while keeping
  // arbitrary application fields out of SQL schema and SQL text.
  return {
    recordType: optionalText(row.type || row.recordType, 128),
    inputStringLower: optionalText(row.inputStringLower || (typeof row.inputString === 'string' ? row.inputString.toLowerCase() : null)),
    labelLower: optionalText(typeof row.label === 'string' ? row.label.toLowerCase() : null),
    transactionId: optionalText(row.transactionId || row.txid, 256),
    address: optionalText(row.address, 512),
    recordIdKey: row.recordId === undefined || row.recordId === null ? null : validId(row.recordId) ? idKey(row.recordId) : null,
    status: optionalText(row.status, 128),
    blockTime: Number.isSafeInteger(row.blockTime) ? row.blockTime : null,
    curationState: optionalText(row.curationState, 128),
    txid: optionalText(row.txid, 256),
    role: optionalText(row.role, 64),
    prevTxid: optionalText(row.prevTxid, 256),
    prevVout: Number.isSafeInteger(row.prevVout) ? row.prevVout : null,
    dateValue: optionalText(row.date, 64),
    currency: optionalText(row.currency, 32),
    asset: optionalText(row.asset, 128),
    lastSyncedAt: Number.isSafeInteger(row.lastSyncedAt) ? row.lastSyncedAt : null,
    syncRunTimestamp: Number.isSafeInteger(row.syncRunTimestamp) ? row.syncRunTimestamp : null,
    dismissed: row.dismissed ? 1 : 0,
    spentTxid: optionalText(row.spentTxid, 256),
    spentVout: Number.isSafeInteger(row.spentVout) ? row.spentVout : null,
    createdTxid: optionalText(row.createdTxid, 256),
    createdVout: Number.isSafeInteger(row.createdVout) ? row.createdVout : null,
    spentAddress: optionalText(row.spentAddress, 512),
    createdAddress: optionalText(row.createdAddress, 512),
    segmentId: optionalText(row.segmentId, 256),
    snapshotId: optionalText(row.snapshotId, 256),
    originTxid: optionalText(row.originTxid, 256),
    originVout: Number.isSafeInteger(row.originVout) ? row.originVout : null,
    originAddress: optionalText(row.originAddress, 512),
    currentAddress: optionalText(row.currentAddress, 512),
    evidenceId: Number.isSafeInteger(row.evidenceId) ? row.evidenceId : null,
  };
}
function validRepositoryRequest(message) {
  return message && typeof message.repository === 'string' &&
    REPOSITORIES[message.repository] instanceof Set &&
    typeof message.collection === 'string' &&
    REPOSITORIES[message.repository].has(message.collection) &&
    REPOSITORY_OPERATIONS.has(message.operation);
}
function repositoryGroupForCollection(collection) {
  return Object.keys(REPOSITORIES).find((group) => REPOSITORIES[group].has(collection));
}
function validAlias(alias) {
  return typeof alias === 'string' && alias.length > 0 && alias.length <= 512 &&
    !alias.includes('..') && !path.isAbsolute(alias) && !alias.includes('\0');
}
function objectAad(objectId, index, length) {
  return Buffer.from(`kyutxo-attachment|${header.vaultId}|${objectId}|${FORMAT}|${index}|${length}`);
}

async function create({ password }) {
  if (fs.existsSync(HEADER)) fail();
  await fsp.mkdir(ROOT, { recursive: true, mode: 0o700 });
  await fsp.mkdir(OBJECTS, { recursive: true, mode: 0o700 });
  header = { version: FORMAT, vaultId: crypto.randomUUID(), salt: b64(random(16)),
    kdf: { algorithm: 'argon2id', memoryKiB: 65536, timeCost: 3, parallelism: 1, version: 2 },
    generation: 1 };
  const wrappingKey = await derive(password, header);
  vdk = random(32);
  header.wrappedVdk = aesEncrypt(wrappingKey, vdk, aadForHeader(header));
  wrappingKey.fill(0);
  await atomicWrite(HEADER, Buffer.from(JSON.stringify(header)));
  keys = { sql: deriveSubkey('sqlcipher'), attachment: deriveSubkey('attachment') };
  loadDatabase();
  return { mode: 'protected', verified: true, unlocked: true };
}
async function unlock({ password }) {
  if (db) fail();
  const candidate = readHeader();
  const wrappingKey = await derive(password, candidate);
  let candidateVdk;
  try { candidateVdk = aesDecrypt(wrappingKey, candidate.wrappedVdk, aadForHeader(candidate)); } catch { wrappingKey.fill(0); fail(); }
  wrappingKey.fill(0);
  if (candidateVdk.length !== 32) { candidateVdk.fill(0); fail(); }
  header = candidate; vdk = candidateVdk;
  keys = { sql: deriveSubkey('sqlcipher'), attachment: deriveSubkey('attachment') };
  loadDatabase();
  return { mode: 'protected', verified: true, unlocked: true };
}
async function changePassword({ oldPassword, newPassword }) {
  locked();
  // Reauthenticate old password rather than relying on possession of an open worker.
  const oldKey = await derive(oldPassword, header);
  try { aesDecrypt(oldKey, header.wrappedVdk, aadForHeader(header)); } catch { oldKey.fill(0); fail(); }
  oldKey.fill(0);
  const next = { ...header, generation: header.generation + 1 };
  const newKey = await derive(newPassword, next);
  next.wrappedVdk = aesEncrypt(newKey, vdk, aadForHeader(next));
  newKey.fill(0);
  await atomicWrite(HEADER, Buffer.from(JSON.stringify(next)));
  header = next;
  return { changed: true };
}
async function writeAttachment({ bytes, alias }) {
  locked();
  const plain = Buffer.from(bytes || []);
  if (plain.length > MAX_ATTACHMENT_BYTES || (alias !== undefined && !validAlias(alias))) fail();
  const objectId = random(24).toString('base64url');
  const name = random(24).toString('hex');
  const objectHeader = { version: FORMAT, objectId, chunkSize: CHUNK_SIZE };
  const headerAuth = aesEncrypt(keys.attachment, Buffer.alloc(0), objectAad(objectId, -1, 0));
  const parts = [Buffer.from(JSON.stringify({ ...objectHeader, headerAuth }) + '\n')];
  for (let index = 0, offset = 0; offset < plain.length; index++, offset += CHUNK_SIZE) {
    const chunk = plain.subarray(offset, Math.min(offset + CHUNK_SIZE, plain.length));
    const sealed = aesEncrypt(keys.attachment, chunk, objectAad(objectId, index, chunk.length));
    const encoded = Buffer.from(JSON.stringify(sealed) + '\n');
    parts.push(encoded);
  }
  await atomicWrite(path.join(OBJECTS, name), Buffer.concat(parts));
  let oldObjectName = null;
  if (alias !== undefined) {
    const old = db.prepare(
      'SELECT object_name FROM protected_attachment_refs WHERE alias=?',
    ).get(alias);
    oldObjectName = old && old.object_name;
    db.prepare(`
      INSERT INTO protected_attachment_refs(alias,object_id,object_name,plaintext_size)
      VALUES (?,?,?,?)
      ON CONFLICT(alias) DO UPDATE SET
        object_id=excluded.object_id,
        object_name=excluded.object_name,
        plaintext_size=excluded.plaintext_size
    `).run(alias, objectId, name, plain.length);
  }
  if (oldObjectName && oldObjectName !== name) {
    await fsp.unlink(path.join(OBJECTS, oldObjectName)).catch(() => {});
  }
  return { id: objectId, name, alias, size: plain.length };
}

async function beginAttachment({ alias }) {
  locked();
  if (!validAlias(alias) || attachmentWrites.size >= 4) fail();
  const token = random(24).toString('hex');
  const objectId = random(24).toString('base64url');
  const name = random(24).toString('hex');
  const tmp = path.join(OBJECTS, `.${name}.${token}.tmp`);
  const handle = await fsp.open(tmp, 'wx', 0o600);
  const headerAuth = aesEncrypt(keys.attachment, Buffer.alloc(0), objectAad(objectId, -1, 0));
  await handle.writeFile(Buffer.from(JSON.stringify({
    version: FORMAT, objectId, chunkSize: CHUNK_SIZE, headerAuth,
  }) + '\n'));
  attachmentWrites.set(token, { alias, objectId, name, tmp, handle, index: 0, size: 0 });
  return { token };
}

async function appendAttachment({ token, bytes }) {
  locked();
  const state = attachmentWrites.get(token);
  const plain = Buffer.from(bytes || []);
  if (!state || plain.length > CHUNK_SIZE ||
      state.size + plain.length > MAX_ATTACHMENT_BYTES) fail();
  const sealed = aesEncrypt(
    keys.attachment, plain, objectAad(state.objectId, state.index, plain.length),
  );
  await state.handle.writeFile(Buffer.from(JSON.stringify(sealed) + '\n'));
  state.index++;
  state.size += plain.length;
  return { size: state.size };
}

async function abortAttachment({ token }) {
  const state = attachmentWrites.get(token);
  if (!state) return { aborted: true };
  attachmentWrites.delete(token);
  await state.handle.close().catch(() => {});
  await fsp.unlink(state.tmp).catch(() => {});
  return { aborted: true };
}

async function finishAttachment({ token }) {
  locked();
  const state = attachmentWrites.get(token);
  if (!state) fail();
  attachmentWrites.delete(token);
  try {
    await state.handle.sync();
    await state.handle.close();
    await fsp.rename(state.tmp, path.join(OBJECTS, state.name));
    const dir = await fsp.open(OBJECTS, 'r');
    await dir.sync();
    await dir.close();
    const old = db.prepare(
      'SELECT object_name FROM protected_attachment_refs WHERE alias=?',
    ).get(state.alias);
    db.prepare(`
      INSERT INTO protected_attachment_refs(alias,object_id,object_name,plaintext_size)
      VALUES (?,?,?,?)
      ON CONFLICT(alias) DO UPDATE SET object_id=excluded.object_id,
        object_name=excluded.object_name,plaintext_size=excluded.plaintext_size
    `).run(state.alias, state.objectId, state.name, state.size);
    if (old && old.object_name !== state.name) {
      await fsp.unlink(path.join(OBJECTS, old.object_name)).catch(() => {});
    }
    return { id: state.objectId, name: state.name, alias: state.alias, size: state.size };
  } catch (error) {
    await state.handle.close().catch(() => {});
    await fsp.unlink(state.tmp).catch(() => {});
    throw error;
  }
}

async function verifyAttachments({ after = '', limit = 100 } = {}) {
  locked();
  limit = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 100;
  if (typeof after !== 'string' || !validAlias(after) && after !== '') fail();
  const refs = db.prepare(
    `SELECT alias,object_id,object_name,plaintext_size
       FROM protected_attachment_refs WHERE alias>? ORDER BY alias LIMIT ?`,
  ).all(after, limit);
  const files = [];
  for (const ref of refs) {
    const input = fs.createReadStream(path.join(OBJECTS, ref.object_name), {
      encoding: 'utf8', highWaterMark: CHUNK_SIZE,
    });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const hash = crypto.createHash('sha256');
    let objectHeader = null;
    let index = 0;
    let bytes = 0;
    try {
      for await (const line of lines) {
        if (!objectHeader) {
          objectHeader = JSON.parse(line);
          if (objectHeader.version !== FORMAT ||
              objectHeader.objectId !== ref.object_id ||
              objectHeader.chunkSize !== CHUNK_SIZE) fail();
          aesDecrypt(
            keys.attachment, objectHeader.headerAuth,
            objectAad(ref.object_id, -1, 0),
          );
          continue;
        }
        const sealed = JSON.parse(line);
        const length = fromB64(sealed.ciphertext).length;
        if (length > CHUNK_SIZE) fail();
        const plain = aesDecrypt(
          keys.attachment, sealed, objectAad(ref.object_id, index++, length),
        );
        bytes += plain.length;
        hash.update(plain);
      }
    } catch {
      input.destroy();
      fail();
    }
    if (!objectHeader || bytes !== ref.plaintext_size) fail();
    files.push({
      id: ref.alias,
      bytes,
      digest: hash.digest('hex'),
    });
  }
  return files;
}
async function readAttachment({ name, id, alias }) {
  locked();
  if (alias !== undefined) {
    if (!validAlias(alias)) fail();
    const ref = db.prepare(
      'SELECT object_id,object_name FROM protected_attachment_refs WHERE alias=?',
    ).get(alias);
    if (!ref) fail();
    id = ref.object_id;
    name = ref.object_name;
  }
  if (!validId(id) || typeof name !== 'string' || !/^[a-f0-9]{48}$/.test(name)) fail();
  let lines;
  try { lines = (await fsp.readFile(path.join(OBJECTS, name), 'utf8')).trimEnd().split('\n'); } catch { fail(); }
  try {
    const h = JSON.parse(lines.shift());
    if (h.version !== FORMAT || h.objectId !== id || !Number.isInteger(h.chunkSize) || h.chunkSize !== CHUNK_SIZE) fail();
    aesDecrypt(keys.attachment, h.headerAuth, objectAad(id, -1, 0));
    const output = [];
    for (let i = 0; i < lines.length; i++) {
      const sealed = JSON.parse(lines[i]);
      const ciphertext = fromB64(sealed.ciphertext);
      // AES-GCM stores the authentication tag separately in this format, so
      // ciphertext length is exactly the plaintext length.
      const length = ciphertext.length;
      if (length > CHUNK_SIZE) fail();
      output.push(aesDecrypt(keys.attachment, sealed, objectAad(id, i, length)));
    }
    const result = Buffer.concat(output);
    // Never return a pooled Buffer backing store across a process boundary.
    return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  } catch { fail(); }
}

async function handle(type, message) {
  if (type === 'status') return {
    mode: 'protected',
    available: !!Database,
    exists: fs.existsSync(HEADER),
    unlocked: !!db,
    verified: !!db && !!keys && !!header,
    ready: !!db && !!keys && !!header,
    version: FORMAT,
  };
  if (type === 'create') return create(message);
  if (type === 'unlock') return unlock(message);
  if (type === 'lock') {
    for (const token of [...attachmentWrites.keys()]) await abortAttachment({ token });
    closeUnlocked();
    return { unlocked: false };
  }
  if (type === 'changePassword') return changePassword(message);
  if (type === 'integrity') {
    locked();
    const cipherRows = db.pragma('cipher_integrity_check');
    if (Array.isArray(cipherRows) && cipherRows.some((row) =>
      Object.values(row).some((value) => String(value).toLowerCase() !== 'ok'))) fail();
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') fail();
    return { ok: true, cipher: 'ok' };
  }
  if (type === 'putRow') {
    locked(); if (!validTable(message.table) || !validId(message.id) ||
      !message.row || typeof message.row !== 'object' || Array.isArray(message.row)) fail();
    const repositoryName = repositoryGroupForCollection(message.table);
    if (!repositoryName) fail();
    repository({
      repository: repositoryName,
      collection: message.table,
      operation: 'save',
      row: { ...message.row, id: message.id },
    });
    return { id: message.id };
  }
  if (type === 'getRow') {
    locked(); if (!validTable(message.table) || !validId(message.id)) fail();
    const repositoryName = repositoryGroupForCollection(message.table);
    if (!repositoryName) fail();
    const row = repository({
      repository: repositoryName,
      collection: message.table,
      operation: 'find',
      id: message.id,
    });
    if (!row) return null;
    const { id: _id, ...value } = row;
    return value;
  }
  if (type === 'listRows') {
    locked(); if (!validTable(message.table)) fail();
    const limit = Number.isInteger(message.limit) && message.limit > 0 && message.limit <= 1000 ? message.limit : 100;
    const repositoryName = repositoryGroupForCollection(message.table);
    if (!repositoryName) fail();
    const page = repository({
      repository: repositoryName,
      collection: message.table,
      operation: 'page',
      after: message.after === null ? undefined : message.after,
      limit,
    });
    return page.items.map((row) => {
      const { id, ...value } = row;
      return { id, row: value };
    });
  }
  if (type === 'deleteRow') {
    locked(); if (!validTable(message.table) || !validId(message.id)) fail();
    const repositoryName = repositoryGroupForCollection(message.table);
    if (!repositoryName) fail();
    return repository({
      repository: repositoryName,
      collection: message.table,
      operation: 'remove',
      id: message.id,
    });
  }
  if (type === 'repository') return repository(message);
  if (type === 'writeAttachment') return writeAttachment(message);
  if (type === 'beginAttachment') return beginAttachment(message);
  if (type === 'appendAttachment') return appendAttachment(message);
  if (type === 'finishAttachment') return finishAttachment(message);
  if (type === 'abortAttachment') return abortAttachment(message);
  if (type === 'verifyAttachments') return verifyAttachments(message);
  if (type === 'testDamageOwnerReportCache') return testDamageOwnerReportCache();
  if (type === 'readAttachment') return readAttachment(message);
  if (type === 'deleteAttachment') {
    locked();
    let name = message.name;
    if (message.alias !== undefined) {
      if (!validAlias(message.alias)) fail();
      const ref = db.prepare(
        'SELECT object_name FROM protected_attachment_refs WHERE alias=?',
      ).get(message.alias);
      db.prepare('DELETE FROM protected_attachment_refs WHERE alias=?').run(message.alias);
      if (!ref) return { deleted: true };
      name = ref.object_name;
    }
    if (typeof name !== 'string' || !/^[a-f0-9]{48}$/.test(name)) fail();
    await fsp.unlink(path.join(OBJECTS, name)).catch((e) => { if (e.code !== 'ENOENT') throw e; }); return { deleted: true };
  }
  if (type === 'listAttachments') {
    locked();
    return db.prepare(
      'SELECT alias,plaintext_size AS size FROM protected_attachment_refs ORDER BY alias',
    ).all();
  }
  if (type === 'renameAttachment') {
    locked();
    if (!validAlias(message.oldAlias) || !validAlias(message.newAlias)) fail();
    const changed = db.prepare(
      'UPDATE protected_attachment_refs SET alias=? WHERE alias=?',
    ).run(message.newAlias, message.oldAlias);
    if (changed.changes !== 1) fail();
    return { renamed: true };
  }
  fail();
}

function entityValue(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
  const value = JSON.stringify(row);
  if (value === undefined || Buffer.byteLength(value) > MAX_VALUE_BYTES) fail();
  return value;
}

let repositoryDepth = 0;
function repository(message) {
  const outer = repositoryDepth++ === 0;
  try {
    const result = repositoryImpl(message);
    if (outer && !['find', 'page', 'count', 'query', 'ownerCostBasisPage', 'ownerCostBasisProjection'].includes(message.operation)) {
      dataRevision++;
      ownerBookCheckpoint = null;
    }
    return result;
  } finally {
    repositoryDepth--;
  }
}

function repositoryImpl(message) {
  locked();
  if (!validRepositoryRequest(message)) fail();
  const table = `"${message.collection}"`; // collection is from the fixed allowlist
  const { operation, collection } = message;
  if (operation === 'ownerCostBasisPage') {
    if (collection !== 'records') fail();
    return ownerCostBasisPage(message.options);
  }
  if (operation === 'ownerCostBasisProjection') {
    if (collection !== 'records') fail();
    return ownerCostBasisProjection(message.addresses);
  }
  const allocateId = () => {
    const found = db.prepare(`SELECT MAX(id_sort) AS max_id FROM ${table} WHERE id_sort > 0`).get();
    const id = (found && Number.isSafeInteger(found.max_id) ? found.max_id : 0) + 1;
    if (!Number.isSafeInteger(id)) fail();
    return id;
  };
  const save = (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
    const saved = row.id === undefined ? { ...row, id: allocateId() } : row;
    if (!validId(saved.id)) fail();
    const value = entityValue(saved);
    const fields = extracted(saved);
    db.prepare(`
       INSERT INTO ${table}(id_key,id_sort,value_json,record_type,input_string_lower,label_lower,transaction_id,address,record_id_key,status,created_at,updated_at,
         block_time,curation_state,txid,role,prev_txid,prev_vout,date_value,currency,asset,last_synced_at,sync_run_timestamp,dismissed,
         spent_txid,spent_vout,created_txid,created_vout,spent_address,created_address,segment_id,snapshot_id,origin_txid,origin_vout,origin_address,current_address,evidence_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id_key) DO UPDATE SET value_json=excluded.value_json,
         record_type=excluded.record_type,input_string_lower=excluded.input_string_lower,label_lower=excluded.label_lower,
         transaction_id=excluded.transaction_id,address=excluded.address,record_id_key=excluded.record_id_key,status=excluded.status,
          created_at=excluded.created_at, updated_at=excluded.updated_at,block_time=excluded.block_time,curation_state=excluded.curation_state,
          txid=excluded.txid,role=excluded.role,prev_txid=excluded.prev_txid,prev_vout=excluded.prev_vout,date_value=excluded.date_value,
          currency=excluded.currency,asset=excluded.asset,last_synced_at=excluded.last_synced_at,sync_run_timestamp=excluded.sync_run_timestamp,
          dismissed=excluded.dismissed,spent_txid=excluded.spent_txid,spent_vout=excluded.spent_vout,created_txid=excluded.created_txid,
          created_vout=excluded.created_vout,spent_address=excluded.spent_address,created_address=excluded.created_address,
          segment_id=excluded.segment_id,snapshot_id=excluded.snapshot_id,origin_txid=excluded.origin_txid,origin_vout=excluded.origin_vout,
          origin_address=excluded.origin_address,current_address=excluded.current_address,evidence_id=excluded.evidence_id
    `).run(idKey(saved.id), idSort(saved.id), value, fields.recordType, fields.inputStringLower, fields.labelLower,
      fields.transactionId, fields.address, fields.recordIdKey, fields.status,
      Number.isSafeInteger(saved.createdAt) ? saved.createdAt : null,
       Number.isSafeInteger(saved.updatedAt) ? saved.updatedAt : null,
       fields.blockTime, fields.curationState, fields.txid, fields.role, fields.prevTxid, fields.prevVout,
       fields.dateValue, fields.currency, fields.asset, fields.lastSyncedAt, fields.syncRunTimestamp, fields.dismissed,
       fields.spentTxid, fields.spentVout, fields.createdTxid, fields.createdVout, fields.spentAddress, fields.createdAddress,
       fields.segmentId, fields.snapshotId, fields.originTxid, fields.originVout, fields.originAddress, fields.currentAddress, fields.evidenceId);
    return saved.id;
  };
  // Cross-row commands are deliberately dispatched by a finite command name.
  // They remain inside this worker's SQLite transaction; no renderer callback
  // is ever executed while a transaction is open.
  if (operation === 'commitOwnershipReview') {
    if (collection !== 'ownershipReviewDecisions') fail();
    const command = message.command;
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        !command.decision || typeof command.decision !== 'object' || Array.isArray(command.decision) ||
        !Array.isArray(command.ownershipRows) || command.ownershipRows.length > 2000 ||
        !command.ownershipRows.every((row) => row && typeof row === 'object' && !Array.isArray(row)) ||
        (command.deleteOwnershipIds !== undefined && (!Array.isArray(command.deleteOwnershipIds) ||
          command.deleteOwnershipIds.length > 2000 || !command.deleteOwnershipIds.every(validId)))) fail();
    const decision = command.decision;
    if (!validId(decision.id)) fail();
    const removeOwnership = db.prepare('DELETE FROM "addressOwnership" WHERE id_key=?');
    const run = db.transaction(() => {
      for (const id of command.deleteOwnershipIds || []) removeOwnership.run(idKey(id));
      const createdOwnershipRecordIds = [];
      for (const row of command.ownershipRows) {
        if (row.id === undefined && Number.isSafeInteger(row.recordId)) createdOwnershipRecordIds.push(row.recordId);
        repository({ repository: 'records', collection: 'addressOwnership', operation: 'save', row });
      }
      const saved = { ...decision, createdOwnershipRecordIds };
      save(saved);
      return saved;
    });
    return run();
  }
  if (operation === 'command') {
    if (message.name !== 'cleanup.deleteRecordWithOrigins' || collection !== 'records') fail();
    const recordId = message.value && message.value.recordId;
    if (!Number.isSafeInteger(recordId)) fail();
    const removeRecord = db.prepare('DELETE FROM "records" WHERE id_key=?');
    const removeOrigins = db.prepare('DELETE FROM "recordOrigins" WHERE record_id_key=?');
    const run = db.transaction((id) => {
      // Origins are metadata owned by the record. Deleting both together avoids
      // an observable half-cleaned discovery record after a crash.
      removeOrigins.run(idKey(id));
      return removeRecord.run(idKey(id)).changes === 1;
    });
    return { deleted: run(recordId) };
  }
  if (operation === 'deleteOrArchiveRecords') {
    if (collection !== 'records' || !Array.isArray(message.recordIds) || message.recordIds.length > 1000 ||
        !message.recordIds.every(Number.isSafeInteger) || !['delete', 'archive'].includes(message.mode) ||
        (message.archivedAt !== undefined && !Number.isSafeInteger(message.archivedAt)) ||
        (message.archiveReason !== undefined && !optionalText(message.archiveReason, 512))) fail();
    const uniqueIds = [...new Set(message.recordIds)];
    const removeRecord = db.prepare('DELETE FROM "records" WHERE id_key=?');
    const removeOrigins = db.prepare('DELETE FROM "recordOrigins" WHERE record_id_key=?');
    const findRecord = db.prepare('SELECT value_json FROM "records" WHERE id_key=?');
    const run = db.transaction(() => {
      let deleted = 0; let archived = 0;
      for (const id of uniqueIds) {
        if (message.mode === 'delete') {
          removeOrigins.run(idKey(id));
          deleted += removeRecord.run(idKey(id)).changes;
        } else {
          const found = findRecord.get(idKey(id));
          if (!found) continue;
          const row = JSON.parse(found.value_json);
          save({ ...row, archivedAt: message.archivedAt === undefined ? Date.now() : message.archivedAt,
            archiveReason: message.archiveReason, archived: true });
          archived++;
        }
      }
      return { deleted, archived };
    });
    return run();
  }
  if (operation === 'saveTransactionWithParticipants') {
    if (collection !== 'blockchainTransactions' || !message.transaction ||
        typeof message.transaction !== 'object' || Array.isArray(message.transaction) ||
        !Array.isArray(message.participants) || message.participants.length > 1000 ||
        !message.participants.every((participant) => participant && typeof participant === 'object' && !Array.isArray(participant))) fail();
    const transactionRow = message.transaction;
    const txid = optionalText(transactionRow.txid, 256);
    if (!txid || message.participants.some((participant) => participant.txid !== txid)) fail();
    const removeParticipants = db.prepare('DELETE FROM "transactionParticipants" WHERE txid=?');
    const run = db.transaction(() => {
      const transactionId = save(transactionRow);
      if (message.replaceParticipants !== false) removeParticipants.run(txid);
      const participantIds = message.participants.map((participant) => repository({
        repository: 'transactions', collection: 'transactionParticipants', operation: 'save', row: participant,
      }).id);
      return { transactionId, participantIds };
    });
    return run();
  }
  if (operation === 'saveSettingsWithHistory') {
    if (collection !== 'settings' || !message.settings || typeof message.settings !== 'object' ||
        Array.isArray(message.settings) || (message.historyEntry !== undefined &&
        (!message.historyEntry || typeof message.historyEntry !== 'object' || Array.isArray(message.historyEntry))) ||
        (message.retainHistory !== undefined && (!Number.isInteger(message.retainHistory) || message.retainHistory < 0 || message.retainHistory > 100000))) fail();
    const trimHistory = db.prepare(`
      DELETE FROM "privacyAuditHistory" WHERE id_key IN (
        SELECT id_key FROM "privacyAuditHistory"
        ORDER BY created_at DESC, id_sort DESC, id_key DESC LIMIT -1 OFFSET ?
      )
    `);
    const run = db.transaction(() => {
      const settingsId = save(message.settings);
      const historyId = message.historyEntry ? repository({
        repository: 'privacy', collection: 'privacyAuditHistory', operation: 'save', row: message.historyEntry,
      }).id : undefined;
      if (message.retainHistory !== undefined) trimHistory.run(message.retainHistory);
      return {
        settingsId,
        historyId,
        retainedHistory: db.prepare('SELECT COUNT(*) AS count FROM "privacyAuditHistory"').get().count,
      };
    });
    return run();
  }
  if (operation === 'clearAll') {
    // Only the vault command route may clear every collection. This is a
    // single SQLite transaction rather than a renderer loop of collection
    // clears, so an interrupted reset always rolls back.
    if (collection !== 'settings' || message.confirm !== 'clear-vault') fail();
    const clearAll = db.transaction(() => {
      let deleted = 0;
      for (const name of COLLECTIONS) deleted += db.prepare(`DELETE FROM "${name}"`).run().changes;
      return { deleted };
    });
    return clearAll();
  }
  if (operation === 'restoreCommit') {
    // The importer may submit only this fixed snapshot DTO. Table names are
    // checked against the compiled schema, and replacement plus every row save
    // shares one SQLCipher transaction.
    if (collection !== 'settings' || typeof message.replaceExisting !== 'boolean' ||
        !message.rows || typeof message.rows !== 'object' || Array.isArray(message.rows)) fail();
    const entries = Object.entries(message.rows);
    if (entries.some(([name, rows]) => !COLLECTIONS.has(name) || !Array.isArray(rows) || rows.length > 100000) ||
        entries.reduce((total, [, rows]) => total + rows.length, 0) > 1000000) fail();
    const repositoryFor = (name) => Object.keys(REPOSITORIES).find((group) => REPOSITORIES[group].has(name));
    if (entries.some(([name, rows]) => !repositoryFor(name) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row)))) fail();
    const run = db.transaction(() => {
      if (message.replaceExisting) {
        for (const name of COLLECTIONS) db.prepare(`DELETE FROM "${name}"`).run();
      }
      let saved = 0;
      for (const [name, rows] of entries) {
        const group = repositoryFor(name);
        for (const row of rows) {
          repository({ repository: group, collection: name, operation: 'save', row });
          saved++;
        }
      }
      return { saved };
    });
    return run();
  }
  if (operation === 'save') return { id: save(message.row) };
  if (operation === 'find') {
    if (!validId(message.id)) fail();
    const found = db.prepare(`SELECT value_json FROM ${table} WHERE id_key=?`).get(idKey(message.id));
    return found ? JSON.parse(found.value_json) : null;
  }
  if (operation === 'remove') {
    if (!validId(message.id)) fail();
    const result = db.prepare(`DELETE FROM ${table} WHERE id_key=?`).run(idKey(message.id));
    return { deleted: result.changes === 1 };
  }
  if (operation === 'page') {
    const limit = Number.isInteger(message.limit) && message.limit > 0 && message.limit <= 1000
      ? message.limit : 100;
    const direction = message.direction === 'desc' ? 'DESC' : 'ASC';
    if (message.after !== undefined && !validId(message.after)) fail();
    const after = message.after === undefined ? null : message.after;
    // Bounded keyset pages never materialize the vault.  Ordering is
    // deterministic and mirrors the primary-key order used by the old store.
    const rows = after === null
      ? db.prepare(`SELECT value_json FROM ${table} ORDER BY id_sort ${direction}, id_key ${direction} LIMIT ?`).all(limit)
      : db.prepare(`SELECT value_json FROM ${table} WHERE (id_sort ${direction === 'ASC' ? '>' : '<'} ? OR (id_sort=? AND id_key ${direction === 'ASC' ? '>' : '<'} ?)) ORDER BY id_sort ${direction}, id_key ${direction} LIMIT ?`).all(idSort(after), idSort(after), idKey(after), limit);
    const items = rows.map((row) => JSON.parse(row.value_json));
    return { items, next: items.length === limit ? items[items.length - 1].id : null, collection };
  }
  if (operation === 'saveBatch') {
    if (!Array.isArray(message.rows) || message.rows.length > 1000) fail();
    const transaction = db.transaction((rows) => rows.map(save));
    return { ids: transaction(message.rows) };
  }
  if (operation === 'removeBatch') {
    if (!Array.isArray(message.ids) || message.ids.length > 1000 || !message.ids.every(validId)) fail();
    const remove = db.prepare(`DELETE FROM ${table} WHERE id_key=?`);
    const deleted = db.transaction((ids) => ids.reduce((count, id) => count + remove.run(idKey(id)).changes, 0))(message.ids);
    return { deleted };
  }
  if (operation === 'count') return { count: db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count };
  if (operation === 'clear') {
    const result = db.prepare(`DELETE FROM ${table}`).run();
    return { deleted: result.changes };
  }
  if (operation === 'query') {
    // Query names are a deliberately finite API.  Do not accept a column,
    // comparator, or SQL fragment from the renderer.
    const name = message.name;
    const limit = Number.isInteger(message.limit) && message.limit > 0 && message.limit <= 1000 ? message.limit : 100;
    const text = (v, max = 512) => typeof v === 'string' && v.length <= max;
    const values = (v, predicate) => Array.isArray(v) && v.length > 0 && v.length <= 1000 && v.every(predicate);
    const select = (where, args = [], order = 'id_sort,id_key') =>
      db.prepare(`SELECT value_json FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY ${order} LIMIT ?`).all(...args, limit);
    const inSelect = (column, list) => select(`${column} IN (${list.map(() => '?').join(',')})`, list);
    const pair = (v) => Array.isArray(v) && v.length === 2 && text(v[0], 256) && Number.isSafeInteger(v[1]);
    let rows;
    if (name === 'records.byInputStringLower' && collection === 'records' && text(message.value)) rows = select('input_string_lower=?', [message.value.toLowerCase()]);
    else if (name === 'records.byInputStrings' && collection === 'records' && values(message.value, (v) => text(v, 4096))) {
      // Dexie's inputString index is case-sensitive. Keep exact matching here;
      // records.byInputStringLower is the separately named canonical lookup.
      rows = select(`json_extract(value_json,'$.inputString') IN (${message.value.map(() => '?').join(',')})`, message.value);
    }
    else if (name === 'records.byRecordType' && collection === 'records' && text(message.value, 128)) rows = select('record_type=?', [message.value]);
    else if (name === 'records.byIds' && collection === 'records' && values(message.value, validId)) rows = inSelect('id_key', message.value.map(idKey));
    else if (name === 'records.byTypeIdForwardKeyset' && collection === 'records' && message.value &&
      text(message.value.type, 128) && (message.value.afterIdExclusive === undefined || Number.isSafeInteger(message.value.afterIdExclusive))) {
      rows = select(`record_type=?${message.value.afterIdExclusive === undefined ? '' : ' AND id_sort>?'} `,
        message.value.afterIdExclusive === undefined ? [message.value.type] : [message.value.type, message.value.afterIdExclusive],
        'id_sort ASC,id_key ASC');
    }
    else if (name === 'records.byTypeIdReverseKeyset' && collection === 'records' && message.value &&
      text(message.value.type, 128) && (message.value.beforeIdExclusive === undefined || Number.isSafeInteger(message.value.beforeIdExclusive))) {
      rows = select(`record_type=?${message.value.beforeIdExclusive === undefined ? '' : ' AND id_sort<?'} `,
        message.value.beforeIdExclusive === undefined ? [message.value.type] : [message.value.type, message.value.beforeIdExclusive],
        'id_sort DESC,id_key DESC');
    }
    else if (name === 'records.countByType' && collection === 'records' && text(message.value, 128)) {
      return { items: [{ count: db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE record_type=?`).get(message.value).count }] };
    }
    else if (name === 'records.filtered' && collection === 'records' && message.value && typeof message.value === 'object' &&
      Array.isArray(message.value.filters) && message.value.filters.length <= 32 &&
      typeof message.value.includeBlockchainDiscovered === 'boolean') {
      // Fixed DTO, evaluated in the protected worker.  SQL only receives
      // worker-authored fragments; JSON payload values are never interpolated.
      const dto = message.value;
      const validField = new Set(['type', 'label', 'inputString', 'owner', 'walletName', 'seedName', 'walletSoftware', 'privateKeyStatus', 'source', 'addressImportance', 'chainType', 'hasNotes', 'tags', 'categories']);
      const validOp = new Set(['equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse', 'includes', 'excludes', 'isAnyOf']);
      if (!dto.filters.every((f) => f && validField.has(f.field) && validOp.has(f.operator) && text(f.value, 4096))) fail();
      const lower = (v) => String(v || '').toLowerCase();
      const filterRow = (row, f) => {
        const value = row[f.field], n = lower(f.value), array = Array.isArray(value) ? value.map(lower) : [];
        let any = []; try { any = JSON.parse(f.value); } catch {}
        any = Array.isArray(any) ? any.filter((v) => typeof v === 'string').map(lower) : [];
        if (f.operator === 'equals') return lower(value) === n;
        if (f.operator === 'notEquals') return lower(value) !== n;
        if (f.operator === 'contains') return lower(value).includes(n);
        if (f.operator === 'startsWith') return lower(value).startsWith(n);
        if (f.operator === 'endsWith') return lower(value).endsWith(n);
        if (f.operator === 'isEmpty') return Array.isArray(value) ? value.length === 0 : !value;
        if (f.operator === 'isNotEmpty') return Array.isArray(value) ? value.length > 0 : !!value;
        if (f.operator === 'isTrue') return value === true;
        if (f.operator === 'isFalse') return value === false;
        if (f.operator === 'includes') return array.includes(n);
        if (f.operator === 'excludes') return !array.includes(n);
        return any.some((v) => Array.isArray(value) ? array.includes(v) : lower(value) === v);
      };
      const clauses = [], args = [];
      if (!dto.includeBlockchainDiscovered) clauses.push("(json_extract(value_json,'$.addressImportance') IS NULL OR json_extract(value_json,'$.addressImportance') NOT IN ('blockchain-discovered','pending-review'))");
      if (Number.isSafeInteger(dto.beforeId)) { clauses.push('id_sort<?'); args.push(dto.beforeId); }
      if (Number.isSafeInteger(dto.addedSince)) { clauses.push('created_at>=?'); args.push(dto.addedSince); }
      if (dto.requireCreatedAt) clauses.push('created_at IS NOT NULL');
      const order = dto.order === 'created-asc' ? 'created_at ASC,id_sort ASC' : dto.order === 'created-desc' ? 'created_at DESC,id_sort DESC' : 'id_sort DESC';
      const candidates = db.prepare(`SELECT value_json FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`).all(...args, limit);
      const q = lower(dto.search).trim();
      rows = candidates.filter((candidate) => {
        const row = JSON.parse(candidate.value_json);
        const found = !q || [row.label, row.inputString, row.owner, row.walletName, row.notes].some((v) => lower(v).includes(q)) || (row.tags || []).some((v) => lower(v).includes(q));
        return found && dto.filters.every((f) => filterRow(row, f));
      });
    }
    else if (name === 'records.byRecordId' && ['records', 'attachments', 'recordOrigins', 'evidence'].includes(collection) && validId(message.value)) {
      // records.byRecordId is a primary-key lookup for records and the legacy
      // record relationship lookup for its dependent collections.
      rows = collection === 'records' ? select('id_key=?', [idKey(message.value)]) : select('record_id_key=?', [idKey(message.value)]);
    } else if (['transactions.byTransactionId', 'transactions.byTxid'].includes(name) && collection === 'blockchainTransactions' && text(message.value, 256)) rows = select('txid=?', [message.value]);
    else if (name === 'transactions.byTxids' && collection === 'blockchainTransactions' && values(message.value, (v) => text(v, 256))) rows = inSelect('txid', message.value);
    else if (name === 'transactions.byBlockTime' && collection === 'blockchainTransactions') rows = select('', [], 'block_time ASC,id_sort ASC,id_key ASC');
    else if (name === 'transactions.byCurationState' && collection === 'blockchainTransactions' && text(message.value, 128)) rows = select('curation_state=?', [message.value]);
    else if (name === 'transactions.afterId' && collection === 'blockchainTransactions' && Number.isSafeInteger(message.value)) rows = select('id_sort>?', [message.value]);
    else if (name === 'participants.byTxid' && collection === 'transactionParticipants' && text(message.value, 256)) rows = select('txid=?', [message.value]);
    else if (name === 'participants.byTxids' && collection === 'transactionParticipants' && values(message.value, (v) => text(v, 256))) rows = inSelect('txid', message.value);
    else if (name === 'participants.byTxidsAfterId' && collection === 'transactionParticipants' &&
      message.value && values(message.value.txids, (v) => text(v, 256)) &&
      Number.isSafeInteger(message.value.afterId) && message.value.afterId >= 0) {
      rows = select(
        `txid IN (${message.value.txids.map(() => '?').join(',')}) AND id_sort>?`,
        [...message.value.txids, message.value.afterId],
      );
    }
    else if (name === 'participants.byAddress' && collection === 'transactionParticipants' && text(message.value)) rows = select('address=?', [message.value]);
    else if (name === 'participants.byAddresses' && collection === 'transactionParticipants' && values(message.value, (v) => text(v))) rows = inSelect('address', message.value);
    else if (name === 'participants.byAddressesAfterId' && collection === 'transactionParticipants' && message.value &&
      values(message.value.addresses, (v) => text(v)) && Number.isSafeInteger(message.value.afterId)) {
      rows = select(`address IN (${message.value.addresses.map(() => '?').join(',')}) AND id_sort>?`,
        [...message.value.addresses, message.value.afterId]);
    }
    else if (name === 'participants.byRecordId' && collection === 'transactionParticipants' && validId(message.value)) rows = select('record_id_key=?', [idKey(message.value)]);
    else if (name === 'participants.byRecordIds' && collection === 'transactionParticipants' && values(message.value, validId)) rows = inSelect('record_id_key', message.value.map(idKey));
    else if (name === 'participants.byPrevout' && collection === 'transactionParticipants' && pair(message.value)) rows = select('prev_txid=? AND prev_vout=?', message.value);
    else if (name === 'participants.byPrevouts' && collection === 'transactionParticipants' && values(message.value, pair)) {
      rows = select(message.value.map(() => '(prev_txid=? AND prev_vout=?)').join(' OR '), message.value.flat());
    } else if (name === 'participants.byRole' && collection === 'transactionParticipants' && text(message.value, 64)) rows = select('role=?', [message.value]);
    else if (name === 'participants.afterId' && collection === 'transactionParticipants' && Number.isSafeInteger(message.value)) rows = select('id_sort>?', [message.value]);
    else if (name === 'sync.byAddress' && ['addressSyncState', 'skippedAddresses', 'addressBlacklist'].includes(collection) && text(message.value)) rows = select('address=?', [message.value]);
    else if (name === 'sync.byLastSyncedAt' && collection === 'addressSyncState') rows = select('', [], 'last_synced_at DESC,id_sort DESC,id_key DESC');
    else if (name === 'sync.skippedByRun' && collection === 'skippedAddresses' && Number.isSafeInteger(message.value)) rows = select('sync_run_timestamp=?', [message.value]);
    else if (name === 'sync.activeSkipped' && collection === 'skippedAddresses') rows = select('dismissed=0');
    else if (name === 'sync.dismissAllSkipped' && collection === 'skippedAddresses') rows = select('');
    else if (name === 'sync.byAddresses' && collection === 'addressSyncState' && values(message.value, text)) rows = inSelect('address', message.value);
    else if (name === 'sync.afterId' && collection === 'addressSyncState' && Number.isSafeInteger(message.value)) rows = select('id_sort>?', [message.value]);
    else if (name === 'price.byDateCurrencyAsset' && collection === 'priceData' && Array.isArray(message.value) && message.value.length === 3 && message.value.every((v) => text(v))) rows = select('date_value=? AND currency=? AND asset=?', message.value);
    else if (name === 'price.byDateCurrencyAssetKeys' && collection === 'priceData' && values(message.value, (v) => Array.isArray(v) && v.length === 3 && v.every((part) => text(part)))) rows = select(message.value.map(() => '(date_value=? AND currency=? AND asset=?)').join(' OR '), message.value.flat());
    else if (name === 'price.byAsset' && collection === 'priceData' && message.value && text(message.value.asset, 128) && (message.value.currency === undefined || text(message.value.currency, 32))) rows = select(`asset=?${message.value.currency ? ' AND currency=?' : ''}`, message.value.currency ? [message.value.asset, message.value.currency] : [message.value.asset]);
    else if (name === 'price.latestOnOrBefore' && collection === 'priceData' && message.value && text(message.value.date, 64) && text(message.value.currency, 32) && text(message.value.asset, 128)) rows = select('date_value<=? AND currency=? AND asset=?', [message.value.date, message.value.currency, message.value.asset], 'date_value DESC,id_sort DESC,id_key DESC');
    else if (name === 'savedPsbts.byCreatedAt' && collection === 'savedPsbts') rows = select('', [], 'created_at DESC,id_sort DESC,id_key DESC');
    else if (name === 'attachments.byRecordId' && collection === 'attachments' && validId(message.value)) rows = select('record_id_key=?', [idKey(message.value)]);
    else if (name === 'attachments.byIdentifier' && collection === 'attachments' && (text(message.value) || Number.isSafeInteger(message.value))) rows = select('id_key=?', [idKey(message.value)]);
    else if (name === 'evidenceAttachments.byEvidenceId' && collection === 'evidenceAttachments' && Number.isSafeInteger(message.value)) rows = select('evidence_id=?', [message.value]);
    else {
      const lineage = {
        'lineage.bySpentOutpoint': ['spent_txid=? AND spent_vout=?', pair],
        'lineage.byCreatedOutpoint': ['created_txid=? AND created_vout=?', pair],
        'lineage.bySpentAddress': ['spent_address=?', text],
        'lineage.byCreatedAddress': ['created_address=?', text],
        'lineage.bySegmentId': ['segment_id=?', text],
        'lineage.bySnapshotId': ['snapshot_id=?', text],
        'lineage.byOriginOutpoint': ['origin_txid=? AND origin_vout=?', pair],
        'lineage.byOriginAddress': ['origin_address=?', text],
        'lineage.byCurrentAddress': ['current_address=?', text],
      }[name];
      if (name === 'lineage.byCreatedOutpoints' && collection === 'utxoLineage' && values(message.value, pair)) {
        rows = select(message.value.map(() => '(created_txid=? AND created_vout=?)').join(' OR '), message.value.flat());
      }
      else if (collection === 'utxoLineage' && lineage && lineage[1](message.value)) rows = select(lineage[0], Array.isArray(message.value) ? message.value : [message.value]);
      else fail();
    }
    return { items: rows.map((row) => JSON.parse(row.value_json)) };
  }
  if (operation === 'batch') {
    if (!Array.isArray(message.operations) || message.operations.length < 1 || message.operations.length > 1000) fail();
    const run = db.transaction((operations) => operations.map((entry) => {
      if (!entry || typeof entry !== 'object' || !['save', 'remove'].includes(entry.operation)) fail();
      if (entry.operation === 'save') return { operation: 'save', id: save(entry.row) };
      if (!validId(entry.id)) fail();
      return { operation: 'remove', deleted: db.prepare(`DELETE FROM ${table} WHERE id_key=?`).run(idKey(entry.id)).changes === 1 };
    }));
    return { results: run(message.operations) };
  }
  fail();
}

parentPort.on('message', async (message) => {
  const requestId = message && message.requestId;
  try {
    const result = await handle(message && message.type, message && message.payload || {});
    parentPort.postMessage({ requestId, ok: true, result });
  } catch {
    // A single stable error avoids exposing passwords, keys, paths, sqlite text, or object names.
    parentPort.postMessage({ requestId, ok: false, error: 'Protected store operation failed' });
  }
});
