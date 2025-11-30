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
export type RecordOriginType = 'manual' | 'xpub-derived' | 'bulk-import';

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

// Blockchain transaction data (fetched from blockchain APIs)
export interface BlockchainTransaction {
  id?: number;
  txid: string;           // Transaction ID (hash)
  blockHeight: number;    // Block number where tx was confirmed
  blockTime: number;      // Unix timestamp of block
  fee: number;            // Transaction fee in satoshis
  feeRate: number;        // Fee rate in sats/vB
  syncedAt: number;       // When we fetched this data
  // Note: We don't store confirmations (always increasing) or raw hex (assumed valid)
}

// Transaction participant (input or output)
export interface TransactionParticipant {
  id?: number;
  txid: string;           // Foreign key to BlockchainTransaction
  role: 'input' | 'output';
  address: string;        // Bitcoin address
  amount: number;         // Amount in satoshis
  vout?: number;          // Output index (for outputs)
  // Link to our records table if address exists there
  recordId?: number;
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
  // Last successful connection timestamp
  lastConnectedAt?: number;
  // Connection status message
  lastConnectionStatus?: string;
}

export class KYBTCDatabase extends Dexie {
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

  constructor() {
    super('KYBTCDatabase');
    
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

export const db = new KYBTCDatabase();

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
      };
    } else {
      const tableCols = settings.tableColumns as { owner?: boolean; walletName?: boolean; [key: string]: boolean | undefined };
      if (tableCols.owner === undefined || tableCols.walletName === undefined) {
        needsTableColumnsUpdate = true;
        updates.tableColumns = {
          ...settings.tableColumns,
          owner: tableCols.owner ?? false,
          walletName: tableCols.walletName ?? false,
          source: settings.tableColumns.source ?? false,
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
