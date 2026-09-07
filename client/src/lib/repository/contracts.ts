import type {
  Record, Attachment, Tag, Category, Owner, OwnerResidency, WalletName, SeedName, WalletSoftware,
  RecordOrigin, CustomField, Settings, PriceData, BlockchainTransaction,
  TransactionParticipant, AddressSyncState, NodeSettings, DerivationTemplate,
  UtxoLineage, CustodySegment, LineageSnapshot, Evidence, EvidenceAttachment,
  PausedSyncState, SkippedAddress, AddressBlacklist, PartialExportBundle,
  TrashedAttachment, PrivacyAuditHistoryEntry, DustFlag, SavedPsbt,
  AdversaryScenario, NetworkPrivacyActivityEntry,
  RecordEntity, RecordWallet, AddressOwnership, TransactionMetadata,
  TransactionLegMetadata, RecordModelMigrationState, OwnershipReviewDecision,
} from '../db-types';
import type { OwnerCostBasisPage, OwnerCostBatch } from '../owner-cost-basis-core';

/**
 * The application-facing storage vocabulary.  It deliberately describes
 * operations, rather than exposing an IndexedDB/Dexie collection object.
 * Adding a query here is a reviewable storage API change for both backends.
 */
export interface VaultRows {
  records: Record;
  attachments: Attachment;
  tags: Tag;
  categories: Category;
  owners: Owner;
  ownerResidencies: OwnerResidency;
  walletNames: WalletName;
  seedNames: SeedName;
  walletSoftware: WalletSoftware;
  recordOrigins: RecordOrigin;
  customFields: CustomField;
  settings: Settings;
  priceData: PriceData;
  blockchainTransactions: BlockchainTransaction;
  transactionParticipants: TransactionParticipant;
  addressSyncState: AddressSyncState;
  nodeSettings: NodeSettings;
  derivationTemplates: DerivationTemplate;
  utxoLineage: UtxoLineage;
  custodySegments: CustodySegment;
  lineageSnapshots: LineageSnapshot;
  evidence: Evidence;
  evidenceAttachments: EvidenceAttachment;
  pausedSyncState: PausedSyncState;
  skippedAddresses: SkippedAddress;
  addressBlacklist: AddressBlacklist;
  partialExportBundles: PartialExportBundle;
  trashedAttachments: TrashedAttachment;
  privacyAuditHistory: PrivacyAuditHistoryEntry;
  dustFlags: DustFlag;
  savedPsbts: SavedPsbt;
  adversaryScenarios: AdversaryScenario;
  networkPrivacyActivity: NetworkPrivacyActivityEntry;
  entities: RecordEntity;
  wallets: RecordWallet;
  addressOwnership: AddressOwnership;
  transactionMetadata: TransactionMetadata;
  transactionLegMetadata: TransactionLegMetadata;
  recordModelMigrationState: RecordModelMigrationState;
  ownershipReviewDecisions: OwnershipReviewDecision;
}

export type VaultTableName = keyof VaultRows;
export type VaultKey = string | number;

export interface VaultPage<Row> {
  rows: Row[];
  /** Opaque to callers; pass unchanged to the next page request. */
  cursor?: VaultKey;
}

export interface VaultListOptions {
  cursor?: VaultKey;
  /** Backends may reject unbounded or excessively large pages. */
  limit: number;
  direction?: 'asc' | 'desc';
}

/** Fixed native query DTOs.  These are intentionally not column/operator DTOs. */
export type RecordsQuery =
  | { name: 'records.byInputStringLower'; value: string; limit?: number }
  | { name: 'records.byRecordType'; value: string; limit?: number }
  | { name: 'records.byRecordId'; value: VaultKey; limit?: number }
  /**
   * Bounded Records-list query. This is purpose-built vocabulary, rather than
   * a serialized Dexie chain or a renderer supplied SQL expression.
   */
  | {
      name: 'records.filtered';
      value: {
        search?: string;
        filters: Array<{ field: string; operator: string; value: string }>;
        includeBlockchainDiscovered: boolean;
        visibleTiers?: string[];
        beforeId?: number;
        addedSince?: number;
        requireCreatedAt?: boolean;
        order?: 'id-desc' | 'created-asc' | 'created-desc';
      };
      limit: number;
    };
export type TransactionsQuery = { name: 'transactions.byTransactionId'; value: string; limit?: number };
export type SyncQuery = { name: 'sync.byAddress'; value: string; limit?: number };
export type LineageQuery =
  | { name: 'lineage.bySpentOutpoint' | 'lineage.byCreatedOutpoint'; txid: string; vout: number }
  | { name: 'lineage.bySpentAddress' | 'lineage.byCreatedAddress'; value: string; limit?: number }
  | { name: 'lineage.bySegmentId' | 'lineage.bySnapshotId'; value: string; limit?: number };
export type EvidenceQuery =
  | { name: 'attachments.byRecordId' | 'attachments.byIdentifier'; value: string | number; limit?: number }
  | { name: 'evidenceAttachments.byEvidenceId'; value: number; limit?: number };
export type PrivacyQuery = never;
export type VaultSettingsQuery = never;

export type NativeBatchOperation<Row> =
  | { operation: 'save'; row: Row }
  | { operation: 'remove'; id: VaultKey };

/**
 * Domain command groups are the IPC vocabulary. Query DTOs remain finite and
 * named so neither renderer can construct a Dexie chain or arbitrary SQL.
 */
export interface VaultCommandGroups {
  records: { query(query: RecordsQuery): Promise<Record[]> };
  transactions: { query(query: TransactionsQuery): Promise<BlockchainTransaction[]> };
  sync: { query(query: SyncQuery): Promise<AddressSyncState[] | SkippedAddress[] | AddressBlacklist[]> };
  lineage: { query(query: LineageQuery): Promise<never[]> };
  evidence: { query(query: EvidenceQuery): Promise<never[]> };
  privacy: { query(query: PrivacyQuery): Promise<never[]> };
  vault: { query(query: VaultSettingsQuery): Promise<never[]> };
}

export interface VaultRepository {
  readonly kind: 'dexie' | 'protected';
  get<T extends VaultTableName>(table: T, key: VaultKey): Promise<VaultRows[T] | undefined>;
  put<T extends VaultTableName>(table: T, row: VaultRows[T], key?: VaultKey): Promise<VaultKey>;
  add<T extends VaultTableName>(table: T, row: VaultRows[T]): Promise<VaultKey>;
  /** Native batch save; never implemented as a renderer-side loop. */
  bulkPut<T extends VaultTableName>(table: T, rows: VaultRows[T][]): Promise<VaultKey[]>;
  update<T extends VaultTableName>(table: T, key: VaultKey, changes: Partial<VaultRows[T]>): Promise<boolean>;
  delete<T extends VaultTableName>(table: T, key: VaultKey): Promise<void>;
  bulkDelete<T extends VaultTableName>(table: T, keys: VaultKey[]): Promise<void>;
  clear<T extends VaultTableName>(table: T): Promise<void>;
  count<T extends VaultTableName>(table: T): Promise<number>;
  list<T extends VaultTableName>(table: T, options: VaultListOptions): Promise<VaultPage<VaultRows[T]>>;
  /** Named record lookup; never a renderer-provided query expression. */
  queryRecords(query: RecordsQuery): Promise<Record[]>;
  query<T>(table: VaultTableName, name: ProtectedRepositoryQueryName, value: unknown, limit?: number): Promise<T[]>;
  command<T>(name: ProtectedRepositoryCommandName, value: unknown): Promise<T>;
  /** Atomically persists one chain transaction and its participant rows. */
  saveTransactionWithParticipants(command: TransactionParticipantsCommit): Promise<{
    transactionId: VaultKey;
    participantIds: VaultKey[];
  }>;
  deleteOrArchiveRecords(command: RecordDeleteOrArchiveCommand): Promise<{
    deleted: number;
    archived: number;
  }>;
  saveSettingsWithHistory(command: SettingsHistoryCommit): Promise<{
    settingsId: VaultKey;
    historyId?: VaultKey;
    retainedHistory: number;
  }>;
  clearVault(): Promise<{ deleted: number }>;
  restoreCommit(command: RestoreVaultCommit): Promise<{ saved: number }>;
  /** A finite atomic command for confirmed ownership actions and their undo. */
  commitOwnershipReview(command: OwnershipReviewCommit): Promise<OwnershipReviewDecision>;
  /** Bounded owner-book projection; protected implementations calculate inside the encrypted worker. */
  ownerCostBasisPage(options: OwnerCostBasisPageRequest): Promise<OwnerCostBasisPage>;
  ownerCostBasisProjection(addresses: string[]): Promise<OwnerCostBasisProjectionResult>;
  /**
   * A transaction boundary, not a Dexie transaction object.  Protected
   * implementations must be native/atomic; they must never emulate Dexie's
   * fluent API in the renderer.
   */
  transaction<T>(tables: VaultTableName[], operation: () => Promise<T>): Promise<T>;
}

export interface OwnerCostBasisPageRequest {
  selectedOwner?: string;
  limit?: number;
  expectedCheckpointKey?: string;
}
export interface OwnerCostBasisProjectionResult {
  checkpointKey: string;
  declaredAddresses: string[];
  batches: Array<{ address: string; batch: OwnerCostBatch }>;
  perAddressLimit: number;
  globalLimit: number;
}

/**
 * Fixed collection queries implemented by the protected-store worker.  This is
 * deliberately a finite vocabulary rather than a renderer-side query builder.
 * The native worker must add a matching handler before a packaged caller can
 * use a newly declared name.
 */
export type ProtectedRepositoryQueryName =
  | 'records.byInputStringLower'
  | 'records.byRecordType'
  | 'records.byRecordId'
  | 'records.filtered'
  | 'records.byInputStringAndType'
  | 'records.byIds'
  | 'records.byInputStrings'
  | 'records.byTypeIdForwardKeyset'
  | 'records.byTypeIdReverseKeyset'
  | 'records.byTypeAndImportanceTiersKeyset'
  | 'records.countByType'
  | 'records.byDiscoveredFromRecordIds'
  | 'origins.byRecordIds'
  | 'transactions.byTransactionId'
  | 'transactions.byTxid'
  | 'transactions.byTxids'
  | 'transactions.byBlockTime'
  | 'transactions.byCurationState'
  | 'transactions.afterId'
  | 'participants.byTxid'
  | 'participants.byTxids'
  | 'participants.byTxidsAfterId'
  | 'participants.byAddress'
  | 'participants.byAddresses'
  | 'participants.byAddressesAfterId'
  | 'participants.byRecordId'
  | 'participants.byRecordIds'
  | 'participants.byPrevout'
  | 'participants.byPrevouts'
  | 'participants.byRole'
  | 'participants.afterId'
  | 'sync.byAddress'
  | 'sync.byLastSyncedAt'
  | 'sync.skippedByRun'
  | 'sync.activeSkipped'
  | 'sync.dismissAllSkipped'
  | 'sync.byAddresses'
  | 'sync.afterId'
  | 'price.byDateCurrencyAsset'
  | 'price.byDateCurrencyAssetKeys'
  | 'price.byAsset'
  | 'price.latestOnOrBefore'
  | 'savedPsbts.byCreatedAt'
  // Task 66 lineage/evidence/attachment renderer vocabulary. These require
  // matching native worker handlers before packaged callers can issue them.
  | 'lineage.bySpentOutpoint'
  | 'lineage.byCreatedOutpoint'
  | 'lineage.byCreatedOutpoints'
  | 'lineage.bySpentAddress'
  | 'lineage.byCreatedAddress'
  | 'lineage.bySegmentId'
  | 'lineage.bySnapshotId'
  | 'lineage.byOriginOutpoint'
  | 'lineage.byOriginAddress'
  | 'lineage.byCurrentAddress'
  | 'attachments.byRecordId'
  | 'attachments.byIdentifier'
  | 'evidenceAttachments.byEvidenceId';

/** Fixed cross-table mutations that must commit in the protected worker. */
export type ProtectedRepositoryCommandName =
  | 'cleanup.deleteRecordWithOrigins'
  | 'records.deleteOrArchive'
  | 'transactions.saveWithParticipants'
  | 'vault.saveSettingsWithHistory'
  | 'vault.clear'
  | 'vault.restoreCommit';

export interface CleanupDeleteRecordResult {
  deleted: boolean;
}

export interface RecordDeleteOrArchiveCommand {
  recordIds: number[];
  mode: 'delete' | 'archive';
  archivedAt?: number;
  archiveReason?: string;
}
export interface TransactionParticipantsCommit {
  transaction: BlockchainTransaction;
  participants: TransactionParticipant[];
  replaceParticipants?: boolean;
}
export interface SettingsHistoryCommit {
  settings: Settings;
  historyEntry?: PrivacyAuditHistoryEntry;
  retainHistory?: number;
}
export interface OwnershipReviewCommit {
  decision: OwnershipReviewDecision;
  ownershipRows: AddressOwnership[];
  /** Existing ownership primary keys to delete during undo. */
  deleteOwnershipIds?: number[];
}
export interface RestoreVaultCommit {
  replaceExisting: boolean;
  rows: Partial<{ [T in VaultTableName]: VaultRows[T][] }>;
}
