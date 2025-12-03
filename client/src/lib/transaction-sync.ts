// Transaction Sync Service
// Syncs blockchain transaction data for addresses in the local database

import { db, type Record, type BlockchainTransaction, type TransactionParticipant, type AddressSyncState, type NodeSettings } from './database';
import { createProvider, createProviderFromSettings, parseTransaction, MINIMUM_CONFIRMATIONS, type ProviderType, type ParsedTransaction, type BlockchainProvider } from './blockchain-api';
import { validateAddress } from './bitcoin';
import { decryptRecords, isEncryptionReady, createRecordOrigin } from './encryptionFacade';

// Legacy source filter type - kept for backwards compatibility
export type SourceFilter = 'manual-only' | 'include-tx-import' | 'include-blockchain-sync' | 'all' | 'custom';

// New granular source selection
export interface SourceSelection {
  selectedSources: Set<string>;  // Set of exact source strings to include
  includeNoSource: boolean;      // Include records with no source field (manual entries)
}

// Source category for grouping in UI
export interface SourceCategory {
  id: string;
  label: string;
  sources: SourceInfo[];
}

// Individual source info
export interface SourceInfo {
  source: string;           // The actual source string (e.g., "Sparrow Wallet", "blockchain-sync")
  displayName: string;      // User-friendly name
  count: number;            // Number of addresses with this source
  category: 'manual' | 'wallet-sync' | 'xpub' | 'blockchain-sync' | 'other';
}

export interface SyncProgress {
  phase: 'idle' | 'fetching-height' | 'syncing-addresses' | 'processing' | 'complete' | 'error';
  currentAddress?: string;
  currentDepth?: number;
  maxDepth?: number;
  addressesTotal: number;
  addressesProcessed: number;
  transactionsFound: number;
  transactionsNew: number;
  newAddressRecords: number;
  error?: string;
}

export interface SyncResult {
  success: boolean;
  addressesSynced: number;
  transactionsImported: number;
  transactionsUpdated: number;
  newAddressRecords: number;
  depthsProcessed: number[];
  errors: string[];
}

export interface SyncOptions {
  sourceFilter: SourceFilter;
  sourceSelection?: SourceSelection;  // Used when sourceFilter is 'custom'
  maxDepth: number; // How many levels deep to sync (1 = only sync depth-0 addresses, 2 = sync depth-0 and discovered depth-1, etc.)
  specificRecordIds?: number[]; // If provided, only sync these specific records (for "Sync Deeper" on individual records)
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

export class TransactionSyncService {
  private provider: BlockchainProvider;
  private onProgress?: SyncProgressCallback;

  constructor(providerType: ProviderType = 'mempool') {
    this.provider = createProvider(providerType);
  }

  // Create a sync service from saved node settings
  static async fromSettings(): Promise<TransactionSyncService> {
    const settings = await db.nodeSettings.get('default');
    const service = new TransactionSyncService();
    
    if (settings) {
      service.provider = createProviderFromSettings(settings);
    }
    
    return service;
  }

  // Update the provider based on new settings
  updateProvider(settings: NodeSettings) {
    this.provider = createProviderFromSettings(settings);
  }

  getProviderName(): string {
    return this.provider.name;
  }

  setProgressCallback(callback: SyncProgressCallback) {
    this.onProgress = callback;
  }

  private updateProgress(progress: Partial<SyncProgress>) {
    if (this.onProgress) {
      this.onProgress(progress as SyncProgress);
    }
  }

  async syncAllAddresses(sourceFilter: SourceFilter = 'manual-only'): Promise<SyncResult> {
    // Legacy method - calls new depth-aware sync with depth=1
    return this.syncWithDepth({
      sourceFilter,
      maxDepth: 1,
    });
  }

  async syncWithDepth(options: SyncOptions): Promise<SyncResult> {
    const { sourceFilter, maxDepth, specificRecordIds } = options;
    
    const result: SyncResult = {
      success: false,
      addressesSynced: 0,
      transactionsImported: 0,
      transactionsUpdated: 0,
      newAddressRecords: 0,
      depthsProcessed: [],
      errors: [],
    };

    try {
      this.updateProgress({
        phase: 'fetching-height',
        currentDepth: 0,
        maxDepth,
        addressesTotal: 0,
        addressesProcessed: 0,
        transactionsFound: 0,
        transactionsNew: 0,
        newAddressRecords: 0,
      });

      const currentHeight = await this.provider.getBlockHeight();
      const minConfirmedHeight = currentHeight - MINIMUM_CONFIRMATIONS;

      // Track which record IDs we've already processed in this sync session
      // This prevents re-enqueuing addresses discovered multiple times
      const processedRecordIds = new Set<number>();
      
      // For "Sync Deeper", we sync one additional layer beyond each record's current maxSyncedDepth
      // This means:
      // 1. First sync the target record itself if not fully synced
      // 2. Then sync all addresses that were discovered from that record (depth = record.syncDepth + 1)
      if (specificRecordIds && specificRecordIds.length > 0) {
        // Get the starting depth from the first specified record
        const allRawRecords = await db.records.toArray();
        let allRecords: Record[];
        if (isEncryptionReady()) {
          allRecords = await decryptRecords(allRawRecords);
        } else {
          allRecords = allRawRecords;
        }
        
        const targetRecords = allRecords.filter(r => 
          r.id && specificRecordIds.includes(r.id) && r.type === 'address'
        );
        
        if (targetRecords.length === 0) {
          this.updateProgress({ phase: 'complete', addressesProcessed: 0 });
          result.success = true;
          return result;
        }
        
        // For ancestry checks, we need to track which IDs are valid ancestors
        // This includes target IDs and any IDs we've actually processed
        // This is separate from processedRecordIds which tracks what NOT to re-sync
        const validAncestorIds = new Set<number>(specificRecordIds);
        
        // For Sync Deeper, we want to process one more depth level
        // Start from the record's syncDepth and go one level beyond its current maxSyncedDepth
        const recordsSyncDepths = targetRecords.map(r => r.syncDepth ?? 0);
        const startDepth = Math.min(...recordsSyncDepths);
        
        // Process from startDepth up to maxDepth (exclusive)
        // maxDepth = N means "sync up to depth N-1"
        // To sync children at depth N, caller passes maxDepth = N+1
        for (let currentDepth = startDepth; currentDepth < maxDepth; currentDepth++) {
          console.log(`[TransactionSync] Sync Deeper: Processing depth ${currentDepth} (max: ${maxDepth})`);
          
          // Refresh records each iteration (new ones may have been discovered)
          const freshRawRecords = await db.records.toArray();
          let freshRecords: Record[];
          if (isEncryptionReady()) {
            freshRecords = await decryptRecords(freshRawRecords);
          } else {
            freshRecords = freshRawRecords;
          }
          
          // First pass: identify records at this depth that are related to our targets
          // This includes both records to sync AND already-synced ancestors
          const relatedRecords = freshRecords.filter(r => {
            if (r.type !== 'address') return false;
            if (!r.id) return false;
            
            const recordDepth = r.syncDepth ?? 0;
            if (recordDepth !== currentDepth) return false;
            
            // For the first iteration, only include target records
            if (currentDepth === startDepth) {
              return specificRecordIds.includes(r.id);
            }
            
            // For deeper levels, include records discovered from valid ancestors
            if (r.discoveredFromRecordId) {
              return validAncestorIds.has(r.discoveredFromRecordId);
            }
            
            return false;
          });
          
          // Add ALL related records (even skipped ones) to validAncestorIds
          // so their children can be synced in subsequent iterations
          for (const r of relatedRecords) {
            if (r.id) {
              validAncestorIds.add(r.id);
            }
          }
          
          // Second pass: filter to only records that need syncing
          const addressesToSync = relatedRecords.filter(r => {
            if (!r.id) return false;
            if (processedRecordIds.has(r.id)) return false;
            
            const maxSyncedDepth = r.maxSyncedDepth ?? -1;
            if (maxSyncedDepth >= currentDepth) return false;
            
            return true;
          });
          
          console.log(`[TransactionSync] Sync Deeper: Found ${addressesToSync.length} addresses at depth ${currentDepth}`);
          
          if (addressesToSync.length === 0) {
            continue;
          }
          
          result.depthsProcessed.push(currentDepth);
          
          // Filter to only valid addresses
          const validAddresses = addressesToSync.filter(r => {
            const validation = validateAddress(r.inputString);
            return validation.isValid;
          });
          
          this.updateProgress({
            phase: 'syncing-addresses',
            currentDepth,
            maxDepth,
            addressesTotal: validAddresses.length,
            addressesProcessed: 0,
          });
          
          for (let i = 0; i < validAddresses.length; i++) {
            const record = validAddresses[i];
            if (!record.id) continue;
            
            processedRecordIds.add(record.id);
            // Also add to validAncestorIds so grandchildren can reference this record
            validAncestorIds.add(record.id);
            
            this.updateProgress({
              phase: 'syncing-addresses',
              currentAddress: record.inputString,
              currentDepth,
              maxDepth,
              addressesProcessed: i,
              addressesTotal: validAddresses.length,
            });
            
            try {
              const syncResult = await this.syncAddress(
                record.inputString,
                record.id,
                minConfirmedHeight,
                currentHeight,
                currentDepth + 1 // Newly discovered addresses will be at depth+1
              );
              result.transactionsImported += syncResult.imported;
              result.transactionsUpdated += syncResult.updated;
              result.newAddressRecords += syncResult.newRecords;
              result.addressesSynced++;
              
              // Mark as synced at this depth
              await db.records.update(record.id, {
                maxSyncedDepth: currentDepth,
                updatedAt: Date.now(),
              });
              
              this.updateProgress({
                transactionsFound: result.transactionsImported + result.transactionsUpdated,
                transactionsNew: result.transactionsImported,
                newAddressRecords: result.newAddressRecords,
              });
            } catch (error) {
              const errorMsg = `Failed to sync ${record.inputString}: ${error instanceof Error ? error.message : 'Unknown error'}`;
              result.errors.push(errorMsg);
              console.error(errorMsg);
            }
          }
        }
        
        // Update the target records' maxSyncedDepth based on ACTUAL progress
        // Only advance if we actually synced something at a new depth
        // This prevents premature exhaustion of depth budget from no-op runs
        if (result.depthsProcessed.length > 0) {
          const deepestActuallySynced = Math.max(...result.depthsProcessed);
          
          for (const targetId of specificRecordIds) {
            const targetRecord = targetRecords.find(r => r.id === targetId);
            if (targetRecord) {
              const currentMax = targetRecord.maxSyncedDepth ?? -1;
              // Only update if we actually synced at a deeper level
              if (deepestActuallySynced > currentMax) {
                await db.records.update(targetId, {
                  maxSyncedDepth: deepestActuallySynced,
                  updatedAt: Date.now(),
                });
                console.log(`[TransactionSync] Updated target record ${targetId} maxSyncedDepth: ${currentMax} -> ${deepestActuallySynced}`);
              }
            }
          }
        }
        
        this.updateProgress({
          phase: 'complete',
          addressesProcessed: result.addressesSynced,
        });
        
        result.success = true;
        return result;
      }

      // Normal sync: Process each depth level from 0 up to maxDepth (exclusive)
      // Depth 0 = manually entered addresses, Depth 1 = first-hop discovered, etc.
      // maxDepth = N means "sync up to depth N-1" (e.g., maxDepth=2 syncs depths 0 and 1)
      for (let currentDepth = 0; currentDepth < maxDepth; currentDepth++) {
        console.log(`[TransactionSync] Processing depth ${currentDepth} (max: ${maxDepth})`);
        
        // Get all records and decrypt them fresh each iteration
        // (new records may have been added in previous depth iterations)
        const allRawRecords = await db.records.toArray();
        
        let allRecords: Record[];
        if (isEncryptionReady()) {
          allRecords = await decryptRecords(allRawRecords);
        } else {
          allRecords = allRawRecords;
        }
        
        // Filter to address records at this depth level that haven't been synced yet
        let addressRecords = allRecords.filter(r => {
          if (r.type !== 'address') return false;
          if (!r.id) return false;
          
          // Skip if we already processed this record in this sync session
          if (processedRecordIds.has(r.id)) return false;
          
          // Check depth - records with syncDepth matching currentDepth should be synced
          const recordDepth = r.syncDepth ?? 0;
          if (recordDepth !== currentDepth) return false;
          
          // Check if already synced at this depth or beyond
          const maxSyncedDepth = r.maxSyncedDepth ?? -1;
          if (maxSyncedDepth >= currentDepth) return false;
          
          // Apply source filter (for depth 0 records)
          if (currentDepth === 0) {
            // Custom source selection mode
            if (sourceFilter === 'custom' && options.sourceSelection) {
              return matchesSourceSelection(r, options.sourceSelection);
            }
            
            // Legacy filter modes
            switch (sourceFilter) {
              case 'manual-only':
                if (r.source === 'blockchain-sync') return false;
                if (r.source?.startsWith('tx-import:')) return false;
                return true;
              case 'include-tx-import':
                if (r.source === 'blockchain-sync') return false;
                return true;
              case 'include-blockchain-sync':
                if (r.source?.startsWith('tx-import:')) return false;
                return true;
              case 'all':
                return true;
              default:
                return true;
            }
          }
          
          return true;
        });
        
        console.log(`[TransactionSync] Found ${addressRecords.length} addresses at depth ${currentDepth} to sync`);

        if (addressRecords.length === 0) {
          continue; // No addresses at this depth, move to next
        }

        result.depthsProcessed.push(currentDepth);

        // Filter to only valid Bitcoin addresses
        const validAddressRecords = addressRecords.filter(record => {
          const validation = validateAddress(record.inputString);
          return validation.isValid;
        });

        const skippedCount = addressRecords.length - validAddressRecords.length;
        if (skippedCount > 0) {
          console.log(`[TransactionSync] Skipping ${skippedCount} records with non-standard address formats`);
        }

        this.updateProgress({
          phase: 'syncing-addresses',
          currentDepth,
          maxDepth,
          addressesTotal: validAddressRecords.length,
          addressesProcessed: 0,
        });

        for (let i = 0; i < validAddressRecords.length; i++) {
          const record = validAddressRecords[i];
          if (!record.id) continue;
          
          const address = record.inputString;

          // Mark as processed to prevent re-enqueuing
          processedRecordIds.add(record.id);

          this.updateProgress({
            phase: 'syncing-addresses',
            currentAddress: address,
            currentDepth,
            maxDepth,
            addressesProcessed: i,
            addressesTotal: validAddressRecords.length,
          });

          try {
            const syncResult = await this.syncAddress(
              address, 
              record.id, 
              minConfirmedHeight, 
              currentHeight,
              currentDepth + 1 // New addresses discovered will be at depth+1
            );
            result.transactionsImported += syncResult.imported;
            result.transactionsUpdated += syncResult.updated;
            result.newAddressRecords += syncResult.newRecords;
            result.addressesSynced++;

            // Mark this record as synced at this depth
            await db.records.update(record.id, {
              maxSyncedDepth: currentDepth,
              updatedAt: Date.now(),
            });

            this.updateProgress({
              transactionsFound: result.transactionsImported + result.transactionsUpdated,
              transactionsNew: result.transactionsImported,
              newAddressRecords: result.newAddressRecords,
            });
          } catch (error) {
            const errorMsg = `Failed to sync ${address}: ${error instanceof Error ? error.message : 'Unknown error'}`;
            result.errors.push(errorMsg);
            console.error(errorMsg);
          }
        }
      }

      this.updateProgress({
        phase: 'complete',
        addressesProcessed: result.addressesSynced,
      });

      result.success = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(errorMsg);
      this.updateProgress({
        phase: 'error',
        error: errorMsg,
      });
    }

    return result;
  }

  private async syncAddress(
    address: string,
    recordId: number,
    minConfirmedHeight: number,
    currentHeight: number,
    newAddressDepth: number = 1 // Depth for newly discovered addresses
  ): Promise<{ imported: number; updated: number; newRecords: number }> {
    const stats = { imported: 0, updated: 0, newRecords: 0 };

    const syncState = await db.addressSyncState.where('address').equals(address).first();

    const apiTransactions = await this.provider.getAddressTransactions(address);

    for (const apiTx of apiTransactions) {
      const parsed = parseTransaction(apiTx);
      
      if (!parsed) continue;

      if (parsed.blockHeight > minConfirmedHeight) {
        continue;
      }

      if (syncState && parsed.blockHeight <= syncState.lastSyncedHeight) {
        continue;
      }

      const existingTx = await db.blockchainTransactions.where('txid').equals(parsed.txid).first();

      if (existingTx) {
        stats.updated++;
        continue;
      }

      await db.blockchainTransactions.add({
        txid: parsed.txid,
        blockHeight: parsed.blockHeight,
        blockTime: parsed.blockTime,
        fee: parsed.fee,
        feeRate: parsed.feeRate,
        syncedAt: Date.now(),
      });
      stats.imported++;

      for (const input of parsed.inputs) {
        const { recordId: inputRecordId, isNew } = await this.findOrCreateAddressRecord(
          input.address, 
          newAddressDepth,
          parsed.txid,
          recordId
        );
        if (isNew) stats.newRecords++;

        await db.transactionParticipants.add({
          txid: parsed.txid,
          role: 'input',
          address: input.address,
          amount: input.amount,
          recordId: inputRecordId,
        });
      }

      for (const output of parsed.outputs) {
        const { recordId: outputRecordId, isNew } = await this.findOrCreateAddressRecord(
          output.address,
          newAddressDepth,
          parsed.txid,
          recordId
        );
        if (isNew) stats.newRecords++;

        await db.transactionParticipants.add({
          txid: parsed.txid,
          role: 'output',
          address: output.address,
          amount: output.amount,
          vout: output.vout,
          recordId: outputRecordId,
        });
      }
    }

    const txCount = apiTransactions.filter(tx => {
      const parsed = parseTransaction(tx);
      return parsed && parsed.blockHeight <= minConfirmedHeight;
    }).length;

    if (syncState) {
      await db.addressSyncState.update(syncState.id!, {
        lastSyncedHeight: currentHeight,
        lastSyncedAt: Date.now(),
        txCount,
      });
    } else {
      await db.addressSyncState.add({
        address,
        recordId,
        lastSyncedHeight: currentHeight,
        lastSyncedAt: Date.now(),
        txCount,
      });
    }

    return stats;
  }

  private async findOrCreateAddressRecord(
    address: string,
    syncDepth: number = 1,
    discoveredInTxid?: string,
    discoveredFromRecordId?: number
  ): Promise<{ recordId: number; isNew: boolean }> {
    const existing = await db.records.where('inputString').equals(address).first();
    
    if (existing && existing.id) {
      return { recordId: existing.id, isNew: false };
    }

    // Look up parent record to inherit context (but NOT owner - discovered addresses need review)
    let parentWalletName: string | undefined;
    let parentSeedName: string | undefined;
    let parentWalletSoftware: string | undefined;
    
    if (discoveredFromRecordId) {
      const parentRecord = await db.records.get(discoveredFromRecordId);
      if (parentRecord) {
        // Inherit context fields for classification help, but NOT owner
        // (discovered addresses could be counterparties)
        parentWalletName = parentRecord.walletName;
        parentSeedName = parentRecord.seedName;
        parentWalletSoftware = parentRecord.walletSoftware;
      }
    }

    const now = Date.now();
    const newRecordId = await db.records.add({
      type: 'address',
      inputString: address,
      label: '',
      tags: [],
      categories: [],
      owner: 'Pending Review',
      source: 'blockchain-sync',
      syncDepth,
      maxSyncedDepth: -1, // Not yet synced
      discoveredInTxid,
      discoveredFromRecordId,
      addressImportance: 'blockchain-discovered', // Lowest importance tier for discovered addresses
      // Inherit context from parent for classification help
      walletName: parentWalletName,
      seedName: parentSeedName,
      walletSoftware: parentWalletSoftware,
      createdAt: now,
      updatedAt: now,
    });

    // Create a record origin entry to track blockchain sync source
    if (isEncryptionReady()) {
      try {
        await createRecordOrigin({
          recordId: newRecordId,
          originType: 'blockchain-sync',
          source: 'blockchain-sync',
          owner: 'Pending Review',
          walletName: parentWalletName,
          seedName: parentSeedName,
          walletSoftware: parentWalletSoftware,
        });
      } catch (originError) {
        console.error('[TransactionSync] Failed to create record origin:', originError);
        // Don't fail the record creation if origin creation fails
      }
    }

    return { recordId: newRecordId, isNew: true };
  }

  async getStats(): Promise<{
    totalAddresses: number;
    syncedAddresses: number;
    totalTransactions: number;
    lastSyncTime: number | null;
  }> {
    const totalAddresses = await db.records.where('type').equals('address').count();
    const syncedAddresses = await db.addressSyncState.count();
    const totalTransactions = await db.blockchainTransactions.count();
    
    const lastSync = await db.addressSyncState.orderBy('lastSyncedAt').reverse().first();
    
    return {
      totalAddresses,
      syncedAddresses,
      totalTransactions,
      lastSyncTime: lastSync?.lastSyncedAt || null,
    };
  }

  async getTransactionsForAddress(address: string): Promise<Array<{
    transaction: BlockchainTransaction;
    role: 'input' | 'output';
    amount: number;
  }>> {
    const participants = await db.transactionParticipants
      .where('address')
      .equals(address)
      .toArray();

    const results: Array<{
      transaction: BlockchainTransaction;
      role: 'input' | 'output';
      amount: number;
    }> = [];

    for (const participant of participants) {
      const tx = await db.blockchainTransactions
        .where('txid')
        .equals(participant.txid)
        .first();
      
      if (tx) {
        results.push({
          transaction: tx,
          role: participant.role,
          amount: participant.amount,
        });
      }
    }

    results.sort((a, b) => b.transaction.blockTime - a.transaction.blockTime);

    return results;
  }

  async getPendingReviewAddresses(): Promise<Record[]> {
    return db.records
      .where('owner')
      .equals('Pending Review')
      .toArray();
  }
}

export const transactionSyncService = new TransactionSyncService();

// Helper function to scan all address records and categorize their sources
export async function getAddressSources(): Promise<SourceCategory[]> {
  const allRawRecords = await db.records.where('type').equals('address').toArray();
  
  let allRecords: Record[];
  if (isEncryptionReady()) {
    allRecords = await decryptRecords(allRawRecords);
  } else {
    allRecords = allRawRecords;
  }
  
  // Count occurrences of each source
  const sourceCounts = new Map<string, number>();
  let noSourceCount = 0;
  
  for (const record of allRecords) {
    const source = record.source;
    if (!source || source === 'manual' || source === '') {
      noSourceCount++;
    } else {
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    }
  }
  
  // Categorize each source
  const sourceInfos: SourceInfo[] = [];
  
  // Add "No source / Manual" entry if there are any
  if (noSourceCount > 0) {
    sourceInfos.push({
      source: '__no_source__',
      displayName: 'Manual Entry (no source)',
      count: noSourceCount,
      category: 'manual',
    });
  }
  
  for (const [source, count] of Array.from(sourceCounts.entries())) {
    let category: SourceInfo['category'] = 'other';
    let displayName = source;
    
    // Categorize based on source patterns
    if (source === 'blockchain-sync') {
      category = 'blockchain-sync';
      displayName = 'Blockchain Sync';
    } else if (source.startsWith('tx-import:')) {
      category = 'blockchain-sync';
      displayName = source.replace('tx-import:', 'TX Import: ');
    } else if (source.includes('xpub') || source.includes('zpub') || source.includes('ypub')) {
      category = 'xpub';
      displayName = source;
    } else if (source.includes('Wallet') || source.includes('wallet')) {
      category = 'wallet-sync';
      displayName = source;
    } else if (
      source === 'Sparrow' || 
      source === 'Trezor' || 
      source === 'Ledger' || 
      source === 'Electrum' ||
      source === 'Blue Wallet' ||
      source === 'Wasabi' ||
      source === 'Samourai' ||
      source === 'Specter' ||
      source === 'Mycelium' ||
      source.includes('BIP-329')
    ) {
      category = 'wallet-sync';
      displayName = source;
    } else {
      // Try to infer category from common patterns
      if (source.includes(';')) {
        // Multiple sources merged - take the first one for categorization
        category = 'wallet-sync';
      } else {
        category = 'other';
      }
    }
    
    sourceInfos.push({
      source,
      displayName,
      count,
      category,
    });
  }
  
  // Group by category
  const categoryMap = new Map<string, SourceInfo[]>();
  for (const info of sourceInfos) {
    const existing = categoryMap.get(info.category) || [];
    existing.push(info);
    categoryMap.set(info.category, existing);
  }
  
  // Build result with nice labels, sorted by count within each category
  const categories: SourceCategory[] = [];
  
  const categoryLabels: { [key: string]: string } = {
    'manual': 'Manual Entries',
    'wallet-sync': 'Wallet Imports',
    'xpub': 'xPub Derived',
    'blockchain-sync': 'Blockchain Discovered',
    'other': 'Other Sources',
  };
  
  const categoryOrder = ['manual', 'wallet-sync', 'xpub', 'blockchain-sync', 'other'];
  
  for (const catId of categoryOrder) {
    const sources = categoryMap.get(catId);
    if (sources && sources.length > 0) {
      // Sort by count descending
      sources.sort((a, b) => b.count - a.count);
      categories.push({
        id: catId,
        label: categoryLabels[catId] || catId,
        sources,
      });
    }
  }
  
  return categories;
}

// Helper to check if a record matches the source selection
export function matchesSourceSelection(record: Record, selection: SourceSelection): boolean {
  const source = record.source;
  
  // Check for no-source records
  if (!source || source === 'manual' || source === '') {
    return selection.includeNoSource;
  }
  
  // Check if this exact source is selected
  return selection.selectedSources.has(source);
}

// Convert legacy SourceFilter to SourceSelection (for backwards compatibility)
export function legacyFilterToSelection(filter: SourceFilter, allSources: SourceCategory[]): SourceSelection {
  const selection: SourceSelection = {
    selectedSources: new Set<string>(),
    includeNoSource: false,
  };
  
  // Flatten all sources for easier lookup
  const allSourceInfos: SourceInfo[] = [];
  for (const cat of allSources) {
    allSourceInfos.push(...cat.sources);
  }
  
  switch (filter) {
    case 'manual-only':
      // Include manual, wallet-sync, xpub - exclude blockchain-sync and tx-import
      for (const info of allSourceInfos) {
        if (info.category === 'manual') {
          if (info.source === '__no_source__') {
            selection.includeNoSource = true;
          } else {
            selection.selectedSources.add(info.source);
          }
        } else if (info.category === 'wallet-sync' || info.category === 'xpub' || info.category === 'other') {
          selection.selectedSources.add(info.source);
        }
        // Exclude blockchain-sync category
      }
      break;
      
    case 'include-tx-import':
      // Include everything except blockchain-sync
      for (const info of allSourceInfos) {
        if (info.category === 'manual') {
          if (info.source === '__no_source__') {
            selection.includeNoSource = true;
          } else {
            selection.selectedSources.add(info.source);
          }
        } else if (info.category !== 'blockchain-sync' || info.source.startsWith('tx-import:')) {
          selection.selectedSources.add(info.source);
        }
      }
      break;
      
    case 'include-blockchain-sync':
      // Include everything except tx-import
      for (const info of allSourceInfos) {
        if (info.category === 'manual') {
          if (info.source === '__no_source__') {
            selection.includeNoSource = true;
          } else {
            selection.selectedSources.add(info.source);
          }
        } else if (!info.source.startsWith('tx-import:')) {
          selection.selectedSources.add(info.source);
        }
      }
      break;
      
    case 'all':
    case 'custom':
      // Include everything
      for (const info of allSourceInfos) {
        if (info.source === '__no_source__') {
          selection.includeNoSource = true;
        } else {
          selection.selectedSources.add(info.source);
        }
      }
      break;
  }
  
  return selection;
}
