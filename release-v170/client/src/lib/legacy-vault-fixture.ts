/**
 * DEV/TEST-ONLY: builds an on-disk vault EXACTLY as release 1.1.24 left it —
 * Dexie schema v25 with field-level encryption at rest (`isEncrypted: true`,
 * real values inside `encryptedPayload`, `'[encrypted]'` placeholders in the
 * plaintext columns).
 *
 * Reopening this database through the real `KYUTXODatabase` class afterwards
 * exercises the genuine first-launch upgrade journey a 1.1.24 user goes
 * through today: the v26–v37 schema upgrade chain (v27 moves the payloads to
 * `_legacyEncryptedPayload`), then the one-time login decrypt migration.
 *
 * Used by:
 *  - `legacy-migration.test.ts` (small counts, fake-indexeddb)
 *  - `scripts/check-legacy-upgrade-scale-browser.mjs` (large counts, real
 *    Chromium against the dev server)
 *
 * IMPORTANT: this module must not import `./database` (the app singleton) —
 * creating the fixture must never open the DB at the CURRENT schema version.
 * It builds its own raw Dexie handles instead (crud-guard allowlisted).
 */

import Dexie from 'dexie';
import { deriveKey, encrypt, hashPassword, bufferToBase64, LEGACY_PBKDF2_ITERATIONS } from './crypto';

/** The exact Dexie v25 schema as declared by release 1.1.24. */
export const V25_STORES: { [table: string]: string } = {
  records:
    '++id, type, inputString, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType, discoveredFromRecordId',
  attachments: '++id, recordId, createdAt, isEncrypted',
  tags: '++id, name, createdAt, isEncrypted',
  categories: '++id, name, createdAt, isEncrypted',
  owners: '++id, name, createdAt, isEncrypted',
  walletNames: '++id, name, createdAt, isEncrypted',
  seedNames: '++id, name, createdAt, isEncrypted',
  walletSoftware: '++id, name, createdAt, isEncrypted',
  recordOrigins: '++id, recordId, originType, createdAt, isEncrypted',
  customFields: '++id, slug, enabled, createdAt',
  settings: 'id',
  priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
  blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn',
  transactionParticipants: '++id, [txid+role], txid, role, recordId, isEncrypted',
  addressSyncState: '++id, &address, recordId, lastSyncedAt',
  nodeSettings: 'id',
  derivationTemplates:
    '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
  utxoLineage:
    '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
  custodySegments:
    '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
  lineageSnapshots:
    '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
  evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
  evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted',
  pausedSyncState: 'id',
  skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
  addressBlacklist: '++id, &address, addedAt',
};

export const ENCRYPTED_AT_REST = '[encrypted]';

export interface LegacyVaultCounts {
  /** Curated (user-entered) address records — encrypted at rest. */
  curatedRecords: number;
  /** Blockchain-discovered counterparty records — encrypted at rest. */
  discoveredRecords: number;
  /** Plaintext blockchainTransactions rows. */
  transactions: number;
  /** Encrypted transactionParticipants rows (~inputs+outputs across txs). */
  participants: number;
  /** Placeholder-name vocabulary rows per table (v29 delete path). */
  placeholderVocab: number;
}

export interface LegacyVaultBuildResult {
  counts: LegacyVaultCounts & { vocab: number };
  /** Sample of expected post-migration plaintext, for verification. */
  samples: Array<{ recordIndex: number; inputString: string; label: string }>;
  password: string;
  saltBase64: string;
}

export interface LegacyVaultBuildOptions {
  password: string;
  counts?: Partial<LegacyVaultCounts>;
  /**
   * Also write the `kybtc-vault` settings DB (salt + password hash) so the app
   * accepts `password` at the login screen. Leave false in unit tests that
   * never render the app.
   */
  writeVaultSettings?: boolean;
  onProgress?: (phase: string, done: number, total: number) => void;
  /** Seed batch size for bulkAdd chunks. */
  batchSize?: number;
}

/** Deterministic PRNG so tests can recompute expected values. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Deterministic fake-but-plausible bech32-style address for index i. */
export function legacyFixtureAddress(i: number): string {
  let s = '';
  let v = (i * 2654435761) >>> 0;
  for (let k = 0; k < 32; k++) {
    s += B32[v % 32];
    v = ((v >>> 5) ^ (v * 31 + k)) >>> 0;
  }
  return `bc1q${s}`;
}

/** Deterministic fake txid for index i. */
export function legacyFixtureTxid(i: number): string {
  const rng = mulberry32(0x7ab1 + i);
  let s = '';
  for (let k = 0; k < 64; k++) s += '0123456789abcdef'[Math.floor(rng() * 16)];
  return s;
}

export function legacyFixtureRecordPlaintext(i: number, isDiscovered: boolean) {
  return {
    inputString: legacyFixtureAddress(i),
    label: isDiscovered ? `Counterparty ${i}` : `Wallet address ${i}`,
    notes: i % 7 === 0 ? `Imported during batch ${Math.floor(i / 500)}` : '',
    owner: `Owner ${i % 5}`,
    walletName: `Wallet ${i % 8}`,
    seedName: i % 3 === 0 ? `Seed ${i % 4}` : '',
    walletSoftware: 'Sparrow',
    source: isDiscovered ? 'blockchain-sync' : 'manual-entry',
  };
}

/**
 * Build the complete 1.1.24-shaped vault. Returns expected plaintext samples
 * so callers can verify the decrypt migration restored real values.
 */
export async function buildLegacyVaultAtV25(
  options: LegacyVaultBuildOptions,
): Promise<LegacyVaultBuildResult> {
  const counts: LegacyVaultCounts = {
    curatedRecords: options.counts?.curatedRecords ?? 40,
    discoveredRecords: options.counts?.discoveredRecords ?? 60,
    transactions: options.counts?.transactions ?? 50,
    participants: options.counts?.participants ?? 150,
    placeholderVocab: options.counts?.placeholderVocab ?? 2,
  };
  const BATCH = options.batchSize ?? 2000;
  const onProgress = options.onProgress ?? (() => {});

  // Key setup — same PBKDF2 + AES-GCM path release 1.1.24 used.
  const salt = new Uint8Array(16);
  const saltRng = mulberry32(0xbeef);
  for (let i = 0; i < salt.length; i++) salt[i] = Math.floor(saltRng() * 256);
  const saltBase64 = bufferToBase64(salt);
  // A LEGACY vault fixture: everything here (at-rest payloads + the vault
  // settings hash) was only ever produced at the pre-strengthening iteration
  // count, so pin LEGACY explicitly now that the crypto defaults moved.
  const key = await deriveKey(options.password, salt, LEGACY_PBKDF2_ITERATIONS);

  if (options.writeVaultSettings) {
    const passwordHash = await hashPassword(options.password, salt, LEGACY_PBKDF2_ITERATIONS);
    const vaultFixtureDb = new Dexie('kybtc-vault');
    vaultFixtureDb.version(1).stores({ vault: 'id' });
    await vaultFixtureDb.open();
    await vaultFixtureDb.table('vault').put({
      id: 'main',
      salt: saltBase64,
      passwordHash,
      createdAt: Date.now() - 400 * 24 * 3600 * 1000,
      // Deliberately NO migration flags: a 1.1.24 vault predates them all.
    });
    vaultFixtureDb.close();
  }

  const legacy = new Dexie('KYUTXODatabase');
  legacy.version(25).stores(V25_STORES);
  await legacy.open();
  if (legacy.verno !== 25) {
    legacy.close();
    throw new Error(
      `legacy fixture expected to open KYUTXODatabase at v25, got v${legacy.verno} — the database already exists at a newer version; delete it first`,
    );
  }

  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const rng = mulberry32(0x1124);

  // --- vocabulary (small) --------------------------------------------------
  const vocabSpecs: Array<{ table: string; names: string[] }> = [
    { table: 'owners', names: ['Owner 0', 'Owner 1', 'Owner 2', 'Owner 3', 'Owner 4'] },
    { table: 'walletNames', names: Array.from({ length: 8 }, (_, i) => `Wallet ${i}`) },
    { table: 'seedNames', names: Array.from({ length: 4 }, (_, i) => `Seed ${i}`) },
    { table: 'walletSoftware', names: ['Sparrow', 'Electrum'] },
    { table: 'tags', names: ['cold-storage', 'kyc', 'mining', 'p2p'] },
    { table: 'categories', names: ['savings', 'income'] },
  ];
  let vocabTotal = 0;
  for (const spec of vocabSpecs) {
    const rows = spec.names.map((name, i) => ({
      name,
      createdAt: now - (300 - i) * dayMs,
    }));
    for (let i = 0; i < counts.placeholderVocab; i++) {
      // Stale rows the v29 upgrade must delete.
      rows.push({ name: `${ENCRYPTED_AT_REST}-${i}`, createdAt: now - 200 * dayMs });
    }
    await legacy.table(spec.table).bulkAdd(rows);
    vocabTotal += rows.length;
  }
  onProgress('vocabulary', vocabTotal, vocabTotal);

  // --- records (encrypted at rest, exactly like dbEncryption.encryptRecord) -
  const totalRecords = counts.curatedRecords + counts.discoveredRecords;
  const samples: LegacyVaultBuildResult['samples'] = [];
  {
    let batch: Record<string, unknown>[] = [];
    for (let i = 0; i < totalRecords; i++) {
      const isDiscovered = i >= counts.curatedRecords;
      const plain = legacyFixtureRecordPlaintext(i, isDiscovered);
      const encryptedPayload = await encrypt(JSON.stringify(plain), key);
      const createdAt = now - Math.floor(rng() * 400) * dayMs;
      batch.push({
        type: 'address',
        inputString: ENCRYPTED_AT_REST,
        label: ENCRYPTED_AT_REST,
        notes: undefined,
        seedName: undefined,
        walletSoftware: undefined,
        owner: undefined,
        walletName: undefined,
        source: undefined,
        customFields: undefined,
        costBasisUsd: undefined,
        tags: i % 11 === 0 ? ['cold-storage'] : [],
        categories: [],
        chainType: 'BTC',
        addressImportance: isDiscovered
          ? 'blockchain-discovered'
          : i % 3 === 0
            ? 'verified'
            : i % 3 === 1
              ? 'manual'
              : 'xpub-derived',
        cachedBalanceSats: i % 4 === 0 ? Math.floor(rng() * 2_000_000) : 0,
        cachedTxCount: Math.floor(rng() * 12),
        createdAt,
        updatedAt: createdAt + Math.floor(rng() * 30) * dayMs,
        encryptedPayload,
        isEncrypted: true,
      });
      if (samples.length < 25 && i % Math.max(1, Math.floor(totalRecords / 25)) === 0) {
        samples.push({ recordIndex: i, inputString: plain.inputString, label: plain.label });
      }
      if (batch.length >= BATCH) {
        await legacy.table('records').bulkAdd(batch);
        batch = [];
        onProgress('records', i + 1, totalRecords);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (batch.length > 0) await legacy.table('records').bulkAdd(batch);
    onProgress('records', totalRecords, totalRecords);
  }

  // --- blockchain transactions (plaintext, as in 1.1.24) --------------------
  {
    let batch: Record<string, unknown>[] = [];
    for (let i = 0; i < counts.transactions; i++) {
      const blockTime = Math.floor((now - Math.floor(rng() * 500) * dayMs) / 1000);
      batch.push({
        txid: legacyFixtureTxid(i),
        blockHeight: 780_000 + i,
        blockTime,
        fee: 1000 + Math.floor(rng() * 20000),
        feeRate: 1 + Math.floor(rng() * 80),
        syncedAt: now - Math.floor(rng() * 100) * dayMs,
        size: 200 + Math.floor(rng() * 800),
        vsize: 140 + Math.floor(rng() * 600),
        hasOpReturn: false,
      });
      if (batch.length >= BATCH) {
        await legacy.table('blockchainTransactions').bulkAdd(batch);
        batch = [];
        onProgress('transactions', i + 1, counts.transactions);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (batch.length > 0) await legacy.table('blockchainTransactions').bulkAdd(batch);
    onProgress('transactions', counts.transactions, counts.transactions);
  }

  // --- participants (encrypted at rest, like dbEncryption.encryptParticipant)
  {
    let batch: Record<string, unknown>[] = [];
    for (let i = 0; i < counts.participants; i++) {
      const txIndex = i % Math.max(1, counts.transactions);
      const isInput = i % 3 === 0; // ~1/3 inputs, 2/3 outputs
      const addrIndex = i % Math.max(1, totalRecords);
      const plain: Record<string, unknown> = {
        address: legacyFixtureAddress(addrIndex),
        amount: 5_000 + Math.floor(rng() * 5_000_000),
      };
      if (isInput) {
        // Spend an earlier tx's output → outpoint chain for UTXO detection.
        plain.prevTxid = legacyFixtureTxid((txIndex + counts.transactions - 1) % counts.transactions);
        plain.prevVout = i % 2;
      }
      const encryptedPayload = await encrypt(JSON.stringify(plain), key);
      batch.push({
        txid: legacyFixtureTxid(txIndex),
        role: isInput ? 'input' : 'output',
        address: ENCRYPTED_AT_REST,
        amount: 0,
        vout: isInput ? undefined : i % 3,
        prevTxid: isInput ? ENCRYPTED_AT_REST : undefined,
        prevVout: isInput ? 0 : undefined,
        recordId: addrIndex + 1, // 1-based auto-increment ids in insertion order
        encryptedPayload,
        isEncrypted: true,
      });
      if (batch.length >= BATCH) {
        await legacy.table('transactionParticipants').bulkAdd(batch);
        batch = [];
        onProgress('participants', i + 1, counts.participants);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (batch.length > 0) await legacy.table('transactionParticipants').bulkAdd(batch);
    onProgress('participants', counts.participants, counts.participants);
  }

  // --- addressSyncState for a slice of records (realistic synced vault) -----
  {
    const syncCount = Math.min(totalRecords, Math.max(50, Math.floor(totalRecords / 4)));
    let batch: Record<string, unknown>[] = [];
    for (let i = 0; i < syncCount; i++) {
      batch.push({
        address: legacyFixtureAddress(i),
        recordId: i + 1,
        lastSyncedHeight: 890_000,
        lastSyncedAt: now - Math.floor(rng() * 60) * dayMs,
        txCount: Math.floor(rng() * 10),
      });
      if (batch.length >= BATCH) {
        await legacy.table('addressSyncState').bulkAdd(batch);
        batch = [];
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (batch.length > 0) await legacy.table('addressSyncState').bulkAdd(batch);
    onProgress('addressSyncState', syncCount, syncCount);
  }

  legacy.close();

  return {
    counts: { ...counts, vocab: vocabTotal },
    samples,
    password: options.password,
    saltBase64,
  };
}
