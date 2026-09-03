/* Native worker boundary.  It deliberately exposes no filesystem paths or SQL. */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const ROOT = workerData && workerData.dataDir;
if (typeof ROOT !== 'string' || !ROOT) throw new Error('protected store configuration invalid');
const HEADER = path.join(ROOT, 'protected-store.header.json');
const DB_FILE = path.join(ROOT, 'protected-store.sqlite');
const OBJECTS = path.join(ROOT, 'protected-objects');
const FORMAT = 1;
const CHUNK_SIZE = 64 * 1024;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const TABLES = new Set([
  'records', 'attachments', 'tags', 'categories', 'owners', 'walletNames',
  'seedNames', 'walletSoftware', 'recordOrigins', 'customFields', 'settings',
  'priceData', 'blockchainTransactions', 'transactionParticipants',
  'addressSyncState', 'nodeSettings', 'derivationTemplates', 'utxoLineage',
  'custodySegments', 'lineageSnapshots', 'evidence', 'evidenceAttachments',
  'pausedSyncState', 'skippedAddresses', 'addressBlacklist',
  'partialExportBundles', 'trashedAttachments', 'privacyAuditHistory',
  'dustFlags', 'savedPsbts', 'adversaryScenarios', 'vault',
]);

let db = null;
let vdk = null;
let header = null;
let keys = null;

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
  let Database;
  try { Database = require('better-sqlite3-multiple-ciphers'); } catch { fail(); }
  try {
    db = new Database(DB_FILE);
    // Hex key avoids SQL escaping and the VDK-derived key never enters SQL text.
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`key = "x'${keys.sql.toString('hex')}'"`);
    db.pragma('cipher_memory_security = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS protected_rows (
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY(table_name,row_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS protected_sentinel (value TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS protected_attachment_refs (
        alias TEXT PRIMARY KEY,
        object_id TEXT NOT NULL,
        object_name TEXT NOT NULL,
        plaintext_size INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);
    db.prepare('INSERT OR IGNORE INTO protected_sentinel(value) VALUES (?)').run(b64(crypto.createHmac('sha256', keys.sql).update('sentinel').digest()));
    const sentinel = db.prepare('SELECT value FROM protected_sentinel LIMIT 1').get();
    if (!sentinel || sentinel.value !== b64(crypto.createHmac('sha256', keys.sql).update('sentinel').digest())) fail();
  } catch {
    closeUnlocked();
    fail();
  }
}
function closeUnlocked() {
  if (db) { try { db.close(); } catch {} }
  db = null;
  if (vdk) vdk.fill(0);
  vdk = null;
  keys = null;
  header = null;
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
function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id); }
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
    available: true,
    exists: fs.existsSync(HEADER),
    unlocked: !!db,
    verified: !!db,
    version: FORMAT,
  };
  if (type === 'create') return create(message);
  if (type === 'unlock') return unlock(message);
  if (type === 'lock') { closeUnlocked(); return { unlocked: false }; }
  if (type === 'changePassword') return changePassword(message);
  if (type === 'integrity') { locked(); const result = db.pragma('integrity_check', { simple: true }); if (result !== 'ok') fail(); return { ok: true }; }
  if (type === 'putRow') {
    locked(); if (!validTable(message.table) || !validId(message.id)) fail();
    const value = JSON.stringify(message.row);
    if (value === undefined || Buffer.byteLength(value) > MAX_VALUE_BYTES) fail();
    db.prepare('INSERT INTO protected_rows(table_name,row_id,value_json) VALUES (?,?,?) ON CONFLICT(table_name,row_id) DO UPDATE SET value_json=excluded.value_json').run(message.table, message.id, value);
    return { id: message.id };
  }
  if (type === 'getRow') {
    locked(); if (!validTable(message.table) || !validId(message.id)) fail();
    const row = db.prepare('SELECT value_json FROM protected_rows WHERE table_name=? AND row_id=?').get(message.table, message.id);
    return row ? JSON.parse(row.value_json) : null;
  }
  if (type === 'listRows') {
    locked(); if (!validTable(message.table)) fail();
    const limit = Number.isInteger(message.limit) && message.limit > 0 && message.limit <= 1000 ? message.limit : 100;
    const after = message.after === undefined ? '' : message.after;
    if (typeof after !== 'string' || (after && !validId(after))) fail();
    return db.prepare('SELECT row_id,value_json FROM protected_rows WHERE table_name=? AND row_id>? ORDER BY row_id LIMIT ?').all(message.table, after, limit).map((r) => ({ id: r.row_id, row: JSON.parse(r.value_json) }));
  }
  if (type === 'deleteRow') {
    locked(); if (!validTable(message.table) || !validId(message.id)) fail();
    db.prepare('DELETE FROM protected_rows WHERE table_name=? AND row_id=?').run(message.table, message.id); return { deleted: true };
  }
  if (type === 'writeAttachment') return writeAttachment(message);
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