import Dexie, { type Table } from 'dexie';

// Re-export all types and constants from db-types
export * from './db-types';

// Value import: used at runtime to seed the default settings row.
import { createDefaultSettings } from './db-types';
import { reportDbUpgradeProgress } from './db-upgrade-progress';

/**
 * Highest Dexie schema version declared below. Used before opening the
 * database to detect that an on-disk vault from an older release is about to
 * run the (potentially long) one-time upgrade chain, so the UI can show a
 * visible "upgrading" overlay instead of a bare spinner. Dexie stores its
 * schema version multiplied by 10 as the raw IndexedDB version.
 *
 * KEEP IN SYNC when adding a new `this.version(N)` declaration — the
 * legacy-migration test asserts this matches the opened database.
 */
export const CURRENT_SCHEMA_VERSION = 39;

// Import types needed for the class definition
import type {
  Record, Attachment, Tag, Category, Owner, WalletName, SeedName, WalletSoftware,
  RecordOrigin, CustomField, Settings, PriceData, BlockchainTransaction,
  TransactionParticipant, AddressSyncState, NodeSettings, DerivationTemplate,
  UtxoLineage, CustodySegment, LineageSnapshot, Evidence, EvidenceAttachment,
  PausedSyncState, SkippedAddress, AddressBlacklist, PartialExportBundle,
  TrashedAttachment, PrivacyAuditHistoryEntry, DustFlag, SavedPsbt,
  AdversaryScenario,
} from './db-types';

export class KYUTXODatabase extends Dexie {
  // IMPORTANT: Do not call write methods (add, put, update, delete, bulkAdd,
  // bulkPut, bulkDelete, modify, clear) on db.records outside record-crud.ts.
  // All record writes must go through the CRUD layer in
  // client/src/lib/data/record-crud.ts (re-exported via dataFacade.ts).
  // Run `node scripts/check-crud-guards.js` to verify compliance.
  records!: Table<Record>;
  attachments!: Table<Attachment>;
  tags!: Table<Tag>;
  categories!: Table<Category>;
  owners!: Table<Owner>;
  walletNames!: Table<WalletName>;
  seedNames!: Table<SeedName>;
  walletSoftware!: Table<WalletSoftware>;
  recordOrigins!: Table<RecordOrigin>;
  customFields!: Table<CustomField>;
  settings!: Table<Settings>;
  priceData!: Table<PriceData>;
  // IMPORTANT: Do not call write methods (add, put, update, delete, bulkAdd,
  // bulkPut, bulkDelete, modify, clear) on db.blockchainTransactions or
  // db.transactionParticipants outside of transaction-crud.ts.
  // All writes must go through client/src/lib/data/transaction-crud.ts.
  blockchainTransactions!: Table<BlockchainTransaction>;
  transactionParticipants!: Table<TransactionParticipant>;
  addressSyncState!: Table<AddressSyncState>;
  nodeSettings!: Table<NodeSettings>;
  derivationTemplates!: Table<DerivationTemplate>;
  // Lineage tracking tables for AML/SOF
  // IMPORTANT: Do not call write methods (add, put, update, delete, bulkAdd,
  // bulkPut, bulkDelete, modify, clear) on db.utxoLineage or
  // db.custodySegments outside of lineage-crud.ts.
  // All writes must go through client/src/lib/data/lineage-crud.ts.
  utxoLineage!: Table<UtxoLineage>;
  custodySegments!: Table<CustodySegment>;
  lineageSnapshots!: Table<LineageSnapshot>;
  // Evidence/document storage tables
  evidence!: Table<Evidence>;
  evidenceAttachments!: Table<EvidenceAttachment>;
  // Paused sync state for resume functionality
  pausedSyncState!: Table<PausedSyncState>;
  // Sync protection tables
  skippedAddresses!: Table<SkippedAddress>;
  addressBlacklist!: Table<AddressBlacklist>;
  partialExportBundles!: Table<PartialExportBundle>;
  // Recoverable metadata for attachments whose record/row was deleted; the file
  // bytes are kept on disk so they can be downloaded back or purged from Settings.
  trashedAttachments!: Table<TrashedAttachment>;
  // Snapshots of completed Privacy Audits for tracking score over time.
  privacyAuditHistory!: Table<PrivacyAuditHistoryEntry>;
  // User-flagged dust outputs (keyed by outpoint "txid:vout") so dusted
  // outputs can be indicated in the UTXOs page and annotated in reports.
  dustFlags!: Table<DustFlag>;
  // Unsigned PSBTs built from selected UTXOs (watch-only: no keys, no signing,
  // no broadcasting), stored with their decoded components.
  // IMPORTANT: Do not call write methods (add, put, update, delete, bulkAdd,
  // bulkPut, bulkDelete, modify, clear) on db.savedPsbts outside of
  // saved-psbts-crud.ts.
  savedPsbts!: Table<SavedPsbt>;
  // Named "what if they knew?" counterparty-knowledge scenarios for the
  // Privacy Audit's adversary view (assumed known addresses/transactions).
  // IMPORTANT: Do not call write methods (add, put, update, delete, bulkAdd,
  // bulkPut, bulkDelete, modify, clear) on db.adversaryScenarios outside of
  // adversary-scenarios-crud.ts.
  adversaryScenarios!: Table<AdversaryScenario>;

  constructor() {
    super('KYUTXODatabase');

    // v39: add the adversaryScenarios table — named counterparty-knowledge
    // scenarios ("what if they knew?") for the Privacy Audit's adversary view.
    // Delta declaration — all other tables inherit unchanged from v38.
    this.version(39).stores({
      adversaryScenarios: '++id, name, counterpartyName, createdAt',
    });

    // v38: savedPsbts outputs may now carry a zero-value OP_RETURN data output
    // (payload hex + evidence reference for on-chain notarization). The field
    // is non-indexed, so the index declaration is unchanged — the bump records
    // the shape change so upgrades from any earlier version stay explicit.
    // Delta declaration — all other tables inherit unchanged from v37.
    this.version(38).stores({
      savedPsbts: '++id, createdAt, name',
    });

    // v37: add the savedPsbts table — unsigned PSBTs built from selected
    // UTXOs, stored with their decoded components so they can be revisited,
    // renamed, re-downloaded, or deleted. Delta declaration — all other
    // tables inherit unchanged from v36.
    this.version(37).stores({
      savedPsbts: '++id, createdAt, name',
    });

    // v36: index `identifier` on attachments. The detail panel loads
    // attachments by recordId OR identifier, and Dexie's .or() requires an
    // index — without it every panel open threw a SchemaError and silently
    // fell back to an empty attachment list. Delta declaration — all other
    // tables inherit unchanged from v35.
    this.version(36).stores({
      attachments: '++id, recordId, createdAt, identifier',
    });

    // v35: add the dustFlags table — user-flagged dust outputs keyed by unique
    // outpoint ("txid:vout"). Delta declaration — all other tables inherit
    // unchanged from v34.
    this.version(35).stores({
      dustFlags: '++id, &outpoint, txid, address, markedAt',
    });

    // v34: add the privacyAuditHistory table for the Privacy History timeline.
    // Each completed audit appends a snapshot (score, grade, finding counts).
    // Delta declaration — all other tables inherit unchanged from v33.
    this.version(34).stores({
      privacyAuditHistory: '++id, timestamp',
    });

    // v33: wallet-fingerprinting fields on blockchainTransactions (nVersion,
    // nLockTime, hasRbf, isBip69Ordered, hasLowRSig, hasWitness,
    // rawFingerprintCaptured). Delta declaration — only the changed table
    // needs redeclaration; all others inherit unchanged from v32.
    // Existing rows without these fields will have rawFingerprintCaptured=undefined
    // (falsy), which the fingerprinting heuristics treat as "re-sync needed".
    this.version(33).stores({
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn, rawFingerprintCaptured',
    });

    // v32: add the recoverable attachment "trash" table. Deleting a record or
    // attachment no longer unlinks the file — it archives metadata here while the
    // file stays on disk. Delta declaration: all other tables inherit from v31.
    this.version(32).stores({
      trashedAttachments: '++id, recordId, objectStoragePath, deletedAt',
    });

    this.version(31).stores({
      records: '++id, type, inputString, inputStringLower, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, chainType, syncDepth, addressImportance, [type+addressImportance], [addressImportance+id], [type+id], [owner+id], [walletName+id], flowType, discoveredFromRecordId',
      attachments: '++id, recordId, createdAt',
      tags: '++id, name, createdAt',
      categories: '++id, name, createdAt',
      owners: '++id, name, createdAt',
      walletNames: '++id, name, createdAt',
      seedNames: '++id, name, createdAt',
      walletSoftware: '++id, name, createdAt',
      recordOrigins: '++id, recordId, originType, createdAt',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt',
      evidenceAttachments: '++id, evidenceId, createdAt',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt',
      partialExportBundles: '++id, &selectionKey, createdAt'
    });

    // Version 31 adds the optional address-metadata field: counterpartyName
    // No new indexes needed - it is free text stored on records and read by the
    // Acquisition & Provenance appendix.
    this.version(31).stores({
      records: '++id, type, inputString, inputStringLower, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, chainType, syncDepth, addressImportance, [type+addressImportance], [addressImportance+id], [type+id], [owner+id], [walletName+id], flowType, discoveredFromRecordId',
      attachments: '++id, recordId, createdAt',
      tags: '++id, name, createdAt',
      categories: '++id, name, createdAt',
      owners: '++id, name, createdAt',
      walletNames: '++id, name, createdAt',
      seedNames: '++id, name, createdAt',
      walletSoftware: '++id, name, createdAt',
      recordOrigins: '++id, recordId, originType, createdAt',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt',
      evidenceAttachments: '++id, evidenceId, createdAt',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt',
      partialExportBundles: '++id, &selectionKey, createdAt'
    });

    this.version(30).stores({
      records: '++id, type, inputString, inputStringLower, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, chainType, syncDepth, addressImportance, [type+addressImportance], [addressImportance+id], [type+id], [owner+id], [walletName+id], flowType, discoveredFromRecordId',
      attachments: '++id, recordId, createdAt',
      tags: '++id, name, createdAt',
      categories: '++id, name, createdAt',
      owners: '++id, name, createdAt',
      walletNames: '++id, name, createdAt',
      seedNames: '++id, name, createdAt',
      walletSoftware: '++id, name, createdAt',
      recordOrigins: '++id, recordId, originType, createdAt',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt',
      evidenceAttachments: '++id, evidenceId, createdAt',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    }).upgrade(async tx => {
      console.log('[v30 migration] Populating inputStringLower for indexed case-insensitive lookups...');
      let count = 0;
      let searchWalked = 0;
      reportDbUpgradeProgress({ version: 30, step: 'Indexing search field', rowsProcessed: 0 });
      await tx.table('records').toCollection().modify((record: globalThis.Record<string, unknown>) => {
        searchWalked++;
        if (searchWalked % 512 === 0) {
          reportDbUpgradeProgress({ version: 30, step: 'Indexing search field', rowsProcessed: searchWalked });
        }
        if (typeof record.inputString === 'string' && record.inputString) {
          record.inputStringLower = (record.inputString as string).toLowerCase();
          count++;
        }
      });
      console.log(`[v30 migration] Set inputStringLower on ${count} records`);
    });

    this.version(29).stores({
      records: '++id, type, inputString, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, chainType, syncDepth, addressImportance, [type+addressImportance], [addressImportance+id], [type+id], [owner+id], [walletName+id], flowType, discoveredFromRecordId',
      attachments: '++id, recordId, createdAt',
      tags: '++id, name, createdAt',
      categories: '++id, name, createdAt',
      owners: '++id, name, createdAt',
      walletNames: '++id, name, createdAt',
      seedNames: '++id, name, createdAt',
      walletSoftware: '++id, name, createdAt',
      recordOrigins: '++id, recordId, originType, createdAt',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt',
      evidenceAttachments: '++id, evidenceId, createdAt',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    }).upgrade(async tx => {
      console.log('[v29 migration] Cleaning up stale [encrypted] placeholder values...');
      const placeholder = '[encrypted]';

      const vocabTables = ['tags', 'categories', 'owners', 'walletNames', 'seedNames', 'walletSoftware'];
      reportDbUpgradeProgress({ version: 29, step: 'Cleaning up vocabulary', rowsProcessed: 0 });
      for (const tableName of vocabTables) {
        const idsToDelete: number[] = [];
        await tx.table(tableName).each((item: { id?: number; name: string }) => {
          if (item.name && item.name.includes(placeholder) && item.id) {
            idsToDelete.push(item.id);
          }
        });
        if (idsToDelete.length > 0) {
          await tx.table(tableName).bulkDelete(idsToDelete);
          console.log(`[v29 migration] Removed ${idsToDelete.length} entries from ${tableName}`);
        }
      }

      const fieldsToClean = ['label', 'notes', 'owner', 'walletName', 'seedName', 'walletSoftware', 'source', 'privateKeyStatus'];
      let cleanedRecords = 0;
      let cleanWalked = 0;
      reportDbUpgradeProgress({ version: 29, step: 'Cleaning record fields', rowsProcessed: 0 });
      await tx.table('records').toCollection().modify((record: globalThis.Record<string, unknown>) => {
        cleanWalked++;
        if (cleanWalked % 512 === 0) {
          reportDbUpgradeProgress({ version: 29, step: 'Cleaning record fields', rowsProcessed: cleanWalked });
        }
        let modified = false;
        for (const field of fieldsToClean) {
          if (typeof record[field] === 'string' && (record[field] as string).includes(placeholder)) {
            record[field] = '';
            modified = true;
          }
        }
        if (Array.isArray(record.tags)) {
          const cleaned = (record.tags as string[]).filter(t => !t.includes(placeholder));
          if (cleaned.length !== (record.tags as string[]).length) {
            record.tags = cleaned;
            modified = true;
          }
        }
        if (Array.isArray(record.categories)) {
          const cleaned = (record.categories as string[]).filter(c => !c.includes(placeholder));
          if (cleaned.length !== (record.categories as string[]).length) {
            record.categories = cleaned;
            modified = true;
          }
        }
        if (modified) cleanedRecords++;
      });
      if (cleanedRecords > 0) {
        console.log(`[v29 migration] Cleaned values from ${cleanedRecords} records`);
      }

      const validTiers = new Set([
        'verified', 'manual', 'wallet-import', 'xpub-derived',
        'blockchain-discovered', 'pending-review'
      ]);
      let normalizedCount = 0;
      let tierWalked = 0;
      reportDbUpgradeProgress({ version: 29, step: 'Normalizing address tiers', rowsProcessed: 0 });
      await tx.table('records').toCollection().modify((record: globalThis.Record<string, unknown>) => {
        tierWalked++;
        if (tierWalked % 512 === 0) {
          reportDbUpgradeProgress({ version: 29, step: 'Normalizing address tiers', rowsProcessed: tierWalked });
        }
        if (!record.addressImportance || !validTiers.has(record.addressImportance as string)) {
          record.addressImportance = 'manual';
          normalizedCount++;
        }
      });
      if (normalizedCount > 0) {
        console.log(`[v29 migration] Normalized ${normalizedCount} records with missing/invalid addressImportance to 'manual'`);
      }

      console.log('[v29 migration] Complete');
    });

    this.version(28).stores({
      records: '++id, type, inputString, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, chainType, syncDepth, addressImportance, [type+addressImportance], flowType, discoveredFromRecordId',
      attachments: '++id, recordId, createdAt',
      tags: '++id, name, createdAt',
      categories: '++id, name, createdAt',
      owners: '++id, name, createdAt',
      walletNames: '++id, name, createdAt',
      seedNames: '++id, name, createdAt',
      walletSoftware: '++id, name, createdAt',
      recordOrigins: '++id, recordId, originType, createdAt',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt',
      evidenceAttachments: '++id, evidenceId, createdAt',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    }).upgrade(async () => {
    });

    // Version 27 removes field-level encryption (isEncrypted/encryptedPayload stripped from all tables)
    // Users needing data-at-rest protection should use encrypted containers (VeraCrypt, BitLocker, FileVault, LUKS)
    this.version(27).stores({
      records: '++id, type, inputString, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, chainType, syncDepth, addressImportance, [type+addressImportance], flowType, discoveredFromRecordId',
      attachments: '++id, recordId, createdAt',
      tags: '++id, name, createdAt',
      categories: '++id, name, createdAt',
      owners: '++id, name, createdAt',
      walletNames: '++id, name, createdAt',
      seedNames: '++id, name, createdAt',
      walletSoftware: '++id, name, createdAt',
      recordOrigins: '++id, recordId, originType, createdAt',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt, hasOpReturn',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt',
      evidenceAttachments: '++id, evidenceId, createdAt',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    }).upgrade(async tx => {
      const tablesToClean = [
        'records', 'attachments', 'tags', 'categories', 'owners', 'walletNames',
        'seedNames', 'walletSoftware', 'recordOrigins', 'transactionParticipants',
        'derivationTemplates', 'utxoLineage', 'custodySegments', 'lineageSnapshots',
        'evidence', 'evidenceAttachments',
      ];
      let totalEncrypted = 0;
      for (const tableName of tablesToClean) {
        let tableEncrypted = 0;
        console.log(`[v27 migration] Scanning ${tableName}...`);
        let tableFlaggedNoPayload = 0;
        let walked = 0;
        reportDbUpgradeProgress({ version: 27, step: `Updating ${tableName}`, rowsProcessed: 0 });
        await tx.table(tableName).toCollection().modify((item: globalThis.Record<string, unknown>) => {
          walked++;
          if (walked % 512 === 0) {
            reportDbUpgradeProgress({ version: 27, step: `Updating ${tableName}`, rowsProcessed: walked });
          }
          if (item.isEncrypted !== true) return;
          if (item.encryptedPayload) {
            tableEncrypted++;
            item._legacyEncryptedPayload = item.encryptedPayload;
          } else {
            tableFlaggedNoPayload++;
          }
          delete item.isEncrypted;
          delete item.encryptedPayload;
        });
        if (tableEncrypted > 0) {
          totalEncrypted += tableEncrypted;
          console.warn(`[v27 migration] ${tableName}: ${tableEncrypted} encrypted records preserved in _legacyEncryptedPayload`);
        }
        if (tableFlaggedNoPayload > 0) {
          console.warn(`[v27 migration] ${tableName}: ${tableFlaggedNoPayload} records flagged encrypted but had no payload (cleaned)`);
        }
        if (tableEncrypted === 0 && tableFlaggedNoPayload === 0) {
          console.log(`[v27 migration] ${tableName}: no encrypted records`);
        }
      }
      if (totalEncrypted > 0) {
        console.warn(`[v27 migration] Total: ${totalEncrypted} encrypted records found. To recover: restore from backup with the previous app version, unlock the vault to decrypt, then upgrade.`);
      } else {
        console.log('[v27 migration] Complete: no encrypted records found in any table');
      }
    });

    // Version 26 restores address and [prevTxid+prevVout] indexes on transactionParticipants
    this.version(26).stores({
      records: '++id, type, inputString, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType, discoveredFromRecordId',
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
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout], isEncrypted',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    });

    // Version 24 adds isEncrypted to transactionParticipants for encrypted participant data
    this.version(25).stores({
      records: '++id, type, inputString, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType, discoveredFromRecordId',
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
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    });

    this.version(24).stores({
      records: '++id, type, inputString, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, [prevTxid+prevVout], isEncrypted',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    });

    // Version 23 adds walletName, seedName, walletSoftware indexes on records for efficient vocabulary usage counts
    this.version(23).stores({
      records: '++id, type, inputString, label, owner, walletName, seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, scriptType, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    });

    // Version 22 adds skippedAddresses and addressBlacklist tables for sync protection
    this.version(22).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, scriptType, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted',
      pausedSyncState: 'id',
      skippedAddresses: '++id, address, reason, syncRunTimestamp, dismissed, createdAt',
      addressBlacklist: '++id, &address, addedAt'
    });

    // Version 21 adds pausedSyncState table for pause/resume sync functionality
    this.version(21).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, scriptType, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted',
      pausedSyncState: 'id'
    });
    
    // Version 20 adds prevTxid/prevVout to transactionParticipants for exact UTXO matching
    // - transactionParticipants: adds prevTxid, prevVout for inputs to enable outpoint-based UTXO tracking
    // - New compound index [prevTxid+prevVout] enables fast lookup of spent outputs
    this.version(20).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, scriptType, [prevTxid+prevVout]',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted'
    });
    
    // Version 19 adds OP_RETURN detection and transaction size/weight data
    // - blockchainTransactions: adds hasOpReturn, opReturnData, size, weight, vsize
    // - transactionParticipants: adds scriptType for address type analysis
    this.version(19).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId, scriptType',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted'
    }).upgrade(async tx => {
      console.log('[v19 migration] Adding OP_RETURN and size defaults to blockchainTransactions...');
      await tx.table('blockchainTransactions').toCollection().modify(record => {
        if (record.hasOpReturn === undefined) {
          record.hasOpReturn = false;
          record.opReturnData = [];
        }
        if (record.size === undefined) record.size = 0;
        if (record.weight === undefined) record.weight = 0;
        if (record.vsize === undefined) {
          record.vsize = record.weight > 0 ? Math.ceil(record.weight / 4) : record.size;
        }
      });
      console.log('[v19 migration] Adding scriptType defaults to transactionParticipants...');
      await tx.table('transactionParticipants').toCollection().modify(record => {
        if (record.scriptType === undefined) {
          record.scriptType = 'unknown';
        }
      });
      console.log('[v19 migration] Complete');
    });
    
    // Version 18 adds Evidence and EvidenceAttachment tables for general document storage
    // - evidence: stores general documents, emails, screenshots, receipts not tied to specific addresses/txids
    // - evidenceAttachments: file attachments linked to evidence entries
    this.version(18).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted',
      // New evidence tables
      evidence: '++id, documentType, originalDate, *tags, importance, createdAt, updatedAt, isEncrypted',
      evidenceAttachments: '++id, evidenceId, createdAt, isEncrypted'
    });
    
    // Version 17 adds UTXO lineage tracking tables for AML/SOF origin tracking
    // - utxoLineage: tracks individual UTXO→UTXO relationships
    // - custodySegments: ownership periods for coin bundles  
    // - lineageSnapshots: pre-computed proofs for selective disclosure export
    this.version(17).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted',
      // New lineage tracking tables
      utxoLineage: '++id, [spentTxid+spentVout], [createdTxid+createdVout], consumingTxid, spentAddress, createdAddress, segmentId, spentOwned, createdOwned, isChange, blockTime, isEncrypted',
      custodySegments: '++id, &segmentId, [originTxid+originVout], originAddress, currentAddress, status, parentSegmentId, owner, walletName, originDate, isEncrypted',
      lineageSnapshots: '++id, &snapshotId, targetType, targetAddress, targetSegmentId, generatedAt, disclosureLevel, isEncrypted'
    });
    
    // Version 16 adds compound index [txid+role] on transactionParticipants for efficient queries
    this.version(16).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, [txid+role], txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted'
    });
    
    // Version 15 adds transaction/address metadata fields: flowType, acquisitionMethod, 
    // dispositionType, costBasisUsd, counterpartyType
    // No new indexes needed - these are optional metadata fields stored on records
    this.version(15).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance], flowType',
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
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted'
    });
    
    // Version 14 adds compound index [type+addressImportance] for efficient filtering
    // Also backfills addressImportance for all legacy records
    this.version(14).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance, [type+addressImportance]',
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
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted'
    }).upgrade(async tx => {
      // Migration: Backfill addressImportance for ALL records
      // This enables fully indexed queries using compound index [type+addressImportance]
      // Every record MUST have addressImportance set after this migration
      return tx.table('records').toCollection().modify(record => {
        // Skip records that already have a valid addressImportance set
        if (record.addressImportance && 
            ['verified', 'manual', 'wallet-import', 'xpub-derived', 'blockchain-discovered', 'pending-review'].includes(record.addressImportance)) {
          return;
        }
        
        // Transaction and 'other' type records don't use addressImportance in filtering
        // but we still assign 'manual' for compound index compatibility
        if (record.type === 'transaction' || record.type === 'other') {
          record.addressImportance = 'manual';
          return;
        }
        
        // For address records, infer importance based on provenance heuristics
        // Priority order: syncDepth > source field > xpub/derivationPath > default
        
        // 1. Blockchain-discovered: has syncDepth > 0 or source indicates blockchain sync
        if ((record.syncDepth !== undefined && record.syncDepth > 0) || 
            record.source === 'blockchain-sync') {
          record.addressImportance = 'blockchain-discovered';
          return;
        }
        
        // 2. Wallet-import: source starts with 'walletImport-'
        if (record.source?.startsWith('walletImport-')) {
          record.addressImportance = 'wallet-import';
          return;
        }
        
        // 3. XPUB-derived: has xpub, derivationPath, or source is 'xpub-import'
        if (record.source === 'xpub-import' || record.xpub || record.derivationPath) {
          record.addressImportance = 'xpub-derived';
          return;
        }
        
        // 4. Default: all other records are treated as manually entered
        // This ensures NO record has undefined addressImportance after migration
        record.addressImportance = 'manual';
      });
    });
    
    // Version 13 adds derivationTemplates table for optional encrypted xpub storage
    this.version(13).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance',
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
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id',
      derivationTemplates: '++id, fingerprint, scriptType, owner, walletName, seedName, createdAt, isEncrypted'
    });
    
    // Version 12 adds nodeSettings table for blockchain API connection configuration
    this.version(12).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance',
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
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt',
      nodeSettings: 'id'
    });
    
    // Version 11 adds vocabulary tables for owners, walletNames, seedNames, walletSoftware
    this.version(11).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance',
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
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt'
    });
    
    // Version 10 adds addressImportance field for filtering provenance views
    // Auto-assigns importance tier based on existing source/syncDepth patterns
    this.version(10).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth, addressImportance',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      recordOrigins: '++id, recordId, originType, createdAt, isEncrypted',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt'
    }).upgrade(tx => {
      return tx.table('records').toCollection().modify((record: any) => {
        // Auto-assign addressImportance based on existing patterns
        // Priority: pending-review > blockchain-discovered > xpub > wallet > manual
        if (record.owner === 'Pending Review') {
          record.addressImportance = 'pending-review';
        } else if (
          record.source === 'blockchain-sync' || 
          record.source === 'blockchain' ||
          (record.syncDepth !== undefined && record.syncDepth > 0) ||
          record.discoveredFromRecordId !== undefined
        ) {
          // Blockchain-discovered: has blockchain source, syncDepth > 0, or has parent record
          record.addressImportance = 'blockchain-discovered';
        } else if (record.source === 'xpub-import' || record.xpub || record.derivationPath) {
          // XPUB-derived: has xpub source, xpub key, or derivation path
          record.addressImportance = 'xpub-derived';
        } else if (record.source === 'wallet-import') {
          record.addressImportance = 'wallet-import';
        } else if (record.source === 'manual' || !record.source) {
          // Manual: explicit manual source or no source (default for old records)
          record.addressImportance = 'manual';
        } else {
          // Fallback for any unknown source
          record.addressImportance = 'manual';
        }
      });
    });
    
    // Version 9 fixes maxSyncedDepth initialization
    // Version 8 incorrectly set maxSyncedDepth=0 for all records, but it should be -1
    // (meaning "not yet synced") so that depth 0 sync will properly include them
    this.version(9).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      recordOrigins: '++id, recordId, originType, createdAt, isEncrypted',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt'
    }).upgrade(async (tx) => {
      // Fix: Reset maxSyncedDepth to -1 for records that haven't actually been synced
      // Only reset records that don't have corresponding addressSyncState entries
      const syncedAddresses = new Set<string>();
      
      // First, get all addresses that have actually been synced
      await tx.table('addressSyncState').each((state: any) => {
        syncedAddresses.add(state.address);
      });
      
      // Now modify records - only reset if the address isn't in our synced set
      return tx.table('records').toCollection().modify((record: any) => {
        if (record.type !== 'address') return;
        
        // If this address was actually synced (has addressSyncState entry), don't reset
        if (record.inputString && syncedAddresses.has(record.inputString)) {
          // Keep existing maxSyncedDepth for synced records
          return;
        }
        
        // For unsynced records with maxSyncedDepth = 0 or undefined, reset to -1
        if (record.maxSyncedDepth === 0 || record.maxSyncedDepth === undefined) {
          record.maxSyncedDepth = -1;
        }
      });
    });
    
    // Version 8 adds syncDepth tracking for depth-limited blockchain sync
    this.version(8).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType, syncDepth',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      recordOrigins: '++id, recordId, originType, createdAt, isEncrypted',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt'
    }).upgrade(tx => {
      // Migration: set syncDepth=0 for existing manually-entered addresses
      // and syncDepth=1 for existing blockchain-sync discovered addresses
      return tx.table('records').toCollection().modify(record => {
        if (record.source === 'blockchain-sync') {
          record.syncDepth = 1;
          record.maxSyncedDepth = -1; // Not yet synced (fixed from 0)
        } else {
          record.syncDepth = 0; // Manual/imported = depth 0
          record.maxSyncedDepth = -1; // Not yet synced (fixed from 0)
        }
      });
    });
    
    // Version 7 adds blockchain transaction tables for Phase 2
    this.version(7).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      recordOrigins: '++id, recordId, originType, createdAt, isEncrypted',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt',
      blockchainTransactions: '++id, &txid, blockHeight, blockTime, syncedAt',
      transactionParticipants: '++id, txid, role, address, recordId',
      addressSyncState: '++id, &address, recordId, lastSyncedAt'
    }).upgrade(tx => {
      // No data migration needed - new tables are empty
      return Promise.resolve();
    });
    
    // Version 6 adds priceData table for historical price data
    this.version(6).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      recordOrigins: '++id, recordId, originType, createdAt, isEncrypted',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id',
      priceData: '++id, [date+currency+asset], date, asset, currency, source, importedAt'
    });
    
    // Version 5 adds customFields table for user-defined fields
    this.version(5).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      recordOrigins: '++id, recordId, originType, createdAt, isEncrypted',
      customFields: '++id, slug, enabled, createdAt',
      settings: 'id'
    });
    
    // Version 4 adds recordOrigins table for tracking metadata sources
    // Note: Unique constraint on inputString is NOT enforced at DB level because
    // existing databases may have duplicates. Duplicate detection is handled at
    // the application level in RecordFormDialog and BulkImport.
    this.version(4).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      recordOrigins: '++id, recordId, originType, createdAt, isEncrypted',
      settings: 'id'
    });
    
    // Version 3 adds chainType, derivationPath, xpub fields for bulk import
    this.version(3).stores({
      records: '++id, type, inputString, label, owner, *tags, *categories, createdAt, updatedAt, isEncrypted, chainType',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      settings: 'id'
    });

    // Version 2 adds encryption support
    this.version(2).stores({
      records: '++id, type, inputString, label, *tags, *categories, createdAt, updatedAt, isEncrypted',
      attachments: '++id, recordId, createdAt, isEncrypted',
      tags: '++id, name, createdAt, isEncrypted',
      categories: '++id, name, createdAt, isEncrypted',
      settings: 'id'
    }).upgrade(tx => {
      // Migration: add isEncrypted flag to existing records
      return tx.table('records').toCollection().modify(record => {
        record.isEncrypted = false;
      });
    });

    // Keep version 1 for compatibility
    this.version(1).stores({
      records: '++id, type, inputString, label, *tags, *categories, createdAt, updatedAt',
      attachments: '++id, recordId, createdAt',
      tags: '++id, name, createdAt',
      categories: '++id, name, createdAt',
      settings: 'id'
    });
  }
}

export const db = new KYUTXODatabase();

// Initialize default settings
db.on('ready', async () => {
  const settings = await db.settings.get('default');
  if (!settings) {
    await db.settings.add(createDefaultSettings('default'));
  } else {
    // Migrations for existing settings
    const updates: Partial<Settings> = {};
    let needsFieldVisibilityUpdate = false;
    let needsTableColumnsUpdate = false;
    
    // Migrate counterparty to owner if needed
    const fieldVis = settings.fieldVisibility as { counterparty?: boolean; owner?: boolean; walletName?: boolean; [key: string]: boolean | undefined };
    if (fieldVis.counterparty !== undefined && fieldVis.owner === undefined) {
      needsFieldVisibilityUpdate = true;
    }
    if (fieldVis.owner === undefined || fieldVis.walletName === undefined) {
      needsFieldVisibilityUpdate = true;
    }
    
    if (needsFieldVisibilityUpdate) {
      updates.fieldVisibility = {
        seedName: settings.fieldVisibility.seedName ?? true,
        walletSoftware: settings.fieldVisibility.walletSoftware ?? true,
        privateKeyStatus: settings.fieldVisibility.privateKeyStatus ?? false,
        owner: fieldVis.owner ?? fieldVis.counterparty ?? true,
        walletName: fieldVis.walletName ?? true,
        source: settings.fieldVisibility.source ?? true,
      };
    }
    
    if (!settings.tableColumns) {
      needsTableColumnsUpdate = true;
      updates.tableColumns = {
        tags: true,
        categories: false,
        walletSoftware: false,
        seedName: false,
        privateKeyStatus: false,
        hasAttachments: true,
        owner: false,
        walletName: false,
        source: false,
        firstSeen: true,
        balance: false,
        lastTxDate: false,
        txCount: false,
      };
    } else {
      const tableCols = settings.tableColumns as { owner?: boolean; walletName?: boolean; firstSeen?: boolean; [key: string]: boolean | undefined };
      if (tableCols.owner === undefined || tableCols.walletName === undefined || tableCols.firstSeen === undefined) {
        needsTableColumnsUpdate = true;
        updates.tableColumns = {
          ...settings.tableColumns,
          owner: tableCols.owner ?? false,
          walletName: tableCols.walletName ?? false,
          source: settings.tableColumns.source ?? false,
          firstSeen: tableCols.firstSeen ?? true,
        };
      }
    }
    
    if (!settings.customFieldColumns) {
      updates.customFieldColumns = {};
    }

    if ((settings as any).cancelConfirmThreshold === undefined) {
      updates.cancelConfirmThreshold = 75;
    }

    if ((settings as any).privacyHistoryLimit === undefined) {
      updates.privacyHistoryLimit = 30;
    }

    if ((settings as any).fundTrailTxLimit === undefined) {
      updates.fundTrailTxLimit = 2000;
    }
    
    if (Object.keys(updates).length > 0) {
      await db.settings.update('default', updates);
    }
  }
  
});

// Simple database change notification system
// Components can subscribe to be notified when data changes
export type DbChangeOrigin = 'blockchain-sync' | 'user' | string;
export interface DbChangeMeta {
  origin?: DbChangeOrigin;
}
type ChangeListener = (tables: string[], meta?: DbChangeMeta) => void;
const changeListeners: Set<ChangeListener> = new Set();
let bulkOperationDepth = 0;
let pendingBulkTables = new Set<string>();
let pendingBulkOrigins = new Set<DbChangeOrigin>();
let pendingBulkHasUntagged = false;

export function subscribeToDbChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function notifyDbChange(tables: string | string[], meta?: DbChangeMeta): void {
  const tableArray = Array.isArray(tables) ? tables : [tables];
  if (bulkOperationDepth > 0) {
    tableArray.forEach(t => pendingBulkTables.add(t));
    if (meta?.origin) {
      pendingBulkOrigins.add(meta.origin);
    } else {
      // Track untagged notifications so a mixed batch (some tagged, some not)
      // is treated as mixed and emits no origin to subscribers.
      pendingBulkHasUntagged = true;
    }
    return;
  }
  changeListeners.forEach(listener => {
    try {
      listener(tableArray, meta);
    } catch (e) {
      console.error('Error in database change listener:', e);
    }
  });
}

export function beginBulkOperation(): void {
  bulkOperationDepth++;
}

export function endBulkOperation(): void {
  bulkOperationDepth--;
  if (bulkOperationDepth < 0) {
    console.warn('endBulkOperation called without matching beginBulkOperation');
    bulkOperationDepth = 0;
  }
  if (bulkOperationDepth <= 0) {
    bulkOperationDepth = 0;
    if (pendingBulkTables.size > 0) {
      const tables = Array.from(pendingBulkTables);
      pendingBulkTables = new Set();
      // Only forward an origin if every deferred notification in the batch
      // carried the same origin. Any untagged notification, or a mix of
      // distinct origins, is treated as mixed and drops the origin so
      // subscribers fall back to the safe default of reloading.
      const origins = Array.from(pendingBulkOrigins);
      const hadUntagged = pendingBulkHasUntagged;
      pendingBulkOrigins = new Set();
      pendingBulkHasUntagged = false;
      const meta: DbChangeMeta | undefined =
        origins.length === 1 && !hadUntagged ? { origin: origins[0] } : undefined;
      changeListeners.forEach(listener => {
        try {
          listener(tables, meta);
        } catch (e) {
          console.error('Error in database change listener:', e);
        }
      });
    } else {
      pendingBulkOrigins = new Set();
      pendingBulkHasUntagged = false;
    }
  }
}
