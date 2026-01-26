import Dexie, { type Table } from 'dexie';

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
  // Trusted local hosts whitelist (for local network connections without Tor)
  trustedLocalHosts: string[];  // User-editable whitelist of allowed local IPs/hostnames
  // Last successful connection timestamp
  lastConnectedAt?: number;
  // Connection status message
  lastConnectionStatus?: string;
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

  constructor() {
    super('KYUTXODatabase');
    
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
