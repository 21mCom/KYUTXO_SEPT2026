// Transaction Sync Service
// Syncs blockchain transaction data for addresses in the local database

import { db, notifyDbChange, type Record, type BlockchainTransaction, type TransactionParticipant, type AddressSyncState, type NodeSettings, type PausedSyncState } from './database';
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
  source: string;           // The display/grouped source name (e.g., "Sparrow Wallet", "NamaDompet")
  displayName: string;      // User-friendly name
  count: number;            // Number of addresses with this source
  category: 'manual' | 'wallet-sync' | 'xpub' | 'blockchain-sync' | 'other';
  rawSources?: string[];    // All raw source strings that map to this grouped source (e.g., ["NamaDompet (0/0)", "NamaDompet (0/1)"])
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

export interface ResumeContext {
  completedRecordIds: Set<number>;  // Record IDs already processed before pause
  previousResult: {                  // Stats from before pause
    transactionsImported: number;
    transactionsUpdated: number;
    newAddressRecords: number;
    addressesSynced: number;
  };
  resumeFromDepth: number;           // Depth level to resume from
}

export interface SyncOptions {
  sourceFilter: SourceFilter;
  sourceSelection?: SourceSelection;  // Used when sourceFilter is 'custom'
  maxDepth: number; // How many levels deep to sync (1 = only sync depth-0 addresses, 2 = sync depth-0 and discovered depth-1, etc.)
  specificRecordIds?: number[]; // If provided, only sync these specific records (for "Sync Deeper" on individual records)
  resumeContext?: ResumeContext;     // If provided, resume from paused state
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

export class TransactionSyncService {
  private provider: BlockchainProvider;
  private onProgress?: SyncProgressCallback;
  private cancelled: boolean = false;
  private pauseRequested: boolean = false;
  private currentProgress: SyncProgress = {
    phase: 'idle',
    addressesTotal: 0,
    addressesProcessed: 0,
    transactionsFound: 0,
    transactionsNew: 0,
    newAddressRecords: 0,
  };
  
  // Track current sync state for pause functionality
  private currentSyncState: {
    sourceSelection?: SourceSelection;
    maxDepth: number;
    currentDepth: number;
    allAddressRecordIds: number[];
    processedIndex: number;
  } | null = null;

  constructor(providerType: ProviderType = 'mempool') {
    this.provider = createProvider(providerType);
  }

  // Stop the current sync operation (does not save state)
  stopSync() {
    this.cancelled = true;
    this.pauseRequested = false;
    console.log('[TransactionSync] Stop requested');
  }
  
  // Request pause and save state for resume
  requestPause() {
    this.cancelled = true;
    this.pauseRequested = true;
    console.log('[TransactionSync] Pause requested');
  }
  
  // Check if pause was requested (vs stop)
  isPauseRequested(): boolean {
    return this.pauseRequested;
  }

  // Check if sync was cancelled (for external use)
  isCancelled(): boolean {
    return this.cancelled;
  }

  // Pause sync and save state for resuming later
  async pauseSync(
    remainingRecordIds: number[],
    completedRecordIds: number[],
    sourceSelection: SourceSelection,
    maxDepth: number,
    currentDepth: number,
    result: SyncResult
  ): Promise<void> {
    this.cancelled = true;
    console.log('[TransactionSync] Pause requested - saving state');
    
    const pausedState: PausedSyncState = {
      id: 'default',
      pausedAt: Date.now(),
      remainingRecordIds,
      completedRecordIds,
      sourceSelection: {
        selectedSources: Array.from(sourceSelection.selectedSources),
        includeNoSource: sourceSelection.includeNoSource,
      },
      maxDepth,
      currentDepth,
      transactionsImported: result.transactionsImported,
      transactionsUpdated: result.transactionsUpdated,
      newAddressRecords: result.newAddressRecords,
      addressesSynced: result.addressesSynced,
    };
    
    await db.pausedSyncState.put(pausedState);
    console.log(`[TransactionSync] Saved paused state: ${remainingRecordIds.length} addresses remaining`);
  }

  // Get paused sync state
  async getPausedState(): Promise<PausedSyncState | undefined> {
    return db.pausedSyncState.get('default');
  }

  // Clear paused sync state (when sync completes or user cancels resume)
  async clearPausedState(): Promise<void> {
    await db.pausedSyncState.delete('default');
    console.log('[TransactionSync] Cleared paused state');
  }

  // Resume sync from paused state
  async resumeSync(): Promise<SyncResult> {
    const pausedState = await this.getPausedState();
    
    if (!pausedState) {
      return {
        success: false,
        addressesSynced: 0,
        transactionsImported: 0,
        transactionsUpdated: 0,
        newAddressRecords: 0,
        depthsProcessed: [],
        errors: ['No paused sync state found'],
      };
    }
    
    console.log(`[TransactionSync] Resuming sync: ${pausedState.remainingRecordIds.length} addresses remaining`);
    
    // Convert stored array back to Set
    const sourceSelection: SourceSelection = {
      selectedSources: new Set(pausedState.sourceSelection.selectedSources),
      includeNoSource: pausedState.sourceSelection.includeNoSource,
    };
    
    // DON'T clear paused state before resuming - only clear on success
    // This preserves state if resume fails early
    
    // Resume with the remaining addresses using specificRecordIds path
    // This syncs just the remaining addresses directly
    const result = await this.syncWithDepth({
      sourceFilter: 'custom',
      sourceSelection,
      maxDepth: pausedState.maxDepth,
      specificRecordIds: pausedState.remainingRecordIds,
      resumeContext: {
        completedRecordIds: new Set(pausedState.completedRecordIds),
        previousResult: {
          transactionsImported: pausedState.transactionsImported,
          transactionsUpdated: pausedState.transactionsUpdated,
          newAddressRecords: pausedState.newAddressRecords,
          addressesSynced: pausedState.addressesSynced,
        },
        resumeFromDepth: pausedState.currentDepth,
      },
    });
    
    // Only clear paused state if sync completed successfully (not paused again)
    if (result.success && !this.pauseRequested) {
      await this.clearPausedState();
    }
    
    return result;
  }

  // Create a sync service from saved node settings
  static async fromSettings(): Promise<TransactionSyncService> {
    const settings = await db.nodeSettings.get('default');
    const service = new TransactionSyncService();
    
    if (settings) {
      service.provider = createProviderFromSettings(settings);
      console.log(`[TransactionSync] Initialized with provider: ${service.provider.name}`);
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

  private resetProgress() {
    this.currentProgress = {
      phase: 'idle',
      addressesTotal: 0,
      addressesProcessed: 0,
      transactionsFound: 0,
      transactionsNew: 0,
      newAddressRecords: 0,
    };
  }

  private updateProgress(progress: Partial<SyncProgress>) {
    // Merge partial updates with current progress to maintain cumulative state
    this.currentProgress = { ...this.currentProgress, ...progress };
    if (this.onProgress) {
      this.onProgress(this.currentProgress);
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
    const { sourceFilter, maxDepth, specificRecordIds, resumeContext } = options;
    
    // Reset progress counters and cancellation flags at the start of each sync
    this.resetProgress();
    this.cancelled = false;
    this.pauseRequested = false;
    
    // Initialize result with previous values if resuming
    const result: SyncResult = {
      success: false,
      addressesSynced: resumeContext?.previousResult?.addressesSynced ?? 0,
      transactionsImported: resumeContext?.previousResult?.transactionsImported ?? 0,
      transactionsUpdated: resumeContext?.previousResult?.transactionsUpdated ?? 0,
      newAddressRecords: resumeContext?.previousResult?.newAddressRecords ?? 0,
      depthsProcessed: [],
      errors: [],
    };
    
    // Initialize progress with resume values if available
    const initialTransactionsNew = resumeContext?.previousResult?.transactionsImported ?? 0;
    const initialNewAddresses = resumeContext?.previousResult?.newAddressRecords ?? 0;

    try {
      this.updateProgress({
        phase: 'fetching-height',
        currentDepth: resumeContext?.resumeFromDepth ?? 0,
        maxDepth,
        addressesTotal: 0,
        addressesProcessed: 0,
        transactionsFound: initialTransactionsNew,
        transactionsNew: initialTransactionsNew,
        newAddressRecords: initialNewAddresses,
      });

      const currentHeight = await this.provider.getBlockHeight();
      const minConfirmedHeight = currentHeight - MINIMUM_CONFIRMATIONS;

      // Track which record IDs we've already processed in this sync session
      // Initialize from resumeContext if available (prevents reprocessing completed addresses)
      const processedRecordIds = new Set<number>(resumeContext?.completedRecordIds ?? []);
      
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
          
          // Get all valid record IDs for pause state saving
          const allValidRecordIds = validAddresses.map(r => r.id).filter((id): id is number => id !== undefined);
          
          for (let i = 0; i < validAddresses.length; i++) {
            // Check for cancellation before processing each address
            if (this.cancelled) {
              console.log('[TransactionSync] Sync cancelled by user');
              
              // Handle pause vs stop (same logic as normal sync path)
              if (this.pauseRequested) {
                const remainingIds = allValidRecordIds.slice(i);
                const completedIds = Array.from(processedRecordIds);
                const sourceSelection = options.sourceSelection || {
                  selectedSources: new Set<string>(),
                  includeNoSource: true,
                };
                
                await this.pauseSync(
                  remainingIds,
                  completedIds,
                  sourceSelection,
                  maxDepth,
                  currentDepth,
                  result
                );
                console.log(`[TransactionSync] Sync Deeper paused - saved ${remainingIds.length} remaining addresses`);
              } else {
                console.log('[TransactionSync] Sync Deeper stopped by user (not paused)');
              }
              
              this.updateProgress({ phase: 'complete' });
              result.success = true; // Partial success - what we synced is valid
              return result;
            }

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
        
        console.log(`[TransactionSync] Found ${addressRecords.length} addresses at depth ${currentDepth} to sync (filter: ${sourceFilter})`);
        if (sourceFilter === 'custom' && options.sourceSelection) {
          console.log(`[TransactionSync] Custom filter active - ${options.sourceSelection.selectedSources.size} source(s) selected, includeNoSource: ${options.sourceSelection.includeNoSource}`);
        }

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

        // Track all valid record IDs for this depth level for pause/resume
        const allValidRecordIds = validAddressRecords.map(r => r.id!).filter(id => id !== undefined);
        
        for (let i = 0; i < validAddressRecords.length; i++) {
          // Check for cancellation before processing each address
          if (this.cancelled) {
            // If pause was requested, save state for resume
            if (this.pauseRequested) {
              const remainingIds = allValidRecordIds.slice(i); // IDs not yet processed at this depth
              const completedIds = Array.from(processedRecordIds);
              const sourceSelection = options.sourceSelection || {
                selectedSources: new Set<string>(),
                includeNoSource: true,
              };
              
              await this.pauseSync(
                remainingIds,
                completedIds,
                sourceSelection,
                maxDepth,
                currentDepth,
                result
              );
              console.log(`[TransactionSync] Paused - saved ${remainingIds.length} remaining addresses`);
            } else {
              console.log('[TransactionSync] Sync stopped by user (not paused)');
            }
            
            this.updateProgress({ phase: 'complete' });
            result.success = true; // Partial success - what we synced is valid
            return result;
          }

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

      // Note: Paused state is managed by resumeSync() - don't clear here
      // as that would race with pause requests
      
      result.success = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(errorMsg);
      this.updateProgress({
        phase: 'error',
        error: errorMsg,
      });
    } finally {
      // Reset pause flag
      this.pauseRequested = false;
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
        size: parsed.size,
        weight: parsed.weight,
        vsize: parsed.vsize,
        hasOpReturn: parsed.hasOpReturn,
        opReturnData: parsed.opReturnData.length > 0 ? parsed.opReturnData : undefined,
      });
      stats.imported++;

      // Create a transaction record in the records table so it appears in Records view
      // Transaction depth = the address's depth (newAddressDepth - 1)
      // Depth 0 = directly involves tracked addresses, depth 1+ = involves discovered addresses
      const txSyncDepth = Math.max(0, newAddressDepth - 1);
      const { isNew: isTxRecordNew } = await this.findOrCreateTransactionRecord(parsed.txid, parsed.blockTime, txSyncDepth, recordId);
      if (isTxRecordNew) stats.newRecords++;

      // Update the parent address's firstSeenBlockTime if this tx is older
      await this.updateFirstSeenBlockTime(recordId, parsed.blockTime);

      for (const input of parsed.inputs) {
        const { recordId: inputRecordId, isNew } = await this.findOrCreateAddressRecord(
          input.address, 
          newAddressDepth,
          parsed.txid,
          recordId
        );
        if (isNew) stats.newRecords++;

        // Update address firstSeenBlockTime if this tx is older
        await this.updateFirstSeenBlockTime(inputRecordId, parsed.blockTime);

        await db.transactionParticipants.add({
          txid: parsed.txid,
          role: 'input',
          address: input.address,
          amount: input.amount,
          recordId: inputRecordId,
          scriptType: input.scriptType,
          prevTxid: input.prevTxid,   // The txid of the UTXO being spent
          prevVout: input.prevVout,   // The vout of the UTXO being spent
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

        // Update address firstSeenBlockTime if this tx is older
        await this.updateFirstSeenBlockTime(outputRecordId, parsed.blockTime);

        await db.transactionParticipants.add({
          txid: parsed.txid,
          role: 'output',
          address: output.address,
          amount: output.amount,
          vout: output.vout,
          recordId: outputRecordId,
          scriptType: output.scriptType,
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

    // Notify listeners of transaction and participant changes (once per sync operation)
    if (stats.imported > 0) {
      notifyDbChange(['transactionParticipants', 'blockchainTransactions']);
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

    // Notify listeners of the change
    notifyDbChange('records');

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

  // Update an address record's firstSeenBlockTime if this transaction is older
  // Only updates if blockTime is earlier than current value (or if not set)
  private async updateFirstSeenBlockTime(recordId: number, blockTime: number): Promise<void> {
    const record = await db.records.get(recordId);
    if (!record) return;

    // Only update if this transaction is older than current firstSeenBlockTime
    // or if firstSeenBlockTime is not set
    if (!record.firstSeenBlockTime || blockTime < record.firstSeenBlockTime) {
      await db.records.update(recordId, {
        firstSeenBlockTime: blockTime,
        updatedAt: Date.now(),
      });
    }
  }

  // Find or create a transaction record in the records table
  // This ensures synced transactions appear in the Records view
  // syncDepth indicates how "close" this transaction is to tracked addresses:
  //   0 = directly involves a tracked address
  //   1+ = involves addresses discovered N hops away
  private async findOrCreateTransactionRecord(
    txid: string,
    blockTime: number,
    syncDepth: number,
    discoveredFromRecordId?: number
  ): Promise<{ recordId: number; isNew: boolean }> {
    // Check if a transaction record already exists for this txid
    // Scope to type='transaction' to avoid collisions with address records
    const existing = await db.records
      .where('inputString').equals(txid)
      .and(r => r.type === 'transaction')
      .first();
    
    if (existing && existing.id) {
      return { recordId: existing.id, isNew: false };
    }

    // Look up parent record to inherit context
    let parentWalletName: string | undefined;
    let parentSeedName: string | undefined;
    let parentWalletSoftware: string | undefined;
    let parentOwner: string | undefined;
    
    if (discoveredFromRecordId) {
      const parentRecord = await db.records.get(discoveredFromRecordId);
      if (parentRecord) {
        parentWalletName = parentRecord.walletName;
        parentSeedName = parentRecord.seedName;
        parentWalletSoftware = parentRecord.walletSoftware;
        parentOwner = parentRecord.owner;
      }
    }

    const now = Date.now();
    const newRecordId = await db.records.add({
      type: 'transaction',
      inputString: txid,
      label: '',
      tags: [],
      categories: [],
      owner: parentOwner || 'Pending Review',
      source: 'blockchain-sync',
      syncDepth, // Track how close this tx is to tracked addresses
      discoveredFromRecordId,
      // Store blockTime in date field (formatted as ISO string)
      date: new Date(blockTime * 1000).toISOString().split('T')[0],
      // Store block time for sorting (Unix seconds)
      firstSeenBlockTime: blockTime,
      // Inherit context from parent
      walletName: parentWalletName,
      seedName: parentSeedName,
      walletSoftware: parentWalletSoftware,
      createdAt: now,
      updatedAt: now,
    });

    // Notify listeners of the change
    notifyDbChange('records');

    // Create a record origin entry to track blockchain sync source
    if (isEncryptionReady()) {
      try {
        await createRecordOrigin({
          recordId: newRecordId,
          originType: 'blockchain-sync',
          source: 'blockchain-sync',
          owner: parentOwner || 'Pending Review',
          walletName: parentWalletName,
          seedName: parentSeedName,
          walletSoftware: parentWalletSoftware,
        });
      } catch (originError) {
        console.error('[TransactionSync] Failed to create transaction record origin:', originError);
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

  /**
   * Get count of depth-0 addresses that match the current filter options.
   * This shows how many root addresses will be synced based on selection.
   * Note: Additional addresses may be discovered during sync at higher depths.
   */
  async getFilteredAddressCount(options: SyncOptions): Promise<number> {
    const { sourceFilter, sourceSelection } = options;
    
    const allRawRecords = await db.records.where('type').equals('address').toArray();
    
    let allRecords: Record[];
    if (isEncryptionReady()) {
      allRecords = await decryptRecords(allRawRecords);
    } else {
      allRecords = allRawRecords;
    }
    
    // Count only depth-0 addresses that match the filter
    // These are the root addresses controlled by the source filter
    let count = 0;
    
    for (const r of allRecords) {
      if (r.type !== 'address') continue;
      if (!r.id) continue;
      
      // Only count depth-0 (root) addresses 
      const recordDepth = r.syncDepth ?? 0;
      if (recordDepth !== 0) continue;
      
      // Apply source filter using the shared helper
      if (sourceFilter === 'custom' && sourceSelection) {
        if (!matchesSourceSelection(r, sourceSelection)) {
          continue;
        }
      } else {
        // Legacy filter modes
        switch (sourceFilter) {
          case 'manual-only':
            if (r.source === 'blockchain-sync') continue;
            if (r.source?.startsWith('tx-import:')) continue;
            break;
          case 'include-tx-import':
            if (r.source === 'blockchain-sync') continue;
            break;
          case 'include-blockchain-sync':
            if (r.source?.startsWith('tx-import:')) continue;
            break;
          case 'all':
          default:
            break;
        }
      }
      
      // Validate address format
      const validation = validateAddress(r.inputString);
      if (validation.isValid) {
        count++;
      }
    }
    
    return count;
  }
}

export const transactionSyncService = new TransactionSyncService();

// Extract base wallet name from sources that contain derivation paths
// e.g., "NamaDompet (0/1)" -> "NamaDompet", "Sparrow (m/84'/0'/0'/0/5)" -> "Sparrow"
function extractBaseWalletName(source: string): string {
  // Match patterns like "Name (derivation)" where derivation contains:
  // - Numbers, slashes, apostrophes for BIP paths: m/84'/0'/0'/0/5
  // - Uppercase M for some path notations
  // - Hyphens, commas, spaces in descriptors
  // Common patterns: (0/1), (m/84'/0'/0'/0/5), (0/0), (M/49H/0H/0H), etc.
  const match = source.match(/^(.+?)\s*\([0-9mM/'hH,\s\-]+\)$/);
  if (match) {
    return match[1].trim();
  }
  return source;
}

// Helper function to scan all address records and categorize their sources
export async function getAddressSources(): Promise<SourceCategory[]> {
  const allRawRecords = await db.records.where('type').equals('address').toArray();
  
  let allRecords: Record[];
  if (isEncryptionReady()) {
    allRecords = await decryptRecords(allRawRecords);
  } else {
    allRecords = allRawRecords;
  }
  
  // First pass: count raw sources and track which base names they map to
  const rawSourceCounts = new Map<string, number>();
  const baseNameToRawSources = new Map<string, Set<string>>();
  let noSourceCount = 0;
  
  for (const record of allRecords) {
    const source = record.source;
    if (!source || source === 'manual' || source === '') {
      noSourceCount++;
    } else {
      rawSourceCounts.set(source, (rawSourceCounts.get(source) || 0) + 1);
      
      // Track base name grouping
      const baseName = extractBaseWalletName(source);
      if (!baseNameToRawSources.has(baseName)) {
        baseNameToRawSources.set(baseName, new Set());
      }
      baseNameToRawSources.get(baseName)!.add(source);
    }
  }
  
  // Second pass: group sources by base name when multiple derivation variants exist
  // Each grouped source will have 'rawSources' property listing all the underlying sources
  const groupedSourceCounts = new Map<string, { count: number; rawSources: string[] }>();
  
  for (const [baseName, rawSources] of Array.from(baseNameToRawSources.entries())) {
    const rawSourcesArray = Array.from(rawSources);
    
    // If there are multiple sources with the same base name (derivation variants), group them
    if (rawSourcesArray.length > 1) {
      let totalCount = 0;
      for (const rawSource of rawSourcesArray) {
        totalCount += rawSourceCounts.get(rawSource) || 0;
      }
      groupedSourceCounts.set(baseName, { count: totalCount, rawSources: rawSourcesArray });
    } else {
      // Single source, use it directly
      const rawSource = rawSourcesArray[0];
      const count = rawSourceCounts.get(rawSource) || 0;
      groupedSourceCounts.set(rawSource, { count, rawSources: [rawSource] });
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
      rawSources: ['__no_source__'],
    });
  }
  
  // Helper to categorize a source string
  const categorizeSource = (source: string): SourceInfo['category'] => {
    if (source === 'blockchain-sync') {
      return 'blockchain-sync';
    } else if (source.startsWith('tx-import:')) {
      return 'blockchain-sync';
    } else if (source.includes('xpub') || source.includes('zpub') || source.includes('ypub')) {
      return 'xpub';
    } else if (source.includes('Wallet') || source.includes('wallet')) {
      return 'wallet-sync';
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
      source.includes('BIP-329') ||
      source.includes(';')  // Multiple sources merged
    ) {
      return 'wallet-sync';
    }
    // Sources with derivation paths in parentheses are likely wallet imports
    // e.g., "NamaDompet (0/1)", "MyWallet (m/84'/0'/0'/0/5)"
    if (/\([0-9mM/'hH,\s\-]+\)$/.test(source)) {
      return 'wallet-sync';
    }
    return 'other';
  };
  
  for (const [displaySource, { count, rawSources }] of Array.from(groupedSourceCounts.entries())) {
    let displayName = displaySource;
    
    // Categorize based on raw sources first - use first raw source to determine category
    // This preserves category even when sources are grouped by base name (e.g., "NamaDompet" from "NamaDompet (0/1)")
    const representativeSource = rawSources[0];
    let category = categorizeSource(representativeSource);
    
    // Also check the display source in case it matches known patterns
    const displayCategory = categorizeSource(displaySource);
    if (displayCategory !== 'other') {
      category = displayCategory;
    }
    
    // Set display name for special cases
    if (displaySource === 'blockchain-sync') {
      displayName = 'Blockchain Sync';
    } else if (displaySource.startsWith('tx-import:')) {
      displayName = displaySource.replace('tx-import:', 'TX Import: ');
    }
    
    sourceInfos.push({
      source: displaySource,  // Use the display/grouped name as the key
      displayName,
      count,
      category,
      rawSources,  // Store all raw sources that map to this grouped source
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
