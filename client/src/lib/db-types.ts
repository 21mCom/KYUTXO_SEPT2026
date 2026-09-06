// Chain type for addresses derived from XPUB
export type ChainType = 'receive' | 'change';

// Address importance levels for filtering and prioritization
// Hierarchy: verified > manual > wallet-import > xpub-derived > blockchain-discovered > pending-review
export type AddressImportance = 
  | 'verified'              // User has manually verified/confirmed this address
  | 'manual'                // Manually entered address
  | 'wallet-import'         // Imported from wallet software  
  | 'xpub-derived'          // Derived from an xpub key
  | 'blockchain-discovered' // Auto-discovered from blockchain sync
  | 'pending-review';       // Awaiting user review

// The importance tiers that represent user-curated ("owned") addresses, i.e.
// addresses the user has explicitly added or verified rather than ones that were
// auto-discovered from the blockchain. Use this single source of truth instead of
// re-declaring the array on each page/hook so they never disagree about which
// addresses count as user-owned.
export const USER_CURATED_TIERS: AddressImportance[] = [
  'verified',
  'manual',
  'wallet-import',
  'xpub-derived',
];

/**
 * True when an address record counts as user-curated ("owned"). Records with no
 * importance tier (created before tiers existed) count as curated, matching the
 * UTXOs page's long-standing treatment of legacy rows. Blockchain-discovered and
 * pending-review records — auto-created during sync for counterparty addresses —
 * are NOT curated: their local history is one-sided, so any "balance" computed
 * for them is really just sats seen received, not funds the user controls.
 */
export function isUserCuratedImportance(importance: AddressImportance | undefined): boolean {
  return !importance || USER_CURATED_TIERS.includes(importance);
}

// The complete set of importance tiers, ordered from highest to lowest priority
// (matches the hierarchy documented on AddressImportance). Use this single source
// of truth instead of re-declaring the full six-element array on each
// page/component/engine so they never drift apart if the tier set changes.
export const ALL_IMPORTANCE_TIERS: AddressImportance[] = [
  'verified',
  'manual',
  'wallet-import',
  'xpub-derived',
  'blockchain-discovered',
  'pending-review',
];

// The tiers hidden by the Records page's default view (the "Show discovered"
// toggle off). Single source of truth for every surface that needs the
// exclusion semantics — browse, search, hidden-match counting, and repairs —
// so a new hidden tier can never be excluded in one path but leak in another.
export const HIDDEN_DISCOVERY_TIERS: AddressImportance[] = [
  'blockchain-discovered',
  'pending-review',
];

/**
 * True when `value` is one of the six recognized importance tiers. Rows can
 * carry unrecognized tier strings (restored from old backups written before
 * the tier vocabulary settled) or no tier at all (pre-tier legacy rows);
 * treat both as "not valid" so they can be normalized rather than silently
 * falling through index-based queries.
 */
export function isValidImportanceTier(value: unknown): value is AddressImportance {
  return typeof value === 'string' && (ALL_IMPORTANCE_TIERS as string[]).includes(value);
}

/**
 * Exclusion predicate matching the engine's SQL semantics
 * (`addressImportance IS NULL OR addressImportance NOT IN (hidden tiers)`):
 * a row is visible in the default Records view unless its tier is one of the
 * HIDDEN_DISCOVERY_TIERS. Missing and unrecognized tiers are visible.
 */
export function isHiddenDiscoveryTier(value: string | undefined | null): boolean {
  return value === 'blockchain-discovered' || value === 'pending-review';
}

// Canonical human-readable labels for each importance tier. This is the single
// source of truth for tier display names. Keeping it next to ALL_IMPORTANCE_TIERS
// (and typed as a full mapping over AddressImportance) means a newly added or
// renamed tier forces a label here too, so the per-page option arrays derived
// from it can never silently drift from the tier set.
export const IMPORTANCE_TIER_LABELS: { [K in AddressImportance]: string } = {
  'verified': 'Verified',
  'manual': 'Manual',
  'wallet-import': 'Wallet Import',
  'xpub-derived': 'XPUB Derived',
  'blockchain-discovered': 'Blockchain Discovered',
  'pending-review': 'Pending Review',
};

// Build a {value,label} option array covering every importance tier, in the
// canonical ALL_IMPORTANCE_TIERS order. Pass `overrides` to customize the
// display label for specific tiers on a given page without re-declaring the
// whole list (so the value set stays in sync with the tier set).
export function getImportanceTierOptions(
  overrides?: { [K in AddressImportance]?: string },
): { value: AddressImportance; label: string }[] {
  return ALL_IMPORTANCE_TIERS.map((value) => ({
    value,
    label: overrides?.[value] ?? IMPORTANCE_TIER_LABELS[value],
  }));
}

// Flow type for transactions - fundamental direction/purpose
export type FlowType = 
  | 'received'        // Incoming funds from external source
  | 'sent'            // Outgoing payment to external party
  | 'self-transfer'   // Between your own wallets
  | 'consolidation';  // Combining UTXOs for efficiency

export const FLOW_TYPE_OPTIONS: { value: FlowType; label: string }[] = [
  { value: 'received', label: 'Received' },
  { value: 'sent', label: 'Sent' },
  { value: 'self-transfer', label: 'Self-Transfer' },
  { value: 'consolidation', label: 'Consolidation' },
];

// Acquisition method for incoming transactions (received funds)
export type AcquisitionMethod = 
  | 'purchase'              // Bought with fiat or other crypto
  | 'mining'                // Mining reward
  | 'staking'               // Staking/interest reward
  | 'airdrop'               // Free distribution
  | 'fork'                  // From a chain fork
  | 'gift-received'         // Gift from someone
  | 'inheritance'           // Inherited
  | 'salary'                // Payment for employment
  | 'payment-for-services'  // Payment for freelance/business services
  | 'loan'                  // Borrowed funds (repayment expected)
  | 'unknown';              // Needs research

export const ACQUISITION_METHOD_OPTIONS: { value: AcquisitionMethod; label: string }[] = [
  { value: 'purchase', label: 'Purchase' },
  { value: 'mining', label: 'Mining' },
  { value: 'staking', label: 'Staking/Interest' },
  { value: 'airdrop', label: 'Airdrop' },
  { value: 'fork', label: 'Fork' },
  { value: 'gift-received', label: 'Gift Received' },
  { value: 'inheritance', label: 'Inheritance' },
  { value: 'salary', label: 'Salary' },
  { value: 'payment-for-services', label: 'Payment for Services' },
  { value: 'loan', label: 'Loan Received' },
  { value: 'unknown', label: 'Unknown' },
];

// Disposition type for outgoing transactions (sent funds)
export type DispositionType = 
  | 'sale'            // Sold for fiat or other crypto
  | 'payment'         // Payment for goods/services
  | 'gift-given'      // Gift to someone
  | 'donation'        // Charitable donation
  | 'theft-loss'      // Stolen or lost
  | 'loan-repayment'  // Repaying borrowed funds
  | 'unknown';        // Needs research

export const DISPOSITION_TYPE_OPTIONS: { value: DispositionType; label: string }[] = [
  { value: 'sale', label: 'Sale' },
  { value: 'payment', label: 'Payment' },
  { value: 'gift-given', label: 'Gift Given' },
  { value: 'donation', label: 'Donation' },
  { value: 'theft-loss', label: 'Theft/Loss' },
  { value: 'loan-repayment', label: 'Loan Repayment' },
  { value: 'unknown', label: 'Unknown' },
];

// Counterparty type for external addresses (not your own)
export type CounterpartyType = 
  | 'exchange'        // Cryptocurrency exchange
  | 'individual'      // Personal contact
  | 'business'        // Merchant or employer
  | 'mining-pool'     // Mining pool payout address
  | 'mixer'           // Mixing service (Wasabi, JoinMarket, etc.)
  | 'unknown';        // Unidentified address

export const COUNTERPARTY_TYPE_OPTIONS: { value: CounterpartyType; label: string }[] = [
  { value: 'exchange', label: 'Exchange' },
  { value: 'individual', label: 'Individual' },
  { value: 'business', label: 'Business' },
  { value: 'mining-pool', label: 'Mining Pool' },
  { value: 'mixer', label: 'Mixer/CoinJoin' },
  { value: 'unknown', label: 'Unknown' },
];

// Vault metadata for multisig XPUB-derived addresses
export interface VaultMetadata {
  isVaultXpub: boolean;
  vaultName?: string | null;
  m?: number | null; // Required signatures
  n?: number | null; // Total keys
  vaultNotes?: string | null;
}

// === Normalized record model (v44) =========================================
// These rows deliberately coexist with the legacy Record fields during the
// staged rollout.  The legacy fields remain the compatibility projection until
// every reader has moved to this model.
export type EntityKind = 'person' | 'organisation' | 'counterparty' | 'self';
export type AddressOwnershipState =
  | 'assigned'
  | 'ours-owner-unknown'
  | 'not-ours'
  | 'undetermined';
export type TransactionLegDirection = 'incoming' | 'outgoing' | 'owner-transfer';

export interface RecordEntity {
  id?: number;
  /** Lower-cased, trimmed natural key; stable across backup/restore. */
  naturalKey: string;
  name: string;
  kind: EntityKind;
  /** Preserved classification for entities created from legacy counterparties. */
  counterpartyType?: CounterpartyType;
  createdAt: number;
  updatedAt: number;
}

export interface RecordWallet {
  id?: number;
  /** Name plus provenance/owner fields, normalized by record-model-crud. */
  naturalKey: string;
  name: string;
  entityId?: number;
  seedName?: string;
  walletSoftware?: string;
  vault?: VaultMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface AddressOwnership {
  id?: number;
  recordId: number;
  state: AddressOwnershipState;
  entityId?: number;
  /** Explicit external counterparty, independent of whether ownership is known. */
  counterpartyEntityId?: number;
  walletId?: number;
  /** The old importance tier is provenance confidence, not ownership truth. */
  confidence?: AddressImportance;
  createdAt: number;
  updatedAt: number;
}

export interface TransactionMetadata {
  id?: number;
  txid: string;
  flowType?: FlowType;
  acquisitionMethod?: AcquisitionMethod;
  dispositionType?: DispositionType;
  costBasisUsd?: number;
  counterpartyEntityId?: number;
  categories?: string[];
  tags?: string[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TransactionLegMetadata {
  id?: number;
  txid: string;
  /** Stable participant/outpoint key; `default` is reserved for defaults. */
  legKey: string;
  direction: TransactionLegDirection;
  entityId?: number;
  walletId?: number;
  flowType?: FlowType;
  acquisitionMethod?: AcquisitionMethod;
  dispositionType?: DispositionType;
  costBasisUsd?: number;
  categories?: string[];
  tags?: string[];
  notes?: string;
  /** True only where a legacy value disagreed with transaction defaults. */
  hasFlowOverride?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Durable checkpoint for the post-unlock, batched v44 projection. */
export interface RecordModelMigrationState {
  id: 'v44';
  phase: 'addresses' | 'transactions' | 'complete';
  lastRecordId: number;
  singleOwner?: boolean;
  completedAt?: number;
  updatedAt: number;
}

// Plaintext record structure (for type safety and querying)
export interface Record {
  id?: number;
  type: 'address' | 'transaction' | 'other';
  inputString: string;
  inputStringLower?: string;
  label: string;
  notes?: string;
  amount?: number;
  date?: string;
  tags: string[];
  categories: string[];
  seedName?: string;
  walletSoftware?: string;
  privateKeyStatus?: string;
  // Owner identifies who controls/owns this address (person, entity, or unknown)
  owner?: string;
  // Wallet name identifies the specific wallet (e.g., "College Fund", "Trading", "KYC Wallet")
  walletName?: string;
  // Source indicates how this record was added: 'manual', 'wallet-import', or 'xpub-import'
  source?: string;
  // Chain type for XPUB-derived addresses (receive = external, change = internal)
  chainType?: ChainType;
  // Derivation path for XPUB-derived addresses
  derivationPath?: string;
  // XPUB key used to derive this address
  xpub?: string;
  // Vault metadata for multisig XPUB-derived addresses
  vault?: VaultMetadata;
  // User-defined custom field values (slug -> value)
  customFields?: { [slug: string]: string };
  // Sync depth: 0 = manually entered/imported, 1+ = discovered via blockchain sync
  // Addresses at depth N were found in transactions of depth N-1 addresses
  syncDepth?: number;
  // Maximum depth this record has been synced to (for incremental deeper syncs)
  maxSyncedDepth?: number;
  // Transaction ID where this address was first discovered (for auto-imported addresses)
  discoveredInTxid?: string;
  // Record ID of the address that led to discovering this one
  discoveredFromRecordId?: number;
  // Importance tier for filtering provenance views and prioritization
  addressImportance?: AddressImportance;
  // First seen on blockchain - Unix timestamp (seconds) of the earliest transaction
  // For addresses: earliest tx involving this address
  // For transactions: the block confirmation time
  firstSeenBlockTime?: number;

  // === Per-address stats cache (address-type records only) ===
  // These are a cache derived from locally-stored transaction data, computed
  // during user-initiated sync or a local-only recompute. They are NEVER kept
  // fresh by any background/automatic network access.
  // Standard-mode balance in satoshis (sum of outputs to this address minus
  // sum of inputs from this address), as computed from participant rows.
  cachedBalanceSats?: number;
  // Number of distinct transactions involving this address.
  cachedTxCount?: number;
  // Block time (Unix seconds) of the most recent transaction for this address.
  cachedLastActivityTime?: number;
  // Timestamp (ms) when the stats cache was last computed. When undefined, the
  // address has no fetched transaction data yet → UI shows "not synced" instead
  // of a misleading zero balance.
  statsComputedAt?: number;
  // Number of unspent outputs (UTXOs) currently held by this address, computed
  // per-address from local participant data (exact when prevout data exists,
  // otherwise an amount/time heuristic). When `statsComputedAt` is set but this
  // is undefined, the address predates the utxo-count cache and needs a one-time
  // backfill recompute.
  cachedUtxoCount?: number;
  
  // === Transaction-specific metadata fields ===
  // Flow type: direction/purpose of the transaction
  flowType?: FlowType;
  // Acquisition method: how funds were acquired (for received transactions)
  acquisitionMethod?: AcquisitionMethod;
  // Disposition type: purpose of outgoing funds (for sent transactions)
  dispositionType?: DispositionType;
  // User-provided cost basis in USD (overrides historical price data when set)
  costBasisUsd?: number;
  
  // === Address-specific metadata fields ===
  // Counterparty type: classification of external addresses
  counterpartyType?: CounterpartyType;
  // Counterparty name: explicit human-friendly source/counterparty name (e.g.
  // "Coinbase"), distinct from walletName/label. Used by the Acquisition &
  // Provenance appendix; falls back to walletName/label/counterpartyType when blank.
  counterpartyName?: string;

  // Per-field conflict resolutions recorded from the Conflict Resolution page.
  // Keyed by singular field key (label/owner/seedName/walletName/
  // walletSoftware/privateKeyStatus). A field with >=2 distinct origin values
  // stays flagged as a conflict until a resolution is recorded here; a newer
  // origin that introduces a different value after `resolvedAt` re-opens it.
  // Optional and non-indexed — no Dexie schema version bump required.
  conflictResolutions?: ConflictResolutionMap;

  createdAt: number;
  updatedAt: number;
}

// A single recorded conflict decision for one singular field.
export interface ConflictFieldResolution {
  // The value the user settled on (trimmed). Empty string means the user
  // deliberately kept the field empty.
  value: string;
  // Timestamp (ms) when the resolution was recorded. Origins created after
  // this time with a different value re-open the conflict.
  resolvedAt: number;
}

export type ConflictResolutionMap = { [fieldKey: string]: ConflictFieldResolution };

export interface Attachment {
  id?: number;
  recordId: number;
  filename: string;
  mimeType: string;
  size: number;
  objectStoragePath: string;
  createdAt: number;
}

// Metadata for an attachment whose database row was deleted but whose file is
// intentionally kept on disk so it stays recoverable. Deleting a record (or an
// attachment) archives a row here instead of destroying the file; the user can
// download it back or permanently purge it from Settings.
export interface TrashedAttachment {
  id?: number;
  recordId: number;
  // The address/txid the file was attached to, when known (for display only).
  identifier?: string;
  filename: string;
  mimeType: string;
  size: number;
  // Where the file still lives on disk (unchanged from the original attachment).
  objectStoragePath: string;
  deletedAt: number;
  source: 'record-delete' | 'attachment-delete';
}

export interface Tag {
  id?: number;
  name: string;
  color?: string;
  createdAt: number;
}

export interface Category {
  id?: number;
  name: string;
  createdAt: number;
}

// Vocabulary items for dropdown selections
export interface Owner {
  id?: number;
  name: string;
  /** Policy owners are deliberately separate from the legacy owner string on records. */
  kind?: OwnerKind;
  /** Immutable policy identity; the display name may be changed. */
  isDefault?: boolean;
  /** Set instead of deleting so historic policy and record labels remain auditable. */
  archivedAt?: number;
  createdAt: number;
}

export type OwnerKind = 'person' | 'company';
export type OwnerMatchingMethod = 'fifo' | 'lifo' | 'hifo' | 'specific-identification' | 'proportional';

/** Inclusive, ISO-calendar-date residency policy for an owner. */
export interface OwnerResidency {
  id?: number;
  ownerId: number;
  startDate: string;
  /** Undefined means the policy remains in force indefinitely. */
  endDate?: string;
  jurisdiction: string;
  region?: string;
  notes?: string;
  matchingMethod: OwnerMatchingMethod;
  createdAt: number;
  updatedAt: number;
}

export interface WalletName {
  id?: number;
  name: string;
  createdAt: number;
}

export interface SeedName {
  id?: number;
  name: string;
  createdAt: number;
}

export interface WalletSoftware {
  id?: number;
  name: string;
  createdAt: number;
}

// Origin type for tracking how a record was added
export type RecordOriginType = 'manual' | 'xpub-derived' | 'bulk-import' | 'wallet-sync' | 'blockchain-sync';

// Record origin tracks where metadata came from (manual entry vs xpub import etc)
export interface RecordOrigin {
  id?: number;
  recordId: number;
  originType: RecordOriginType;
  // Metadata specific to this origin source
  label?: string;
  notes?: string;
  tags?: string[];
  categories?: string[];
  seedName?: string;
  walletSoftware?: string;
  privateKeyStatus?: string;
  owner?: string;
  walletName?: string;
  source?: string;
  // For xpub-derived origins
  xpub?: string;
  derivationPath?: string;
  chainType?: ChainType;
  createdAt: number;
}

// Custom field definition created by user
export interface CustomField {
  id?: number;
  name: string; // Display name
  slug: string; // Unique identifier for storage (auto-generated from name)
  enabled: boolean; // Whether to show in forms
  createdAt: number;
}

export const DESKTOP_LOCK_TIMEOUT_OPTIONS = [0, 60, 300, 900, 1800, 3600] as const;

export interface SavedInboxViewFilters {
  dateMode: 'any' | 'range' | 'exact';
  dateStart?: string;
  dateEnd?: string;
  dateExact?: string;
  amountMode: 'any' | 'range' | 'exact';
  amountMinBtc?: number;
  amountMaxBtc?: number;
  amountExactBtc?: number;
  entityAddress?: string;
  entityWallet?: string[];
  entitySeed?: string[];
  entityOwner?: string[];
  entityTag?: string[];
  entityCategory?: string[];
}

/** A named, portable snapshot of the Transaction Inbox query controls. */
export interface SavedInboxView {
  id: string;
  name: string;
  tab: TransactionCurationState;
  search: string;
  filters: SavedInboxViewFilters;
  createdAt: number;
}

export interface Settings {
  id: string;
  fieldVisibility: {
    seedName: boolean;
    walletSoftware: boolean;
    privateKeyStatus: boolean;
    owner: boolean;
    walletName: boolean;
    source: boolean;
  };
  tableColumns: {
    tags: boolean;
    categories: boolean;
    walletSoftware: boolean;
    seedName: boolean;
    privateKeyStatus: boolean;
    hasAttachments: boolean;
    owner: boolean;
    walletName: boolean;
    source: boolean;
    firstSeen: boolean;
    balance: boolean;
    lastTxDate: boolean;
    txCount: boolean;
  };
  customFieldColumns: { [key: string]: boolean };
  theme: 'light' | 'dark';
  defaultView: 'table' | 'grid';
  cancelConfirmThreshold: number;
  // Number of Privacy Audit history snapshots to retain (oldest trimmed first).
  // When unset, defaults to DEFAULT_PRIVACY_HISTORY_LIMIT (30).
  privacyHistoryLimit?: number;
  // Persisted user preference for the Privacy Audit peel-chain view toggle.
  // Defaults to 'graph' for first-time users when unset.
  peelChainViewMode?: 'graph' | 'list';
  // Persisted user preference for whether the Privacy Audit score breakdown
  // (waterfall chart) is expanded. Defaults to false (collapsed) when unset.
  showScoreBreakdown?: boolean;
  // When true, the startup scan for transaction records missing on-chain data
  // ("orphaned" txids) is skipped entirely. Defaults to false (check enabled).
  disableOrphanCheck?: boolean;
  // Max number of most-recent transactions the Fund Trail loads per hop before
  // capping (trade-off between completeness and speed on busy wallets).
  // When unset, defaults to DEFAULT_TX_LIMIT (2000).
  fundTrailTxLimit?: number;
  // Persisted user preference for the Fund Trail multi-hop layout selector
  // (see FundTrailLayout in fund-trail/view-data.ts). Defaults to 'classic'
  // when unset.
  fundTrailLayout?: 'classic' | 'horizontal' | 'vertical' | 'breakout' | 'sankey';
  // Max number of funding transactions the Source of Funds Report processes per
  // report run before capping (mirrors the Fund Trail limit control).
  // When unset, defaults to DEFAULT_TX_LIMIT (2000).
  sourceOfFundsTxLimit?: number;
  // Max number of intermediary (unknown) addresses listed inline in a Fund Trail
  // export chain before the remainder is summarized as "(+N more)". Lets auditors
  // tune readability vs. completeness. When unset, defaults to
  // DEFAULT_INTERMEDIARY_ADDRESS_CAP (MAX_INTERMEDIARY_ADDRESSES, 10).
  intermediaryAddressCap?: number;
  // Per-field toggles for the address/TXID hover tooltip. When unset, all fields
  // default to visible and system tags (namespace-prefixed, e.g. quantum:*) are
  // excluded. Stored as an optional sub-object so older vaults keep defaults.
  hoverTooltipPrefs?: {
    showWalletName: boolean;
    showOwner: boolean;
    showCategory: boolean;
    showTags: boolean;
    showNotes: boolean;
    showSeedName: boolean;
    showSoftware: boolean;
    showPrivateKeyStatus: boolean;
    includeSystemTags: boolean;
  };
  // Which Quantum Risk Scanner risk levels receive their `quantum:*` tag when
  // a scan runs. Stored as an optional array so older vaults keep the default
  // (critical + high — see DEFAULT_QUANTUM_TAG_LEVELS in lib/quantum-risk.ts).
  // An explicit empty array is meaningful: scans classify addresses but write
  // no tags at all ("analysis only").
  quantumTagLevels?: ('critical' | 'high' | 'medium' | 'variable' | 'low')[];
  // Optional user-supplied offline snapshot for the Privacy Audit entity list.
  // When present it is applied to the active list at runtime; the bundled list
  // remains the fallback (cleared via "reset to bundled"). `mode` records how
  // the snapshot was applied so startup re-applies it the same way:
  //   - 'replace' (default): the snapshot entries are the entire active list.
  //   - 'merge': the snapshot entries are unioned on top of the bundled list,
  //     with the snapshot winning on duplicate addresses. Only the user-supplied
  //     entries are stored (not the merged result), so bundled updates still
  //     flow through and the user need not re-supply the bundled defaults.
  // No network access.
  entityListSnapshot?: {
    importedAt: number;
    sourceLabel?: string;
    mode?: 'replace' | 'merge';
    entries: EntityListSnapshotEntry[];
  };
  // Named Transaction Inbox searches are local user workflow state. They are
  // stored in settings (not on transactions) and carried by backups so a
  // reviewer's saved views are available after restoring on another device.
  savedInboxViews?: SavedInboxView[];
  // Device-local, derived cache of the vault-wide behavior-label tally (how many
  // addresses fall into each behavior label). Materialized by a streamed
  // background pass over the cached address stats — never holds the whole vault
  // in memory and never touches the network. `addressCount` is a freshness
  // fingerprint: when the live address count diverges the tally is recomputed.
  // Not a portable preference, so it is intentionally excluded from backup
  // restore (it is recomputed lazily after a restore).
  behaviorTally?: {
    computedAt: number;
    addressCount: number;
    syncedCount: number;
    counts: { [label: string]: number };
  };
  // Tracks which version of the balance formula was used to populate
  // cachedBalanceSats. Version 2 = unspent-output sum (never negative).
  // When absent (or < 2), the Balance page triggers a full recompute so
  // stale cached values (old received-minus-spent formula) are corrected.
  balanceFormulaVersion?: number;
  // Device-local scheduled backup policy. Destination paths intentionally stay
  // local to this installation and are not imported from backup files.
  backupSchedule?: BackupScheduleSettings;
  // Device-local desktop vault lock policy. It is intentionally excluded from
  // portable backup preferences because it describes this installation's
  // physical security environment.
  desktopLockSettings?: DesktopLockSettings;
  // Staged choices in the category-retirement workflow.  They are deliberately
  // preferences rather than record data: nothing is changed until Apply is
  // pressed, and the reviewer can leave Settings and resume later.
  categoryMappingDraft?: { [category: string]: CategoryMappingDraftDecision };
  /** Completed/partially-completed category retirement decisions. Kept with
   * the draft so an interrupted Apply can resume without replaying writes. */
  categoryMappingCheckpoints?: { [category: string]: CategoryMappingCheckpoint };
}

export type CategoryMappingClassification =
  | 'flowType:received' | 'flowType:sent' | 'flowType:self-transfer' | 'flowType:consolidation'
  | 'acquisitionMethod:purchase' | 'acquisitionMethod:mining' | 'acquisitionMethod:staking'
  | 'acquisitionMethod:airdrop' | 'acquisitionMethod:fork' | 'acquisitionMethod:gift-received'
  | 'acquisitionMethod:inheritance' | 'acquisitionMethod:salary'
  | 'acquisitionMethod:payment-for-services' | 'acquisitionMethod:loan'
  | 'acquisitionMethod:unknown'
  | 'dispositionType:sale' | 'dispositionType:payment' | 'dispositionType:gift-given'
  | 'dispositionType:donation' | 'dispositionType:theft-loss'
  | 'dispositionType:loan-repayment' | 'dispositionType:unknown'
  | 'counterpartyType:exchange' | 'counterpartyType:individual'
  | 'counterpartyType:business' | 'counterpartyType:mining-pool'
  | 'counterpartyType:mixer' | 'counterpartyType:unknown';

/** Runtime source of truth used at both the backup boundary and write boundary.
 * Do not accept arbitrary `field:value` strings: category mapping is a bulk
 * record mutation and must never become a generic field-write primitive. */
export const CATEGORY_MAPPING_CLASSIFICATIONS: readonly CategoryMappingClassification[] = [
  ...FLOW_TYPE_OPTIONS.map(({ value }) => `flowType:${value}` as CategoryMappingClassification),
  ...ACQUISITION_METHOD_OPTIONS.map(({ value }) => `acquisitionMethod:${value}` as CategoryMappingClassification),
  ...DISPOSITION_TYPE_OPTIONS.map(({ value }) => `dispositionType:${value}` as CategoryMappingClassification),
  ...COUNTERPARTY_TYPE_OPTIONS.map(({ value }) => `counterpartyType:${value}` as CategoryMappingClassification),
];

export function isCategoryMappingClassification(value: unknown): value is CategoryMappingClassification {
  return typeof value === 'string' &&
    (CATEGORY_MAPPING_CLASSIFICATIONS as readonly string[]).includes(value);
}

export type CategoryMappingDraftDecision =
  | { kind: 'tag'; tagName: string }
  | { kind: 'rename'; categoryName: string }
  | { kind: 'classification'; classification: CategoryMappingClassification }
  | { kind: 'drop' }
  | { kind: 'skip' };

export interface CategoryMappingCheckpoint {
  status: 'applied' | 'partially-applied';
  appliedAt: number;
}

export type BackupCadenceDays = 1 | 7 | 14 | 30 | 90;
export type BackupPromptBehavior = "automatic" | "ask";

export interface BackupScheduleSettings {
  enabled: boolean;
  destinations: BackupDestination[];
  cadenceDays: BackupCadenceDays;
  retentionCount: number;
  compact: boolean;
  encrypted: boolean;
  promptBehavior: BackupPromptBehavior;
  lastVerifiedAt?: number;
  lastVerifiedDestination?: string;
  lastVerifiedSizeBytes?: number;
  lastVerifiedChecksum?: string;
  lastRestoreDrillAt?: number;
  lastFailureAt?: number;
  lastFailureMessage?: string;
  destinationStates?: { [token: string]: BackupDestinationState };
}

/** A displayable destination plus an opaque capability owned by the main process. */
export interface BackupDestination {
  token: string;
  label: string;
  /** Informational only; it must never be supplied to a filesystem IPC call. */
  path?: string;
}

export interface BackupDestinationState {
  lastVerifiedAt?: number;
  lastVerifiedSizeBytes?: number;
  lastVerifiedChecksum?: string;
  lastFailureAt?: number;
  lastFailureMessage?: string;
  /** Device-local free-space readings for this opaque destination capability. */
  freeSpaceHistory?: BackupFreeSpaceReading[];
}

export interface BackupFreeSpaceReading {
  at: number;
  freeBytes: number;
}
export function createDefaultSettings(id: string = 'default'): Settings {
  return {
    id,
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
      balance: false,
      lastTxDate: false,
      txCount: false,
    },
    customFieldColumns: {},
    theme: 'light',
    defaultView: 'table',
    cancelConfirmThreshold: 75,
    privacyHistoryLimit: 30,
    disableOrphanCheck: false,
    fundTrailTxLimit: 2000,
    fundTrailLayout: 'classic',
    intermediaryAddressCap: 10,
    backupSchedule: {
      enabled: false,
      destinations: [],
      cadenceDays: 7,
      retentionCount: 5,
      compact: false,
      encrypted: true,
      promptBehavior: 'ask',
    },
  };
}

// Mirrors `EntityEntry` from privacy-entity-list.ts. Defined locally so the
// Settings type does not pull the large bundled dataset module into type files.
export interface EntityListSnapshotEntry {
  address: string;
  name: string;
  category: string;
  sourceNote?: string;
}

// Historical price data for Bitcoin and other cryptocurrencies
export interface PriceData {
  id?: number;
  date: string;           // YYYY-MM-DD format
  currency: string;       // "USD", "EUR", etc.
  asset: string;          // "BTC", "ETH", etc.
  open?: number;
  high?: number;
  low?: number;
  close: number;          // Required - daily closing price
  volume?: number;
  source: string;         // "cryptodatadownload", "coingecko", "investing", etc.
  importedAt: number;     // Timestamp of when this data was imported
}

// === Privacy Audit History ===
// A lightweight snapshot written after each completed Privacy Audit so users can
// track how their privacy score changes over time as they adopt better habits
// (CoinJoin, fresh addresses, avoiding consolidation). History is trimmed to the
// most recent runs to avoid unbounded growth.
export interface PrivacyAuditHistoryEntry {
  id?: number;
  // When this audit completed (ms epoch)
  timestamp: number;
  // Overall privacy score 0-100
  score: number;
  // Letter grade derived from the score (e.g. "A+", "B")
  grade: string;
  // Total number of findings + warnings detected
  totalFindings: number;
  // Number of transactions analyzed in this run
  transactionsAnalyzed: number;
  // Number of addresses scanned in this run
  addressesScanned: number;
  // Count of findings by severity tier
  severityCounts: {
    CRITICAL: number;
    HIGH: number;
    MEDIUM: number;
    LOW: number;
  };
  // Count of findings keyed by finding type (e.g. ADDRESS_REUSE -> 3). Used to
  // show which finding types changed between runs.
  findingTypeCounts: { [findingType: string]: number };
  // Filter scope this audit was run under (for display/context only)
  owner?: string;
  walletName?: string;
  // Adversary View summary captured for this run (written after the async
  // adversary analysis completes). Absent on runs recorded before this field
  // existed, or when the adversary analysis failed for that run. When the
  // user cancels the adversary analysis mid-run, a `{ status: 'cancelled' }`
  // marker is stored instead of the counts so history/exports can distinguish
  // "run was cancelled" from "never ran" (blank) and from "zero exposure".
  adversary?:
    | {
        status?: never;
        exposureCount: number;
        addressesExposed: number;
        separationCount: number;
        confusionCount: number;
        contextMergeCount: number;
      }
    | { status: 'cancelled' };
}

// Script type classification for addresses/outputs
export type ScriptType = 
  | 'p2pkh'          // Pay-to-PubKey-Hash (legacy)
  | 'p2sh'           // Pay-to-Script-Hash
  | 'v0_p2wpkh'      // Native SegWit (P2WPKH)
  | 'v0_p2wsh'       // Native SegWit (P2WSH)
  | 'v1_p2tr'        // Taproot
  | 'p2pk'           // Pay-to-PubKey (very old)
  | 'op_return'      // OP_RETURN data output
  | 'multisig'       // Bare multisig
  | 'nonstandard'    // Non-standard script
  | 'unknown';       // Unrecognized type

// OP_RETURN output data
export interface OpReturnOutput {
  vout: number;           // Output index
  dataHex: string;        // Raw hex data (after OP_RETURN)
  dataText?: string;      // Decoded as UTF-8 text (if valid)
  dataAsm?: string;       // Assembly representation
}

// Blockchain transaction data (fetched from blockchain APIs)
export interface BlockchainTransaction {
  id?: number;
  txid: string;           // Transaction ID (hash)
  blockHeight: number;    // Block number where tx was confirmed
  blockTime: number;      // Unix timestamp of block
  fee: number;            // Transaction fee in satoshis
  feeRate: number;        // Fee rate in sats/vB
  syncedAt: number;       // When we fetched this data
  // Size and weight data
  size?: number;          // Transaction size in bytes
  weight?: number;        // Transaction weight units
  vsize?: number;         // Virtual size (weight / 4)
  // OP_RETURN data
  hasOpReturn?: boolean;  // Flag if transaction has OP_RETURN outputs
  opReturnData?: OpReturnOutput[]; // OP_RETURN output details
  // === Wallet-fingerprinting fields (Phase C) ===
  // These fields are only populated for transactions synced AFTER the
  // fingerprinting feature was added. Check rawFingerprintCaptured before
  // using any field below — if false/undefined, show "re-sync needed" rather
  // than incorrect results.
  //
  // Whether raw fingerprint fields were captured during sync
  rawFingerprintCaptured?: boolean;
  // Bitcoin transaction version (1 or 2; 2 is required for BIP68)
  nVersion?: number;
  // nLockTime value; 0 = no lock; <500000000 = block height; else unix time
  nLockTime?: number;
  // Whether ALL inputs signal RBF (nSequence < 0xFFFFFFFE)
  hasRbf?: boolean;
  // Whether inputs and outputs follow BIP69 lexicographic ordering
  isBip69Ordered?: boolean;
  // Whether at least one input uses a low-R DER signature (Bitcoin Core style grinding)
  hasLowRSig?: boolean;
  // Whether the transaction has any segwit inputs (witness data present)
  hasWitness?: boolean;
  // Whether the tx mixes segwit and non-segwit inputs (partial witness = wallet fingerprint)
  hasMixedWitness?: boolean;
  // Whether any input in this transaction is a coinbase (block reward)
  hasCoinbaseInput?: boolean;
  // Local review state. This deliberately lives on the transaction row so
  // backups and transaction de-duplication carry it with the stable txid.
  curationState?: TransactionCurationState;
  curationUpdatedAt?: number;
  snoozedUntil?: number;
}

export type TransactionCurationState = 'new' | 'annotated' | 'ignored' | 'snoozed';
export interface TransactionParticipant {
  id?: number;
  txid: string;           // Foreign key to BlockchainTransaction
  role: 'input' | 'output';
  address: string;
  amount: number;
  vout?: number;
  prevTxid?: string;
  prevVout?: number;
  recordId?: number;
  scriptType?: ScriptType;
}

// Tracks sync state per address for incremental syncing
export interface AddressSyncState {
  id?: number;
  address: string;        // The address being tracked
  recordId?: number;      // Link to records table if exists
  lastSyncedHeight: number; // Last block height we synced up to
  lastSyncedAt: number;   // Timestamp of last sync
  txCount: number;        // Number of transactions found for this address
}

// Node connection provider types
export type NodeProviderType = 
  | 'mempool-space'       // mempool.space public API (default)
  | 'blockstream'         // blockstream.info public API
  | 'custom-electrs'      // Self-hosted Electrs/Esplora API
  | 'custom-mempool';     // Self-hosted mempool instance

export type NetworkPrivacyMode =
  | 'own-node'
  | 'electrum'
  | 'public-tor'
  | 'public-direct';

/** A device-local record of the kind of blockchain-related action performed. */
export type NetworkPrivacyActivityType =
  | 'sync'
  | 'address-check'
  | 'provider-test'
  | 'price-source';
export const DEFAULT_TRUSTED_LOCAL_HOSTS = [
  'localhost',
  '127.0.0.1',
  'umbrel.local',
  'umbrel',
  '192.168.1.1',
  '10.21.21.9',  // Umbrel's internal Docker IP for Electrs
];

// Node connection settings for blockchain data fetching
export interface NodeSettings {
  id: string;             // Always 'default' - singleton pattern
  providerType: NodeProviderType;
  // Custom server settings (for custom-electrs or custom-mempool)
  customUrl?: string;     // e.g., "http://192.168.1.100:3002" or "http://xyz.onion:3002"
  // Tor/onion settings
  useTor: boolean;        // Whether to route through Tor
  torProxyUrl?: string;   // Tor SOCKS proxy URL (e.g., "socks5h://127.0.0.1:9050")
  // Timeout settings (in milliseconds)
  requestTimeout: number; // Default 30000 (30s), higher for Tor
  // Network selection
  network: 'mainnet' | 'testnet';
  // Local network access (SECURITY: disabled by default, user must opt-in)
  allowLocalNetwork: boolean;  // Whether to allow connections to local network hosts
  // Trusted local hosts whitelist (only used when allowLocalNetwork is true)
  trustedLocalHosts: string[];  // User-editable whitelist of allowed local IPs/hostnames
  // Electrum protocol settings (alternative to HTTP API)
  useElectrum?: boolean;        // Whether to use Electrum protocol instead of HTTP
  electrumHost?: string;        // Electrum server host (e.g., "192.168.4.118")
  electrumPort?: number;        // Electrum server port (e.g., 50001)
  electrumSSL?: boolean;        // Whether to use SSL/TLS for Electrum connection
  electrumServerType?: 'electrs' | 'fulcrum';  // Server implementation type
  // Last successful connection timestamp
  lastConnectedAt?: number;
  // Connection status message
  lastConnectionStatus?: string;
  /**
   * Present only after the user has explicitly chosen how this vault may
   * contact the Bitcoin network. Older vaults omit it and retain their existing
   * behavior; freshly-created vaults persist onboardingStage='source' and
   * networkAccessEnabled=false before the authenticated app is mounted.
   */
  networkPrivacyMode?: NetworkPrivacyMode;
  networkAccessEnabled?: boolean;
  networkOnboardingStage?: NetworkOnboardingStage;
  networkPrivacyChosenAt?: number;
  firstSyncConfirmedAt?: number;
}

/**
 * Every NodeSettings field must be classified here. The network-policy write
 * guard fails closed when a field is added to NodeSettings without an explicit
 * decision about whether it belongs behind the serialized policy boundary.
 */
export const NODE_SETTINGS_POLICY_FIELDS = [
  'networkAccessEnabled',
  'networkOnboardingStage',
  'networkPrivacyMode',
  'networkPrivacyChosenAt',
  'firstSyncConfirmedAt',
] as const satisfies readonly (keyof NodeSettings)[];

export const NODE_SETTINGS_ORDINARY_FIELDS = [
  'id',
  'providerType',
  'customUrl',
  'useTor',
  'torProxyUrl',
  'requestTimeout',
  'network',
  'allowLocalNetwork',
  'trustedLocalHosts',
  'useElectrum',
  'electrumHost',
  'electrumPort',
  'electrumSSL',
  'electrumServerType',
  'lastConnectedAt',
  'lastConnectionStatus',
] as const satisfies readonly (keyof NodeSettings)[];

// === Paused Sync State ===
// Stores paused sync state for resume functionality
export interface PausedSyncState {
  id: string;                     // Always 'default' - singleton pattern
  pausedAt: number;               // Timestamp when sync was paused
  remainingRecordIds: number[];   // Record IDs still to sync
  completedRecordIds: number[];   // Record IDs already synced in this session
  sourceSelection: {              // Source filter settings
    selectedSources: string[];    // Array version of Set for storage
    includeNoSource: boolean;
  };
  maxDepth: number;               // Max depth setting
  currentDepth: number;           // Current depth being processed
  // Cumulative stats from the paused sync
  transactionsImported: number;
  transactionsUpdated: number;
  newlyQueuedTransactions?: number;
  newAddressRecords: number;
  addressesSynced: number;
}

// === UTXO Lineage Tracking for AML/SOF ===

// Confidence tier for lineage links (higher = more reliable)
export type LineageConfidence = 
  | 'verified'      // User manually verified this link
  | 'high'          // Both addresses are owned (wallet-import, xpub-derived, manual)
  | 'medium'        // One owned address, one external but identified
  | 'low'           // Blockchain-discovered with limited context
  | 'unknown';      // Inferred from blockchain only

// Tracks individual UTXO → UTXO relationships for provenance tracing
export interface UtxoLineage {
  id?: number;
  // The UTXO that was spent (input)
  spentTxid: string;        // Transaction where the UTXO was created
  spentVout: number;        // Output index of the UTXO
  spentAddress: string;     // Address that held the UTXO
  spentAmount: number;      // Amount in satoshis
  // The transaction that spent the UTXO
  consumingTxid: string;    // Transaction that spent the UTXO
  // The resulting UTXO (output) - for tracking where funds went
  createdTxid: string;      // Same as consumingTxid for direct spend
  createdVout: number;      // Output index of new UTXO
  createdAddress: string;   // Destination address
  createdAmount: number;    // Amount in satoshis
  // Ownership tracking
  spentOwned: boolean;      // Is the spent address owned by user?
  createdOwned: boolean;    // Is the destination address owned by user?
  isChange: boolean;        // Is this a change output back to user?
  // Confidence and metadata
  confidence: LineageConfidence;
  blockTime: number;        // Unix timestamp of the consuming transaction
  blockHeight: number;      // Block height of the consuming transaction
  // Segment linking
  segmentId?: string;       // Links to parent custody segment
  createdAt: number;
}

// Custody segment status
export type CustodyStatus = 
  | 'active'        // Currently held by user
  | 'spent'         // Fully spent to external party
  | 'split'         // Partially spent, with change continuing custody
  | 'consolidated'; // Merged into another segment

// Tracks ownership periods for coin bundles
export interface CustodySegment {
  id?: number;
  segmentId: string;          // Unique identifier (UUID)
  // Origin information
  originTxid: string;         // Transaction where custody began
  originVout: number;         // Output index at origin
  originAddress: string;      // Address at origin
  originDate: number;         // Unix timestamp of origin
  originAmount: number;       // Original amount in satoshis
  // Acquisition details (from record metadata if available)
  acquisitionMethod?: string; // How funds were acquired
  costBasisUsd?: number;      // Cost basis at acquisition (USD)
  // Current state
  currentTxid?: string;       // Most recent transaction (if still held)
  currentVout?: number;       // Current output index
  currentAddress?: string;    // Current address
  currentAmount: number;      // Current amount (may be less after partial spends)
  status: CustodyStatus;      // Current custody status
  // Segment relationships
  // RESERVED, currently never populated: buildCustodySegment in
  // lineageEngine.ts leaves both undefined. Split custody is represented by
  // the change output becoming its own independent segment (owned lineage
  // origin), not by parent/child linkage. Do not rely on these being set.
  parentSegmentId?: string;   // Parent segment if this is from a split
  childSegmentIds?: string[]; // Child segments if this was split
  // Hop tracking
  hopCount: number;           // Number of internal transfers
  // Evidence linking
  evidenceTxids: string[];    // All txids in this custody chain
  attachmentIds?: number[];   // Links to attachments (receipts, etc.)
  // Narrative generation
  narrative?: string;         // Human-readable custody timeline
  lineageTruncated?: boolean; // Whether lineage data was capped during build
  // Owner/wallet metadata (inherited from records)
  owner?: string;
  walletName?: string;
  seedName?: string;
  createdAt: number;
  updatedAt: number;
}

// Pre-computed lineage snapshot for export/sharing
export interface LineageSnapshot {
  id?: number;
  snapshotId: string;         // Unique identifier (UUID)
  // Target of this snapshot
  targetType: 'address' | 'utxo' | 'segment';
  targetAddress?: string;     // For address-based snapshots
  targetTxid?: string;        // For UTXO/segment-based snapshots
  targetVout?: number;        // For UTXO-based snapshots
  targetSegmentId?: string;   // For segment-based snapshots
  // Snapshot content
  segments: string[];         // Array of segmentIds included
  evidenceTxids: string[];    // All transaction IDs in the proof
  // Summary data
  totalAmount: number;        // Total amount covered (satoshis)
  earliestDate: number;       // Earliest origin date
  latestDate: number;         // Most recent date in chain
  hopCount: number;           // Total hops across all segments
  // Narrative
  narrative: string;          // Full human-readable narrative
  // Redaction support (for Approach C - selective disclosure)
  redactedAddresses?: string[];    // Addresses to hide in export
  disclosureLevel: 'full' | 'summary' | 'minimal';
  // Export metadata
  generatedAt: number;        // When snapshot was created
  expiresAt?: number;         // Optional expiration for shared snapshots
}

// Document types for evidence entries
export type EvidenceDocumentType = 
  | 'email'           // Email correspondence
  | 'screenshot'      // Screenshot evidence
  | 'receipt'         // Payment receipt
  | 'invoice'         // Invoice document
  | 'contract'        // Legal contract or agreement
  | 'id-verification' // Identity verification documents
  | 'bank-statement'  // Bank or financial statement
  | 'tax-document'    // Tax-related documents
  | 'correspondence'  // General correspondence
  | 'other';          // Other document types

export const EVIDENCE_DOCUMENT_TYPE_OPTIONS: { value: EvidenceDocumentType; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'screenshot', label: 'Screenshot' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'contract', label: 'Contract' },
  { value: 'id-verification', label: 'ID Verification' },
  { value: 'bank-statement', label: 'Bank Statement' },
  { value: 'tax-document', label: 'Tax Document' },
  { value: 'correspondence', label: 'Correspondence' },
  { value: 'other', label: 'Other' },
];

// Importance levels for evidence entries
export type EvidenceImportance = 'critical' | 'high' | 'medium' | 'low';

export const EVIDENCE_IMPORTANCE_OPTIONS: { value: EvidenceImportance; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

// General evidence/document storage for non-address/txid related items
// Examples: old emails, screenshots, receipts, proof of early participation
export interface Evidence {
  id?: number;
  // Title/description of the evidence
  title: string;
  // Type of document
  documentType: EvidenceDocumentType;
  // Original date of the document (when it was created/sent/received)
  originalDate?: number;  // Unix timestamp in seconds
  // Detailed notes about this evidence
  notes?: string;
  // Tags for categorization
  tags: string[];
  // Parties involved (people, companies, platforms mentioned)
  partiesInvolved?: string[];
  // Where this evidence came from (email client, website, etc.)
  source?: string;
  // Importance level
  importance?: EvidenceImportance;
  createdAt: number;
  updatedAt: number;
}

// Attachment specifically for evidence entries (separate from record attachments)
export interface EvidenceAttachment {
  id?: number;
  evidenceId: number;
  filename: string;
  mimeType: string;
  size: number;
  objectStoragePath: string;
  createdAt: number;
}

// Skipped address from sync - tracked for user review
export type SkipReason = 'tx-count-exceeded' | 'timeout' | 'blacklisted' | 'error';

export interface SkippedAddress {
  id?: number;
  address: string;
  reason: SkipReason;
  txCount?: number;
  errorMessage?: string;
  syncRunTimestamp: number;
  discoveredFromRecordId?: number;
  syncDepth?: number;
  dismissed: 0 | 1;
  createdAt: number;
}

// User-flagged dust output. Marks a specific outpoint (txid:vout) as dust so
// the rest of the app (UTXOs page, reports, Privacy Audit) can annotate or
// exclude it and the user avoids accidentally spending it.
export interface DustFlag {
  id?: number;
  /** "txid:vout" — unique per flagged output */
  outpoint: string;
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  markedAt: number;
}

// === Saved unsigned PSBTs (watch-only PSBT builder) ===
// A PSBT built from user-selected UTXOs, stored with its decoded components so
// it can be revisited, renamed, re-downloaded, or deleted without re-decoding.
// Watch-only by design: the app never holds keys, signs, or broadcasts.
export interface SavedPsbtInput {
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
  /** Detected script kind of the spent output (e.g. 'P2WPKH', 'P2SH-P2WSH'). */
  scriptType: string;
  /** Full BIP-32 path when known (e.g. "m/84'/0'/0'/0/5"). */
  derivationPath?: string;
  /** True when BIP-32 derivation info was embedded in the PSBT input. */
  hasDerivationInfo?: boolean;
  /** True when a witnessScript/redeemScript was embedded (multisig vaults). */
  hasScript?: boolean;
}

/**
 * Zero-value OP_RETURN data output embedded in a saved PSBT (Dexie v38).
 * Used for on-chain notarization: the payload is the evidence file's SHA-256
 * digest, so anyone holding the file can later prove it existed at the
 * transaction's block time.
 */
export interface SavedPsbtDataOutput {
  /** Hex-encoded OP_RETURN payload (32-byte SHA-256 digest for notarizations). */
  payloadHex: string;
  /** True when this data output notarizes an evidence file. */
  isNotarization?: boolean;
  /** Evidence document the payload was computed from (best-effort reference). */
  evidenceId?: number;
  /** Attachment row whose bytes were hashed (best-effort reference). */
  evidenceAttachmentId?: number;
  /** Human-readable hints kept for display after the evidence is gone. */
  evidenceTitle?: string;
  evidenceFilename?: string;
}

export interface SavedPsbtOutput {
  /** Destination/change address; 'OP_RETURN' when `dataOutput` is present. */
  address: string;
  amountSats: number;
  isChange: boolean;
  /** Present only on the zero-value OP_RETURN data output. */
  dataOutput?: SavedPsbtDataOutput;
}

export interface SavedPsbt {
  id?: number;
  name: string;
  /** Base64-encoded unsigned PSBT (BIP-174). */
  psbtBase64: string;
  destinationAddress: string;
  changeAddress?: string;
  feeRateSatsPerVb: number;
  feeSats: number;
  estimatedVbytes: number;
  totalInputSats: number;
  sendAmountSats: number;
  changeSats: number;
  inputs: SavedPsbtInput[];
  outputs: SavedPsbtOutput[];
  createdAt: number;
  updatedAt: number;
}

export interface AdversaryScenario {
  id?: number;
  name: string;
  counterpartyName: string;
  /** Vault addresses the counterparty is assumed to know are the user's. */
  knownAddresses: string[];
  /** Txids the counterparty is assumed to know involve the user. */
  knownTxids: string[];
  createdAt: number;
  updatedAt: number;
}
export interface AddressBlacklist {
  id?: number;
  address: string;
  reason?: string;
  addedAt: number;
}

// Sync protection settings
export interface SyncProtectionSettings {
  txCountThreshold: number;
  perAddressTimeoutMs: number;
}

export const DEFAULT_SYNC_PROTECTION: SyncProtectionSettings = {
  txCountThreshold: 500,
  perAddressTimeoutMs: 60000,
};

export interface PartialExportBundle {
  id?: number;
  selectionKey: string;
  bundle: import('./lineageEngine').EvidenceBundle;
  format: 'json' | 'pdf';
  selectedSegmentIds: string[];
  createdAt: number;
}

// Derivation template for xpub storage
// WARNING: Storing xpubs doesn't risk funds but reveals wallet structure and all addresses
export interface DerivationTemplate {
  id?: number;
  fingerprint: string;
  scriptType: 'P2WPKH' | 'P2PKH' | 'P2SH-P2WPKH' | 'P2TR';
  derivationPath: string;
  xpub?: string;
  gapLimit: number;
  network: 'mainnet' | 'testnet';
  owner?: string;
  walletName?: string;
  seedName?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export type NetworkOnboardingStage = 'source' | 'import' | 'complete';

export type DesktopLockTimeoutSeconds = typeof DESKTOP_LOCK_TIMEOUT_OPTIONS[number];

export interface DesktopLockSettings {
  /** Idle timeout in seconds. Zero disables idle locking. */
  idleTimeoutSeconds: DesktopLockTimeoutSeconds;
  lockOnSuspend: boolean;
  lockOnResume: boolean;
  lockOnScreenLock: boolean;
}

export const DEFAULT_DESKTOP_LOCK_SETTINGS: DesktopLockSettings = {
  // Keep the default aligned with the main-process fail-safe policy.
  idleTimeoutSeconds: 300,
  lockOnSuspend: true,
  lockOnResume: true,
  lockOnScreenLock: true,
};

/**
 * Intentionally contains no address, URL, transaction, or response data.
 * This table is a local activity summary only and is not included in backups.
 */
export interface NetworkPrivacyActivityEntry {
  id?: number;
  timestamp: number;
  providerClass: NetworkPrivacyMode;
  action: NetworkPrivacyActivityType;
  addressCount?: number;
}
