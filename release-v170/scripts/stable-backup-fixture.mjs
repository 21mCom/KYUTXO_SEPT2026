import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STABLE_BACKUP_FIXTURE_DIR = path.join(ROOT, 'test-fixtures', 'backups');
export const STABLE_BACKUP_FIXTURE_NAME = 'kyutxo-v1.1.24-sanitized-v3.zip';
export const STABLE_BACKUP_FIXTURE_PATH = path.join(
  STABLE_BACKUP_FIXTURE_DIR,
  STABLE_BACKUP_FIXTURE_NAME,
);
export const STABLE_BACKUP_PROVENANCE_PATH = path.join(
  STABLE_BACKUP_FIXTURE_DIR,
  'kyutxo-v1.1.24-sanitized-v3.provenance.json',
);
export const STABLE_BACKUP_PASSWORD = 'stable-release-fixture-v1.1.24';

const EXPECTED_ARCHIVE_ENTRIES = [
  'backup.json',
  'tables/records.ndjson',
  'tables/attachments.ndjson',
  'tables/transactionParticipants.ndjson',
  'tables/addressSyncState.ndjson',
  'tables/blockchainTransactions.ndjson',
  'tables/utxoLineage.ndjson',
  'tables/custodySegments.ndjson',
  'tables/lineageSnapshots.ndjson',
];
const STREAMED_TABLES = [
  'records',
  'attachments',
  'transactionParticipants',
  'addressSyncState',
  'blockchainTransactions',
  'utxoLineage',
  'custodySegments',
  'lineageSnapshots',
];
const EXPECTED_MANIFEST_KEYS = [
  'formatVersion',
  'app',
  'appVersion',
  'exportDate',
  'encrypted',
  'salt',
  'check',
  'counts',
  'totalAttachmentBytes',
  'streamedTables',
  'inlineEnc',
];
const EXPECTED_INLINE = {
  tags: [],
  categories: [],
  owners: [],
  walletNames: [],
  seedNames: [],
  walletSoftware: [],
  recordOrigins: [],
  customFields: [],
  derivationTemplates: [],
  evidence: [],
  evidenceAttachments: [],
  priceData: [],
  settings: [{ id: 'default', disableOrphanCheck: true }],
  nodeSettings: [],
  dustFlags: [],
};
const EXPECTED_ROWS = {
  records: [{
    type: 'address',
    inputString: 'bc1qstablefixture0000000000000000000000000',
    inputStringLower: 'bc1qstablefixture0000000000000000000000000',
    label: 'Sanitized stable release fixture',
    notes: 'No user data',
    tags: ['golden'],
    categories: [],
    addressImportance: 'manual',
    createdAt: 1722258000000,
    updatedAt: 1722258000000,
    id: 1,
  }],
  attachments: [],
  transactionParticipants: [],
  addressSyncState: [],
  blockchainTransactions: [{
    txid: '0000000000000000000000000000000000000000000000000000000000000245',
    blockHeight: 852424,
    blockTime: 1722258000,
    syncedAt: 1722258000000,
    hasOpReturn: false,
    id: 1,
  }],
  utxoLineage: [],
  custodySegments: [],
  lineageSnapshots: [],
};
const PRIVATE_KEY_PATTERNS = [
  /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/,
  /\b(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]{100,112}\b/i,
  /\b(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident)(?:\s+[a-z]{3,8}){11,23}\b/i,
];
const RAW_PRIVATE_KEY_PATTERN = /\b[0-9a-f]{64}\b/i;

function assertExact(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} is outside the explicit synthetic allowlist`);
  }
}

async function deriveFixtureKey(password, manifest) {
  if (manifest.kdf || manifest.kdfIterations != null) {
    throw new Error('Stable backup privacy audit only accepts the pinned legacy PBKDF2 format');
  }
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webcrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: Buffer.from(manifest.salt, 'base64'),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

async function decryptText(envelope, key) {
  const bytes = Buffer.from(envelope, 'base64');
  if (bytes.length <= 28) throw new Error('Encrypted fixture payload is too short');
  const plaintext = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
    key,
    bytes.subarray(12),
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}

function rejectPrivateKeyMaterial(value, location) {
  const text = JSON.stringify(value);
  for (const pattern of PRIVATE_KEY_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`${location} contains private-key or seed-phrase material`);
    }
  }
  const pending = [{ value, path: location }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.value == null || typeof current.value !== 'object') continue;
    for (const [key, child] of Object.entries(current.value)) {
      const childPath = `${current.path}.${key}`;
      if (typeof child === 'string' &&
          /(?:private|secret|seed|mnemonic|wif|xprv|key)/i.test(key) &&
          RAW_PRIVATE_KEY_PATTERN.test(child)) {
        throw new Error(`${childPath} contains raw private-key material`);
      }
      if (child && typeof child === 'object') pending.push({ value: child, path: childPath });
    }
  }
}

export async function auditStableBackupFixturePrivacy(buffer, password = STABLE_BACKUP_PASSWORD) {
  const zip = await JSZip.loadAsync(buffer, { createFolders: false });
  const entries = Object.values(zip.files);
  const names = entries.map((entry) => entry.name);
  assertExact('Archive entry list', names, EXPECTED_ARCHIVE_ENTRIES);
  if (entries.some((entry) => entry.dir || entry.name.startsWith('attachments/'))) {
    throw new Error('Stable backup fixture must not contain attachment entries');
  }

  const manifestFile = zip.file('backup.json');
  if (!manifestFile) throw new Error('Stable backup fixture is missing backup.json');
  const manifest = JSON.parse(await manifestFile.async('text'));
  assertExact('Manifest field list', Object.keys(manifest), EXPECTED_MANIFEST_KEYS);
  assertExact('Manifest identity', {
    formatVersion: manifest.formatVersion,
    app: manifest.app,
    appVersion: manifest.appVersion,
    exportDate: manifest.exportDate,
    encrypted: manifest.encrypted,
    counts: manifest.counts,
    totalAttachmentBytes: manifest.totalAttachmentBytes,
    streamedTables: manifest.streamedTables,
    compact: manifest.compact,
  }, {
    formatVersion: 3,
    app: 'KYUTXO',
    appVersion: '1.1.24',
    exportDate: '2026-09-10T12:17:03.118Z',
    encrypted: true,
    counts: {
      records: 1,
      attachments: 0,
      transactionParticipants: 0,
      addressSyncState: 0,
      blockchainTransactions: 1,
      utxoLineage: 0,
      custodySegments: 0,
      lineageSnapshots: 0,
      attachmentFiles: 0,
    },
    totalAttachmentBytes: 0,
    streamedTables: STREAMED_TABLES,
    compact: undefined,
  });
  if (typeof manifest.salt !== 'string' ||
      typeof manifest.check !== 'string' ||
      typeof manifest.inlineEnc !== 'string' ||
      'inline' in manifest ||
      'data' in manifest) {
    throw new Error('Stable backup fixture must use encrypted v3 payloads only');
  }

  const key = await deriveFixtureKey(password, manifest);
  const check = await decryptText(manifest.check, key);
  if (check !== 'KYUTXO-BACKUP-V3') throw new Error('Stable backup password check is invalid');

  const inline = JSON.parse(await decryptText(manifest.inlineEnc, key));
  rejectPrivateKeyMaterial(inline, 'Inline portable tables');
  assertExact('Inline portable tables', inline, EXPECTED_INLINE);

  for (const table of STREAMED_TABLES) {
    const entry = zip.file(`tables/${table}.ndjson`);
    if (!entry) throw new Error(`Stable backup fixture is missing streamed table ${table}`);
    const encryptedLines = (await entry.async('text')).split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of encryptedLines) {
      const batch = JSON.parse(await decryptText(line, key));
      if (!Array.isArray(batch)) throw new Error(`Streamed table ${table} contains a non-array batch`);
      rows.push(...batch);
    }
    rejectPrivateKeyMaterial(rows, `Streamed table ${table}`);
    assertExact(`Streamed table ${table}`, rows, EXPECTED_ROWS[table]);
  }

  return { archiveEntries: names.length, portableTables: STREAMED_TABLES.length + Object.keys(EXPECTED_INLINE).length };
}

export function readVerifiedStableBackupFixture() {
  const provenance = JSON.parse(fs.readFileSync(STABLE_BACKUP_PROVENANCE_PATH, 'utf8'));
  const sidecar = fs.readFileSync(`${STABLE_BACKUP_FIXTURE_PATH}.sha256`, 'utf8').trim();
  const [sidecarDigest, sidecarName, ...extra] = sidecar.split(/\s+/);
  if (extra.length || sidecarName !== STABLE_BACKUP_FIXTURE_NAME) {
    throw new Error('Stable backup checksum sidecar has an invalid shape or filename');
  }
  if (
    provenance.fixture !== STABLE_BACKUP_FIXTURE_NAME ||
    provenance.sourceTag !== 'v1.1.24' ||
    provenance.sourceRevision !== 'b4021938b4c258a894e77698976cf28aa20d23c5' ||
    provenance.password !== STABLE_BACKUP_PASSWORD
  ) {
    throw new Error('Stable backup provenance no longer identifies the pinned v1.1.24 release');
  }
  const buffer = fs.readFileSync(STABLE_BACKUP_FIXTURE_PATH);
  const actualDigest = createHash('sha256').update(buffer).digest('hex');
  if (actualDigest !== sidecarDigest || actualDigest !== provenance.sha256) {
    throw new Error(
      `Stable backup checksum mismatch: expected ${provenance.sha256}, got ${actualDigest}`,
    );
  }
  return { buffer, digest: actualDigest, provenance };
}