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

// Plaintext record structure (for type safety and querying)
export interface Record {
  id?: number;
  type: 'address' | 'transaction' | 'other';
  inputString: string;
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
  
  createdAt: number;
  updatedAt: number;
  // Encrypted payload - contains the sensitive data when encryption is enabled
  encryptedPayload?: string;
  // Flag to indicate if this record is encrypted
  isEncrypted?: boolean;
}

export interface Attachment {
  id?: number;
  recordId: number;
  filename: string;
  mimeType: string;
  size: number;
  objectStoragePath: string;
  createdAt: number;
  // Encrypted fields
  encryptedPayload?: string;
  isEncrypted?: boolean;
}

export interface Tag {
  id?: number;
  name: string;
  color?: string;
  createdAt: number;
  encryptedPayload?: string;
  isEncrypted?: boolean;
}

export interface Category {
  id?: number;
  name: string;
  createdAt: number;
  encryptedPayload?: string;
  isEncrypted?: boolean;
}

// Vocabulary items for dropdown selections
export interface Owner {
  id?: number;
  name: string;
  createdAt: number;
  encryptedPayload?: string;
  isEncrypted?: boolean;
}

export interface WalletName {
  id?: number;
  name: string;
  createdAt: number;
  encryptedPayload?: string;
  isEncrypted?: boolean;
}

export interface SeedName {
  id?: number;
  name: string;
  createdAt: number;
  encryptedPayload?: string;
  isEncrypted?: boolean;
}

export interface WalletSoftware {
  id?: number;
  name: string;
  createdAt: number;
  encryptedPayload?: string;
  isEncrypted?: boolean;
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
  encryptedPayload?: string;
  isEncrypted?: boolean;
}

// Custom field definition created by user
export interface CustomField {
  id?: number;
  name: string; // Display name
  slug: string; // Unique identifier for storage (auto-generated from name)
  enabled: boolean; // Whether to show in forms
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
}

// Transaction participant (input or output)
export interface TransactionParticipant {
  id?: number;
  txid: string;           // Foreign key to BlockchainTransaction
  role: 'input' | 'output';
  address: string;        // Bitcoin address
  amount: number;         // Amount in satoshis
  vout?: number;          // Output index (for outputs)
  // For inputs: the outpoint being spent (identifies which UTXO is consumed)
  prevTxid?: string;      // The txid of the transaction that created the UTXO being spent
  prevVout?: number;      // The output index in that transaction
  // Link to our records table if address exists there
  recordId?: number;
  // Script/address type information
  scriptType?: ScriptType; // Type of script (p2pkh, p2sh, v0_p2wpkh, v1_p2tr, etc.)
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

// Default trusted local hosts for local network connections
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
}

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
  // Timestamps
  createdAt: number;
  // Encryption
  encryptedPayload?: string;
  isEncrypted?: boolean;
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
  parentSegmentId?: string;   // Parent segment if this is from a split
  childSegmentIds?: string[]; // Child segments if this was split
  // Hop tracking
  hopCount: number;           // Number of internal transfers
  // Evidence linking
  evidenceTxids: string[];    // All txids in this custody chain
  attachmentIds?: number[];   // Links to attachments (receipts, etc.)
  // Narrative generation
  narrative?: string;         // Human-readable custody timeline
  // Owner/wallet metadata (inherited from records)
  owner?: string;
  walletName?: string;
  seedName?: string;
  // Timestamps
  createdAt: number;
  updatedAt: number;
  // Encryption
  encryptedPayload?: string;
  isEncrypted?: boolean;
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
  // Encryption
  encryptedPayload?: string;
  isEncrypted?: boolean;
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
  // Timestamps
  createdAt: number;
  updatedAt: number;
  // Encryption
  encryptedPayload?: string;
  isEncrypted?: boolean;
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
  // Encrypted fields
  encryptedPayload?: string;
  isEncrypted?: boolean;
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
  dismissed: boolean;
  createdAt: number;
}

// Address blacklist - permanently skip these addresses during sync
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

// Derivation template for optional encrypted xpub storage
// WARNING: Storing xpubs doesn't risk funds but reveals wallet structure and all addresses
export interface DerivationTemplate {
  id?: number;
  // Master fingerprint (8 hex chars) to identify the seed without exposing it
  fingerprint: string;
  // Script type: P2WPKH (native segwit), P2PKH (legacy), P2SH-P2WPKH (wrapped segwit), P2TR (taproot)
  scriptType: 'P2WPKH' | 'P2PKH' | 'P2SH-P2WPKH' | 'P2TR';
  // Derivation path template, e.g., "m/84'/0'/0'" for native segwit
  derivationPath: string;
  // The extended public key (encrypted in encryptedPayload when encryption is enabled)
  xpub?: string;
  // Gap limit for address discovery (default 20)
  gapLimit: number;
  // Network: mainnet or testnet
  network: 'mainnet' | 'testnet';
  // Associated owner (from vocabulary)
  owner?: string;
  // Associated wallet name (from vocabulary)
  walletName?: string;
  // Associated seed name (from vocabulary)
  seedName?: string;
  // Optional notes about this template
  notes?: string;
  // Timestamps
  createdAt: number;
  updatedAt: number;
  // Encrypted payload - contains xpub when encryption is enabled
  encryptedPayload?: string;
  // Flag to indicate if this record is encrypted
  isEncrypted?: boolean;
}
