import Dexie, { type Table } from 'dexie';

// Re-export all types and constants from db-types
export * from './db-types';

// Import types needed for the class definition
import type {
  Record, Attachment, Tag, Category, Owner, WalletName, SeedName, WalletSoftware,
  RecordOrigin, CustomField, Settings, PriceData, BlockchainTransaction,
  TransactionParticipant, AddressSyncState, NodeSettings, DerivationTemplate,
  UtxoLineage, CustodySegment, LineageSnapshot, Evidence, EvidenceAttachment,
  PausedSyncState,
} from './db-types';

export class KYUTXODatabase extends Dexie {
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
  blockchainTransactions!: Table<BlockchainTransaction>;
  transactionParticipants!: Table<TransactionParticipant>;
  addressSyncState!: Table<AddressSyncState>;
  nodeSettings!: Table<NodeSettings>;
  derivationTemplates!: Table<DerivationTemplate>;
  // Lineage tracking tables for AML/SOF
  utxoLineage!: Table<UtxoLineage>;
  custodySegments!: Table<CustodySegment>;
  lineageSnapshots!: Table<LineageSnapshot>;
  // Evidence/document storage tables
  evidence!: Table<Evidence>;
  evidenceAttachments!: Table<EvidenceAttachment>;
  // Paused sync state for resume functionality
  pausedSyncState!: Table<PausedSyncState>;

  constructor() {
    super('KYUTXODatabase');
    
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
      // Set defaults on existing blockchain transactions for the new index
      // hasOpReturn defaults to false for existing records (requires resync to detect OP_RETURN)
      await tx.table('blockchainTransactions').toCollection().modify(record => {
        if (record.hasOpReturn === undefined) {
          record.hasOpReturn = false;
          record.opReturnData = [];
        }
        if (record.size === undefined) record.size = 0;
        if (record.weight === undefined) record.weight = 0;
        if (record.vsize === undefined) {
          // Compute vsize from weight if available, otherwise use size
          record.vsize = record.weight > 0 ? Math.ceil(record.weight / 4) : record.size;
        }
      });
      // Set scriptType default on existing transaction participants
      await tx.table('transactionParticipants').toCollection().modify(record => {
        if (record.scriptType === undefined) {
          record.scriptType = 'unknown';
        }
      });
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
    await db.settings.add({
      id: 'default',
      fieldVisibility: {
        seedName: true,
        walletSoftware: true,
        privateKeyStatus: false,
        owner: true,
        walletName: true,
        source: true,
      },
      tableColumns: {
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
      },
      customFieldColumns: {},
      theme: 'light',
      defaultView: 'table',
    });
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
    
    if (Object.keys(updates).length > 0) {
      await db.settings.update('default', updates);
    }
  }
  
});

// Simple database change notification system
// Components can subscribe to be notified when data changes
type ChangeListener = (tables: string[]) => void;
const changeListeners: Set<ChangeListener> = new Set();

export function subscribeToDbChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function notifyDbChange(tables: string | string[]): void {
  const tableArray = Array.isArray(tables) ? tables : [tables];
  changeListeners.forEach(listener => {
    try {
      listener(tableArray);
    } catch (e) {
      console.error('Error in database change listener:', e);
    }
  });
}
