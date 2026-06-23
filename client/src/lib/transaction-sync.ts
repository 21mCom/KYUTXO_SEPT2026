// Transaction Sync Service
// Syncs blockchain transaction data for addresses in the local database

import { db, notifyDbChange, type Record, type BlockchainTransaction, type TransactionParticipant, type AddressSyncState, type NodeSettings, type PausedSyncState, type SkippedAddress, type AddressBlacklist, type SyncProtectionSettings, DEFAULT_SYNC_PROTECTION } from './database';
import { createProvider, createProviderFromSettings, parseTransaction, MINIMUM_CONFIRMATIONS, type ProviderType, type ParsedTransaction, type BlockchainProvider, type ApiTransaction } from './blockchain-api';
import { validateAddress } from './bitcoin';
import {
  createRecord,
  createRecordOrigin,
  updateRecord,
  addTransaction,
  bulkAddParticipants,
  bulkPutParticipants,
  addSkippedAddress,
  updateSkippedAddress,
  dismissAllSkippedAddresses,
  getSkippedAddressesByRun,
  getActiveSkippedAddresses,
  getBlacklistEntryByAddress,
  isAddressBlacklisted,
  addToBlacklist as addToBlacklistCrud,
  removeFromBlacklistByAddress,
  getAllBlacklist,
  getPausedSyncState,
  putPausedSyncState,
  deletePausedSyncState,
  getAddressSyncStateByAddress,
  addAddressSyncState,
  updateAddressSyncState,
  countAddressSyncState,
  getLatestAddressSyncState,
  getNodeSettings,
} from './dataFacade';
import { recomputeAddressStats } from './data/address-stats';

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
  phase: 'idle' | 'fetching-height' | 'syncing-addresses' | 'processing' | 'resolving-prevouts' | 'complete' | 'error';
  currentAddress?: string;
  currentDepth?: number;
  maxDepth?: number;
  addressesTotal: number;
  addressesProcessed: number;
  transactionsFound: number;
  transactionsNew: number;
  newAddressRecords: number;
  addressesSkipped?: number;
  addressesFiltered?: number;
  transactionsAlreadySynced?: number;
  error?: string;
}

export interface SyncResult {
  success: boolean;
  addressesSynced: number;
  transactionsImported: number;
  transactionsUpdated: number;
  newAddressRecords: number;
  addressesSkipped: number;
  addressesFiltered: number;
  transactionsAlreadySynced: number;
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
  connectedOnly?: boolean; // If true, only create address records for addresses that already exist in user's curated record set
}

export interface SyncDepthEstimate {
  depth0: number;
  perDepth: number[];
  total: number;
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

interface ParentMetadata {
  walletName?: string;
  seedName?: string;
  walletSoftware?: string;
  owner?: string;
}

function safeAppend<T>(target: T[], source: T[]): void {
  for (let i = 0; i < source.length; i++) {
    target.push(source[i]);
  }
}

async function loadAddressRecordsAtDepth(depth: number): Promise<Record[]> {
  return db.records
    .where('type').equals('address')
    .filter(r => (r.syncDepth ?? 0) === depth)
    .toArray();
}


export class TransactionSyncService {
  private provider: BlockchainProvider;
  private onProgress?: SyncProgressCallback;
  private cancelled: boolean = false;
  private pauseRequested: boolean = false;
  private abortController: AbortController | null = null;
  private parentMetadataCache: Map<number, ParentMetadata> = new Map();
  private pendingDbNotifications: Set<string> = new Set();
  // Address strings whose locally-stored transaction data changed during the
  // current sync run. After the run completes we recompute their cached stats
  // from local data only (no network). Reset at the start of each run.
  private statsTouchedAddresses: Set<string> = new Set();
  private knownAddressSet: Set<string> | null = null;
  private connectedOnlyMode: boolean = false;
  private addressesFilteredCount: number = 0;
  // Hard ceiling on new address records created per sync run. Multi-hop
  // "Sync Deeper" can silently create millions of blockchain-discovered records
  // through the depth loop; this cap stops the explosion without deleting data.
  // The default (10,000 new addresses per run) is generous for a legitimate deep
  // sync on a normal wallet. Users can always run sync again to fetch more.
  private newAddressRecordsThisRun: number = 0;
  static readonly NEW_ADDRESS_RECORDS_CAP = 10_000;
  private currentProgress: SyncProgress = {
    phase: 'idle',
    addressesTotal: 0,
    addressesProcessed: 0,
    transactionsFound: 0,
    transactionsNew: 0,
    newAddressRecords: 0,
  };

  private yieldToUI(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  private cacheParentMetadata(record: Record): void {
    if (record.id === undefined) return;
    this.parentMetadataCache.set(record.id, {
      walletName: record.walletName,
      seedName: record.seedName,
      walletSoftware: record.walletSoftware,
      owner: record.owner,
    });
  }

  private async getParentMetadata(recordId: number): Promise<ParentMetadata | undefined> {
    const cached = this.parentMetadataCache.get(recordId);
    if (cached) return cached;
    const record = await db.records.get(recordId);
    if (!record) return undefined;
    const metadata: ParentMetadata = {
      walletName: record.walletName,
      seedName: record.seedName,
      walletSoftware: record.walletSoftware,
      owner: record.owner,
    };
    this.parentMetadataCache.set(recordId, metadata);
    return metadata;
  }

  private deferNotification(table: string): void {
    this.pendingDbNotifications.add(table);
  }

  private flushNotifications(): void {
    if (this.pendingDbNotifications.size > 0) {
      notifyDbChange(Array.from(this.pendingDbNotifications), { origin: 'blockchain-sync' });
      this.pendingDbNotifications.clear();
    }
  }

  /**
   * Recompute cached per-address stats for the addresses this sync run touched,
   * using LOCAL data only (participant rows + cached block times). Never makes
   * any network call. Safe to call at the end of a sync run; it clears the
   * touched-address set so subsequent runs start fresh.
   */
  private async recomputeTouchedAddressStats(): Promise<void> {
    if (this.statsTouchedAddresses.size === 0) return;
    const addresses = Array.from(this.statsTouchedAddresses);
    this.statsTouchedAddresses = new Set();
    try {
      await recomputeAddressStats({ addresses, origin: 'blockchain-sync' });
    } catch (err) {
      console.warn('[TransactionSync] Address stats recompute failed (non-fatal):', err);
    }
  }
  
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

  private cancellableCall<T>(promise: Promise<T>, timeoutMs: number = 30000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.cancelled) {
        reject(new Error('Sync cancelled'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`Network request timed out after ${Math.round(timeoutMs / 1000)}s. Check your node connection.`));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Sync cancelled'));
      };

      if (this.abortController) {
        this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      }

      promise.then(
        (val) => {
          clearTimeout(timer);
          if (this.abortController) {
            this.abortController.signal.removeEventListener('abort', onAbort);
          }
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          if (this.abortController) {
            this.abortController.signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        }
      );
    });
  }

  // Stop the current sync operation (does not save state)
  stopSync() {
    this.cancelled = true;
    this.pauseRequested = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    console.log('[TransactionSync] Stop requested');
  }
  
  // Request pause and save state for resume
  requestPause() {
    this.cancelled = true;
    this.pauseRequested = true;
    if (this.abortController) {
      this.abortController.abort();
    }
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

  private syncProtection: SyncProtectionSettings = { ...DEFAULT_SYNC_PROTECTION };

  setSyncProtection(settings: SyncProtectionSettings) {
    this.syncProtection = { ...settings };
  }

  getSyncProtection(): SyncProtectionSettings {
    return { ...this.syncProtection };
  }

  private async isBlacklisted(address: string): Promise<boolean> {
    return isAddressBlacklisted(address);
  }

  private async recordSkippedAddress(
    address: string,
    reason: SkippedAddress['reason'],
    syncRunTimestamp: number,
    opts?: { txCount?: number; errorMessage?: string; discoveredFromRecordId?: number; syncDepth?: number }
  ): Promise<void> {
    await addSkippedAddress({
      address,
      reason,
      txCount: opts?.txCount,
      errorMessage: opts?.errorMessage,
      syncRunTimestamp,
      discoveredFromRecordId: opts?.discoveredFromRecordId,
      syncDepth: opts?.syncDepth,
      dismissed: false,
    });
  }

  private async checkTxCountThreshold(address: string): Promise<{ exceeded: boolean; count: number }> {
    if (this.syncProtection.txCountThreshold <= 0) {
      return { exceeded: false, count: 0 };
    }
    try {
      if (this.provider.getAddressTxCount) {
        const count = await this.provider.getAddressTxCount(address);
        return { exceeded: count > this.syncProtection.txCountThreshold, count };
      }
    } catch (e) {
      console.warn(`[TransactionSync] Failed to pre-check tx count for ${address}:`, e);
    }
    return { exceeded: false, count: 0 };
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, address: string): Promise<T> {
    if (timeoutMs <= 0 && !this.abortController) return promise;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          reject(new Error(`Sync timed out after ${Math.round(timeoutMs / 1000)}s for address ${address}`));
        }, timeoutMs);
      }

      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(new Error('Sync cancelled'));
      };

      if (this.abortController) {
        if (this.abortController.signal.aborted) {
          if (timer) clearTimeout(timer);
          reject(new Error('Sync cancelled'));
          return;
        }
        this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      }

      promise.then(
        (val) => {
          if (timer) clearTimeout(timer);
          if (this.abortController) this.abortController.signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        (err) => {
          if (timer) clearTimeout(timer);
          if (this.abortController) this.abortController.signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  async syncSingleAddress(
    address: string,
    onProgress?: SyncProgressCallback
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      addressesSynced: 0,
      transactionsImported: 0,
      transactionsUpdated: 0,
      newAddressRecords: 0,
      addressesSkipped: 0,
      addressesFiltered: 0,
      transactionsAlreadySynced: 0,
      depthsProcessed: [0],
      errors: [],
    };

    const validation = validateAddress(address);
    if (!validation.isValid) {
      result.errors.push(`Invalid Bitcoin address: ${address}`);
      return result;
    }

    if (onProgress) {
      this.onProgress = onProgress;
    }

    this.resetProgress();
    this.cancelled = false;
    this.pauseRequested = false;
    this.newAddressRecordsThisRun = 0;

    try {
      this.updateProgress({
        phase: 'fetching-height',
        addressesTotal: 1,
        addressesProcessed: 0,
        transactionsFound: 0,
        transactionsNew: 0,
        newAddressRecords: 0,
      });

      const currentHeight = await this.cancellableCall(this.provider.getBlockHeight(), 30000);
      const minConfirmedHeight = currentHeight - MINIMUM_CONFIRMATIONS;

      this.updateProgress({
        phase: 'syncing-addresses',
        currentAddress: address,
        addressesTotal: 1,
        addressesProcessed: 0,
      });

      const existingRecord = await db.records
        .where('inputString')
        .equals(address)
        .first();
      const recordId = existingRecord?.id;

      if (!recordId) {
        result.errors.push(`Address "${address}" not found in your records. Add it first, then sync.`);
        this.updateProgress({ phase: 'error', error: result.errors[0] });
        return result;
      }

      const syncRunTimestamp = Date.now();

      // --- Sync Protection: Blacklist check (warn but allow for single-address) ---
      if (await this.isBlacklisted(address)) {
        console.log(`[TransactionSync] Single sync: address is blacklisted, proceeding anyway: ${address}`);
      }

      // --- Sync Protection: Tx count threshold check (warn but allow for single-address) ---
      const txCheck = await this.checkTxCountThreshold(address);
      if (txCheck.exceeded) {
        console.log(`[TransactionSync] Single sync: high-volume address (${txCheck.count} txs), proceeding anyway: ${address}`);
      }

      // --- Sync Protection: Per-address timeout ---
      const syncPromise = this.syncAddress(
        address,
        recordId,
        minConfirmedHeight,
        currentHeight,
        1
      );
      const syncResult = await this.withTimeout(
        syncPromise,
        this.syncProtection.perAddressTimeoutMs,
        address
      );

      result.transactionsImported = syncResult.imported;
      result.transactionsUpdated = syncResult.updated;
      result.newAddressRecords = syncResult.newRecords;
      result.transactionsAlreadySynced = syncResult.skippedAlreadySynced;
      result.addressesSynced = 1;

      await updateRecord(recordId, { maxSyncedDepth: 0 }, { skipNotification: true, skipVocabularySync: true });

      if (syncResult.imported > 0) {
        this.updateProgress({ phase: 'resolving-prevouts' });
        try {
          const prevoutStats = await this.resolvePrevouts();
          if (prevoutStats.resolved > 0) {
            console.log(`[TransactionSync] Single address prevout resolution: ${prevoutStats.resolved} resolved`);
          }
        } catch (err) {
          console.warn('[TransactionSync] Prevout resolution failed (non-fatal):', err);
        }
      }

      this.updateProgress({
        phase: 'complete',
        addressesProcessed: 1,
        transactionsFound: syncResult.imported + syncResult.updated,
        transactionsNew: syncResult.imported,
        newAddressRecords: syncResult.newRecords,
      });

      result.success = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg === 'Sync cancelled') {
        this.updateProgress({ phase: 'complete' });
        result.success = result.addressesSynced > 0;
      } else {
        result.errors.push(errorMsg);
        this.updateProgress({ phase: 'error', error: errorMsg });
      }
    } finally {
      this.abortController = null;
      await this.recomputeTouchedAddressStats();
      this.flushNotifications();
      this.parentMetadataCache.clear();
    }

    return result;
  }

  // Blacklist management
  async addToBlacklist(address: string, reason?: string): Promise<void> {
    const existing = await getBlacklistEntryByAddress(address);
    if (!existing) {
      await addToBlacklistCrud({
        address,
        reason,
      });
    }
  }

  async removeFromBlacklist(address: string): Promise<void> {
    await removeFromBlacklistByAddress(address);
  }

  async getBlacklist(): Promise<AddressBlacklist[]> {
    return getAllBlacklist();
  }

  async getSkippedAddresses(syncRunTimestamp?: number): Promise<SkippedAddress[]> {
    if (syncRunTimestamp) {
      return getSkippedAddressesByRun(syncRunTimestamp);
    }
    return getActiveSkippedAddresses();
  }

  async dismissSkippedAddress(id: number): Promise<void> {
    await updateSkippedAddress(id, { dismissed: true });
  }

  async dismissAllSkipped(): Promise<void> {
    await dismissAllSkippedAddresses();
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
    
    await putPausedSyncState(pausedState);
    console.log(`[TransactionSync] Saved paused state: ${remainingRecordIds.length} addresses remaining`);
  }

  // Get paused sync state
  async getPausedState(): Promise<PausedSyncState | undefined> {
    return getPausedSyncState('default');
  }

  // Clear paused sync state (when sync completes or user cancels resume)
  async clearPausedState(): Promise<void> {
    await deletePausedSyncState('default');
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
        addressesSkipped: 0,
        addressesFiltered: 0,
        transactionsAlreadySynced: 0,
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
    const settings = await getNodeSettings('default');
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
    this.abortController = new AbortController();
    this.knownAddressSet = null;
    this.connectedOnlyMode = false;
    this.addressesFilteredCount = 0;
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

  async syncWithDepth(options: SyncOptions, preloadedRecords?: Record[]): Promise<SyncResult> {
    const { sourceFilter, maxDepth, specificRecordIds, resumeContext } = options;
    
    // Reset progress counters and cancellation flags at the start of each sync
    this.resetProgress();
    this.cancelled = false;
    this.pauseRequested = false;
    this.newAddressRecordsThisRun = 0;
    
    // Initialize result with previous values if resuming
    const result: SyncResult = {
      success: false,
      addressesSynced: resumeContext?.previousResult?.addressesSynced ?? 0,
      transactionsImported: resumeContext?.previousResult?.transactionsImported ?? 0,
      transactionsUpdated: resumeContext?.previousResult?.transactionsUpdated ?? 0,
      newAddressRecords: resumeContext?.previousResult?.newAddressRecords ?? 0,
      addressesSkipped: 0,
      addressesFiltered: 0,
      transactionsAlreadySynced: 0,
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
        addressesSkipped: 0,
        transactionsFound: initialTransactionsNew,
        transactionsNew: initialTransactionsNew,
        newAddressRecords: initialNewAddresses,
      });

      const currentHeight = await this.cancellableCall(this.provider.getBlockHeight(), 30000);
      const minConfirmedHeight = currentHeight - MINIMUM_CONFIRMATIONS;
      const syncRunTimestamp = Date.now();

      // Track which record IDs we've already processed in this sync session
      // Initialize from resumeContext if available (prevents reprocessing completed addresses)
      const processedRecordIds = new Set<number>(resumeContext?.completedRecordIds ?? []);
      
      // For "Sync Deeper", we sync one additional layer beyond each record's current maxSyncedDepth
      // This means:
      // 1. First sync the target record itself if not fully synced
      // 2. Then sync all addresses that were discovered from that record (depth = record.syncDepth + 1)
      if (specificRecordIds && specificRecordIds.length > 0) {
        // Get the starting depth from the first specified record - use targeted query
        const targetRawRecords = await db.records.bulkGet(specificRecordIds);
        const validTargetRaw = targetRawRecords.filter((r): r is Record => !!r && r.type === 'address');
        const targetRecords = validTargetRaw;

        // Cache parent metadata for target records
        for (const r of targetRecords) {
          this.cacheParentMetadata(r);
        }
        
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
          
          // Load only address records at this specific depth (indexed query)
          const depthRawRecords = await loadAddressRecordsAtDepth(currentDepth);
          const freshRecords = depthRawRecords;

          // Cache parent metadata for discovered records
          for (const r of freshRecords) {
            this.cacheParentMetadata(r);
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
            await this.yieldToUI();

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

            const address = record.inputString;

            // --- Sync Protection: Blacklist check ---
            if (await this.isBlacklisted(address)) {
              console.log(`[TransactionSync] Skipping blacklisted address: ${address}`);
              await this.recordSkippedAddress(address, 'blacklisted', syncRunTimestamp, {
                syncDepth: currentDepth,
                discoveredFromRecordId: record.discoveredFromRecordId,
              });
              result.addressesSkipped++;
              this.updateProgress({ addressesSkipped: result.addressesSkipped });
              continue;
            }

            // --- Sync Protection: Tx count threshold check ---
            const txCheck = await this.checkTxCountThreshold(address);
            if (txCheck.exceeded) {
              console.log(`[TransactionSync] Skipping high-volume address (${txCheck.count} txs > ${this.syncProtection.txCountThreshold} threshold): ${address}`);
              await this.recordSkippedAddress(address, 'tx-count-exceeded', syncRunTimestamp, {
                txCount: txCheck.count,
                syncDepth: currentDepth,
                discoveredFromRecordId: record.discoveredFromRecordId,
              });
              result.addressesSkipped++;
              this.updateProgress({ addressesSkipped: result.addressesSkipped });
              continue;
            }
            
            this.updateProgress({
              phase: 'syncing-addresses',
              currentAddress: address,
              currentDepth,
              maxDepth,
              addressesProcessed: i,
              addressesTotal: validAddresses.length,
            });
            
            try {
              const syncPromise = this.syncAddress(
                address,
                record.id,
                minConfirmedHeight,
                currentHeight,
                currentDepth + 1
              );
              const syncResult = await this.withTimeout(
                syncPromise,
                this.syncProtection.perAddressTimeoutMs,
                address
              );
              result.transactionsImported += syncResult.imported;
              result.transactionsUpdated += syncResult.updated;
              result.newAddressRecords += syncResult.newRecords;
              result.addressesSynced++;
              
              await updateRecord(record.id!, { maxSyncedDepth: currentDepth }, { skipNotification: true, skipVocabularySync: true });

              // Flush deferred notifications after each address
              this.flushNotifications();
              
              this.updateProgress({
                addressesProcessed: i + 1,
                transactionsFound: result.transactionsImported + result.transactionsUpdated,
                transactionsNew: result.transactionsImported,
                newAddressRecords: result.newAddressRecords,
              });
            } catch (error) {
              // Flush any partial notifications even on error
              this.flushNotifications();
              const errorMsg = error instanceof Error ? error.message : 'Unknown error';
              const isTimeout = errorMsg.includes('timed out');
              if (isTimeout) {
                await this.recordSkippedAddress(address, 'timeout', syncRunTimestamp, {
                  errorMessage: errorMsg,
                  syncDepth: currentDepth,
                  discoveredFromRecordId: record.discoveredFromRecordId,
                });
                result.addressesSkipped++;
                this.updateProgress({ addressesProcessed: i + 1, addressesSkipped: result.addressesSkipped });
                console.warn(`[TransactionSync] ${errorMsg}`);
              } else {
                await this.recordSkippedAddress(address, 'error', syncRunTimestamp, {
                  errorMessage: errorMsg,
                  syncDepth: currentDepth,
                  discoveredFromRecordId: record.discoveredFromRecordId,
                });
                result.addressesSkipped++;
                result.errors.push(`Failed to sync ${address}: ${errorMsg}`);
                this.updateProgress({ addressesProcessed: i + 1, addressesSkipped: result.addressesSkipped });
                console.error(`[TransactionSync] Failed to sync ${address}: ${errorMsg}`);
              }
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
                await updateRecord(targetId, { maxSyncedDepth: deepestActuallySynced }, { skipNotification: true, skipVocabularySync: true });
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

      // Track which record IDs are "in scope" for this sync session.
      // At depth 0, this is the filtered/selected set. At depth 1+, only addresses
      // whose discoveredFromRecordId is in the previous depth's scope are included.
      // This prevents syncing unrelated addresses from previous sync sessions.
      const scopeRecordIds = new Set<number>();

      // Clear parent metadata cache at start of normal sync
      this.parentMetadataCache.clear();

      // Connected-only mode: build a set of all known (curated) addresses
      // When enabled, findOrCreateAddressRecord will skip creating records for
      // addresses not in this set, preventing cascade into unknown territory
      this.connectedOnlyMode = !!options.connectedOnly;
      this.addressesFilteredCount = 0;
      if (this.connectedOnlyMode) {
        const allCuratedRecords = await db.records
          .where('type').equals('address')
          .filter(r => r.source !== 'blockchain-sync')
          .toArray();
        this.knownAddressSet = new Set(allCuratedRecords.map(r => r.inputString));
        console.log(`[TransactionSync] Connected-only mode: ${this.knownAddressSet.size} known addresses loaded`);
      } else {
        this.knownAddressSet = null;
      }

      // Normal sync: Process each depth level from 0 up to maxDepth (exclusive)
      // Depth 0 = manually entered addresses, Depth 1 = first-hop discovered, etc.
      // maxDepth = N means "sync up to depth N-1" (e.g., maxDepth=2 syncs depths 0 and 1)
      for (let currentDepth = 0; currentDepth < maxDepth; currentDepth++) {
        console.log(`[TransactionSync] Processing depth ${currentDepth} (max: ${maxDepth})`);
        
        let allRecords: Record[];
        if (currentDepth === 0 && preloadedRecords) {
          allRecords = preloadedRecords;
        } else {
          // Use indexed query to load only records at this depth level
          const depthRawRecords = await loadAddressRecordsAtDepth(currentDepth);
          allRecords = depthRawRecords;
        }

        // Cache parent metadata for all loaded records
        for (const r of allRecords) {
          this.cacheParentMetadata(r);
        }
        
        // First, build the scope set for this depth level.
        // This includes ALL matching records (even already-synced ones) so that
        // the next depth's discoveredFromRecordId check can trace lineage correctly.
        const matchesSourceFilter = (r: Record): boolean => {
          if (currentDepth === 0) {
            if (sourceFilter === 'custom' && options.sourceSelection) {
              return matchesSourceSelection(r, options.sourceSelection);
            }
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
          // For depth > 0: only include addresses discovered from
          // records that were in scope at the previous depth level.
          if (r.discoveredFromRecordId) {
            return scopeRecordIds.has(r.discoveredFromRecordId);
          }
          return false;
        };

        // Add ALL matching records at this depth to scope (including already-synced)
        // so their children at the next depth can be traced back
        for (const r of allRecords) {
          if (r.type !== 'address' || !r.id) continue;
          const recordDepth = r.syncDepth ?? 0;
          if (recordDepth !== currentDepth) continue;
          if (matchesSourceFilter(r)) {
            scopeRecordIds.add(r.id);
          }
        }

        let addressRecords = allRecords.filter(r => {
          if (r.type !== 'address') return false;
          if (!r.id) return false;
          if (processedRecordIds.has(r.id)) return false;
          const recordDepth = r.syncDepth ?? 0;
          if (recordDepth !== currentDepth) return false;
          return scopeRecordIds.has(r.id);
        });
        
        console.log(`[TransactionSync] Found ${addressRecords.length} addresses at depth ${currentDepth} to sync (${scopeRecordIds.size} in scope, filter: ${sourceFilter})`);
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
          await this.yieldToUI();

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

          // --- Sync Protection: Blacklist check ---
          if (await this.isBlacklisted(address)) {
            console.log(`[TransactionSync] Skipping blacklisted address: ${address}`);
            await this.recordSkippedAddress(address, 'blacklisted', syncRunTimestamp, {
              syncDepth: currentDepth,
              discoveredFromRecordId: record.discoveredFromRecordId,
            });
            result.addressesSkipped++;
            this.updateProgress({ addressesSkipped: result.addressesSkipped });
            continue;
          }

          // --- Sync Protection: Tx count threshold check ---
          const txCheck = await this.checkTxCountThreshold(address);
          if (txCheck.exceeded) {
            console.log(`[TransactionSync] Skipping high-volume address (${txCheck.count} txs > ${this.syncProtection.txCountThreshold} threshold): ${address}`);
            await this.recordSkippedAddress(address, 'tx-count-exceeded', syncRunTimestamp, {
              txCount: txCheck.count,
              syncDepth: currentDepth,
              discoveredFromRecordId: record.discoveredFromRecordId,
            });
            result.addressesSkipped++;
            this.updateProgress({ addressesSkipped: result.addressesSkipped });
            continue;
          }

          this.updateProgress({
            phase: 'syncing-addresses',
            currentAddress: address,
            currentDepth,
            maxDepth,
            addressesProcessed: i,
            addressesTotal: validAddressRecords.length,
          });

          try {
            const syncPromise = this.syncAddress(
              address, 
              record.id, 
              minConfirmedHeight, 
              currentHeight,
              currentDepth + 1
            );
            const syncResult = await this.withTimeout(
              syncPromise,
              this.syncProtection.perAddressTimeoutMs,
              address
            );
            result.transactionsImported += syncResult.imported;
            result.transactionsUpdated += syncResult.updated;
            result.newAddressRecords += syncResult.newRecords;
            result.transactionsAlreadySynced += syncResult.skippedAlreadySynced;
            result.addressesSynced++;

            await updateRecord(record.id!, { maxSyncedDepth: currentDepth }, { skipNotification: true, skipVocabularySync: true });

            // Flush deferred notifications after each address
            this.flushNotifications();

            this.updateProgress({
              addressesProcessed: i + 1,
              transactionsFound: result.transactionsImported + result.transactionsUpdated,
              transactionsNew: result.transactionsImported,
              newAddressRecords: result.newAddressRecords,
              transactionsAlreadySynced: result.transactionsAlreadySynced,
              addressesFiltered: this.addressesFilteredCount,
            });
          } catch (error) {
            // Flush any partial notifications even on error
            this.flushNotifications();
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            const isTimeout = errorMsg.includes('timed out');
            if (isTimeout) {
              await this.recordSkippedAddress(address, 'timeout', syncRunTimestamp, {
                errorMessage: errorMsg,
                syncDepth: currentDepth,
                discoveredFromRecordId: record.discoveredFromRecordId,
              });
              result.addressesSkipped++;
              this.updateProgress({ addressesProcessed: i + 1, addressesSkipped: result.addressesSkipped });
              console.warn(`[TransactionSync] ${errorMsg}`);
            } else {
              await this.recordSkippedAddress(address, 'error', syncRunTimestamp, {
                errorMessage: errorMsg,
                syncDepth: currentDepth,
                discoveredFromRecordId: record.discoveredFromRecordId,
              });
              result.addressesSkipped++;
              result.errors.push(`Failed to sync ${address}: ${errorMsg}`);
              this.updateProgress({ addressesProcessed: i + 1, addressesSkipped: result.addressesSkipped });
              console.error(`[TransactionSync] Failed to sync ${address}: ${errorMsg}`);
            }
          }
        }
      }

      result.addressesFiltered = this.addressesFilteredCount;
      const totalProcessed = result.addressesSynced + result.addressesSkipped;

      if (result.transactionsImported > 0 && !this.cancelled) {
        this.updateProgress({ phase: 'resolving-prevouts' });
        try {
          const prevoutStats = await this.resolvePrevouts();
          if (prevoutStats.resolved > 0) {
            console.log(`[TransactionSync] Prevout resolution: ${prevoutStats.resolved} resolved, ${prevoutStats.fetchedFromNode} fetched from node`);
          }
        } catch (err) {
          console.warn('[TransactionSync] Prevout resolution failed (non-fatal):', err);
        }
      }

      this.updateProgress({
        phase: 'complete',
        addressesProcessed: totalProcessed,
      });

      result.success = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg === 'Sync cancelled') {
        this.updateProgress({ phase: 'complete' });
        result.success = result.addressesSynced > 0;
      } else {
        result.errors.push(errorMsg);
        this.updateProgress({
          phase: 'error',
          error: errorMsg,
        });
      }
    } finally {
      this.pauseRequested = false;
      this.abortController = null;
      // Recompute cached stats for touched addresses from local data only.
      await this.recomputeTouchedAddressStats();
      // Flush any remaining deferred notifications and clear caches
      this.flushNotifications();
      this.parentMetadataCache.clear();
    }

    return result;
  }

  private async syncAddress(
    address: string,
    recordId: number,
    minConfirmedHeight: number,
    currentHeight: number,
    newAddressDepth: number = 1 // Depth for newly discovered addresses
  ): Promise<{ imported: number; updated: number; newRecords: number; apiTxCount: number; skippedAlreadySynced: number; skippedUnconfirmed: number }> {
    const stats = { imported: 0, updated: 0, newRecords: 0, apiTxCount: 0, skippedAlreadySynced: 0, skippedUnconfirmed: 0 };

    const syncState = await getAddressSyncStateByAddress(address);

    let apiTransactions: ApiTransaction[];
    try {
      apiTransactions = await this.provider.getAddressTransactions(address);
    } catch (fetchError) {
      console.error(`[TransactionSync] Failed to fetch transactions for ${address}:`, fetchError);
      throw fetchError;
    }

    stats.apiTxCount = apiTransactions.length;
    console.log(`[TransactionSync] ${address.substring(0, 12)}...: ${apiTransactions.length} txs from API${syncState ? `, last synced at height ${syncState.lastSyncedHeight}` : ' (first sync)'}`);

    let txProcessed = 0;
    for (const apiTx of apiTransactions) {
      if (this.cancelled) break;

      const parsed = parseTransaction(apiTx);
      
      if (!parsed) {
        stats.skippedUnconfirmed++;
        continue;
      }

      if (parsed.blockHeight > minConfirmedHeight) {
        stats.skippedUnconfirmed++;
        continue;
      }

      if (syncState && parsed.blockHeight <= syncState.lastSyncedHeight) {
        stats.skippedAlreadySynced++;
        continue;
      }

      const existingTx = await db.blockchainTransactions.where('txid').equals(parsed.txid).first();

      if (existingTx) {
        stats.updated++;
        continue;
      }

      await addTransaction({
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
      }, { skipNotification: true });
      stats.imported++;

      const txSyncDepth = Math.max(0, newAddressDepth - 1);
      const { isNew: isTxRecordNew } = await this.findOrCreateTransactionRecord(parsed.txid, parsed.blockTime, txSyncDepth, recordId);
      if (isTxRecordNew) stats.newRecords++;

      await this.updateFirstSeenBlockTime(recordId, parsed.blockTime);

      // Collect participants for batch insert
      const participantsBatch: TransactionParticipant[] = [];

      // Record which addresses had their local tx data change, so we can
      // recompute their cached stats from local data after the sync run.
      this.statsTouchedAddresses.add(address);

      for (const input of parsed.inputs) {
        let inputRecordId: number | undefined;
        if (input.address) {
          const result = await this.findOrCreateAddressRecord(
            input.address, 
            newAddressDepth,
            parsed.txid,
            recordId
          );
          if (result) {
            inputRecordId = result.recordId;
            if (result.isNew) stats.newRecords++;
            await this.updateFirstSeenBlockTime(result.recordId, parsed.blockTime);
          }
        }

        if (input.address) this.statsTouchedAddresses.add(input.address);

        participantsBatch.push({
          txid: parsed.txid,
          role: 'input',
          address: input.address,
          amount: input.amount,
          recordId: inputRecordId,
          scriptType: input.scriptType,
          prevTxid: input.prevTxid,
          prevVout: input.prevVout,
        });
      }

      for (const output of parsed.outputs) {
        const result = await this.findOrCreateAddressRecord(
          output.address,
          newAddressDepth,
          parsed.txid,
          recordId
        );
        let outputRecordId: number | undefined;
        if (result) {
          outputRecordId = result.recordId;
          if (result.isNew) stats.newRecords++;
          await this.updateFirstSeenBlockTime(result.recordId, parsed.blockTime);
        }

        if (output.address) this.statsTouchedAddresses.add(output.address);

        participantsBatch.push({
          txid: parsed.txid,
          role: 'output',
          address: output.address,
          amount: output.amount,
          vout: output.vout,
          recordId: outputRecordId,
          scriptType: output.scriptType,
        });
      }

      // Encrypt and batch insert all participants for this transaction at once
      if (participantsBatch.length > 0) {
        await bulkAddParticipants(participantsBatch, { skipNotification: true });
      }

      txProcessed++;
      if (txProcessed % 5 === 0) {
        await this.yieldToUI();
      }
    }

    if (stats.skippedAlreadySynced > 0 || stats.skippedUnconfirmed > 0) {
      console.log(`[TransactionSync] ${address.substring(0, 12)}...: ${stats.imported} imported, ${stats.updated} existing, ${stats.skippedAlreadySynced} already synced, ${stats.skippedUnconfirmed} unconfirmed`);
    }

    const txCount = apiTransactions.filter(tx => {
      const parsed = parseTransaction(tx);
      return parsed && parsed.blockHeight <= minConfirmedHeight;
    }).length;

    if (syncState) {
      await updateAddressSyncState(syncState.id!, {
        lastSyncedHeight: currentHeight,
        lastSyncedAt: Date.now(),
        txCount,
      });
    } else {
      await addAddressSyncState({
        address,
        recordId,
        lastSyncedHeight: currentHeight,
        lastSyncedAt: Date.now(),
        txCount,
      });
    }

    if (stats.imported > 0) {
      this.deferNotification('transactionParticipants');
      this.deferNotification('blockchainTransactions');
    }

    return stats;
  }

  async resolvePrevouts(onProgress?: (resolved: number, total: number) => void): Promise<{ resolved: number; fetchedFromNode: number; errors: number }> {
    const stats = { resolved: 0, fetchedFromNode: 0, errors: 0 };

    const allInputs = await db.transactionParticipants
      .where('role').equals('input')
      .toArray();

    const unresolvedInputs = allInputs.filter(
      p => (!p.address || p.address === '') && p.prevTxid !== undefined && p.prevVout !== undefined
    );

    if (unresolvedInputs.length === 0) {
      console.log('[TransactionSync] No unresolved prevouts found');
      return stats;
    }

    console.log(`[TransactionSync] Resolving ${unresolvedInputs.length} unresolved prevout inputs`);

    const localOutputCache = new Map<string, { address: string; amount: number; scriptType?: string }>();
    const prevTxids = new Set<string>();
    for (const inp of unresolvedInputs) {
      if (inp.prevTxid) prevTxids.add(inp.prevTxid);
    }
    const prevTxidArr = Array.from(prevTxids);
    for (let i = 0; i < prevTxidArr.length; i += 500) {
      const batch = prevTxidArr.slice(i, i + 500);
      const rawOutputs = await db.transactionParticipants
        .where('txid').anyOf(batch)
        .and(p => p.role === 'output')
        .toArray();
      for (const o of rawOutputs) {
        if (o.vout !== undefined) {
          localOutputCache.set(`${o.txid}:${o.vout}`, {
            address: o.address,
            amount: Number(o.amount) || 0,
            scriptType: o.scriptType,
          });
        }
      }
    }

    const needFetch = new Set<string>();
    for (const inp of unresolvedInputs) {
      const key = `${inp.prevTxid}:${inp.prevVout}`;
      if (!localOutputCache.has(key) && inp.prevTxid) {
        needFetch.add(inp.prevTxid);
      }
    }

    if (needFetch.size > 0) {
      console.log(`[TransactionSync] Fetching ${needFetch.size} previous transactions from node for prevout resolution`);
      const fetchArr = Array.from(needFetch);
      const CONCURRENCY = 4;
      for (let i = 0; i < fetchArr.length; i += CONCURRENCY) {
        if (this.cancelled) break;
        const chunk = fetchArr.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map(txid => this.provider.getTransaction(txid).then(apiTx => ({ txid, apiTx })))
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.apiTx) {
            const { txid, apiTx } = r.value;
            for (const vout of apiTx.vout) {
              if (vout.scriptpubkey_address) {
                localOutputCache.set(`${txid}:${vout.n}`, {
                  address: vout.scriptpubkey_address,
                  amount: vout.value,
                  scriptType: vout.scriptpubkey_type,
                });
              }
            }
            stats.fetchedFromNode++;
          } else if (r.status === 'rejected') {
            stats.errors++;
          }
        }

        if ((i + CONCURRENCY) % 20 === 0) {
          await this.yieldToUI();
          if (onProgress) onProgress(stats.resolved, unresolvedInputs.length);
        }
      }
    }

    const resolvedAddresses = new Set<string>();
    for (const inp of unresolvedInputs) {
      const key = `${inp.prevTxid}:${inp.prevVout}`;
      const resolved = localOutputCache.get(key);
      if (resolved && resolved.address) {
        resolvedAddresses.add(resolved.address);
        // These addresses now have a known input amount, so their balance
        // changed — mark them for a local-only stats recompute.
        this.statsTouchedAddresses.add(resolved.address);
      }
    }

    const addressToRecordId = new Map<string, number>();
    const addrArr = Array.from(resolvedAddresses);
    for (let i = 0; i < addrArr.length; i += 500) {
      const batch = addrArr.slice(i, i + 500);
      const records = await db.records
        .where('inputString').anyOf(batch)
        .toArray();
      for (const r of records) {
        if (r.id && r.inputString) {
          addressToRecordId.set(r.inputString, r.id);
        }
      }
    }

    const resolvedParticipants: TransactionParticipant[] = [];
    for (const inp of unresolvedInputs) {
      const key = `${inp.prevTxid}:${inp.prevVout}`;
      const resolved = localOutputCache.get(key);
      if (resolved && resolved.address && inp.id) {
        const updated: TransactionParticipant = {
          ...inp,
          address: resolved.address,
          amount: resolved.amount,
          scriptType: resolved.scriptType as any,
          recordId: addressToRecordId.get(resolved.address),
        };
        resolvedParticipants.push(updated);
        stats.resolved++;
      }
    }

    if (resolvedParticipants.length > 0) {
      for (let i = 0; i < resolvedParticipants.length; i += 200) {
        const batch = resolvedParticipants.slice(i, i + 200);
        await bulkPutParticipants(batch, { skipNotification: true });
        if (onProgress) onProgress(Math.min(stats.resolved, unresolvedInputs.length), unresolvedInputs.length);
      }
      console.log(`[TransactionSync] Resolved ${stats.resolved} prevout inputs (${stats.fetchedFromNode} fetched from node, ${stats.errors} errors)`);
      this.deferNotification('transactionParticipants');
      this.flushNotifications();
    }

    return stats;
  }

  private async findOrCreateAddressRecord(
    address: string,
    syncDepth: number = 1,
    discoveredInTxid?: string,
    discoveredFromRecordId?: number
  ): Promise<{ recordId: number; isNew: boolean } | null> {
    const existing = await db.records.where('inputString').equals(address).first();
    
    if (existing && existing.id) {
      return { recordId: existing.id, isNew: false };
    }

    // Connected-only mode: skip creating records for addresses not in known set
    // This prevents cascade into unknown address territory while still saving
    // transaction participant data (with null recordId)
    if (this.connectedOnlyMode && this.knownAddressSet && !this.knownAddressSet.has(address)) {
      this.addressesFilteredCount++;
      return null;
    }

    // Hard ceiling: stop creating new blockchain-discovered records once the
    // per-run limit is reached. The address still appears as a participant (the
    // participant row is written regardless), but no Records entry is created.
    // This prevents multi-hop "Sync Deeper" from silently exploding the database
    // across many recursion levels. Sync again to continue from where it left off.
    if (this.newAddressRecordsThisRun >= TransactionSyncService.NEW_ADDRESS_RECORDS_CAP) {
      if (this.newAddressRecordsThisRun === TransactionSyncService.NEW_ADDRESS_RECORDS_CAP) {
        console.warn(
          `[TransactionSync] New-address cap reached (${TransactionSyncService.NEW_ADDRESS_RECORDS_CAP}). ` +
          'No more address records will be created this run. Run sync again to continue.',
        );
      }
      this.addressesFilteredCount++;
      return null;
    }

    // Look up parent record to inherit context (but NOT owner - discovered addresses need review)
    let parentWalletName: string | undefined;
    let parentSeedName: string | undefined;
    let parentWalletSoftware: string | undefined;
    
    if (discoveredFromRecordId) {
      const parentMeta = await this.getParentMetadata(discoveredFromRecordId);
      if (parentMeta) {
        parentWalletName = parentMeta.walletName;
        parentSeedName = parentMeta.seedName;
        parentWalletSoftware = parentMeta.walletSoftware;
      }
    }

    const newRecordId = await createRecord({
      type: 'address',
      inputString: address,
      label: '',
      tags: [],
      categories: [],
      owner: 'Pending Review',
      source: 'blockchain-sync',
      syncDepth,
      maxSyncedDepth: -1,
      discoveredInTxid,
      discoveredFromRecordId,
      addressImportance: 'blockchain-discovered',
      walletName: parentWalletName,
      seedName: parentSeedName,
      walletSoftware: parentWalletSoftware,
    }, { skipNotification: true, skipVocabularySync: true });

    this.newAddressRecordsThisRun++;
    this.deferNotification('records');

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
      await updateRecord(recordId, { firstSeenBlockTime: blockTime }, { skipNotification: true, skipVocabularySync: true });
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

    // Look up parent record to inherit context (use cache)
    let parentWalletName: string | undefined;
    let parentSeedName: string | undefined;
    let parentWalletSoftware: string | undefined;
    let parentOwner: string | undefined;
    
    if (discoveredFromRecordId) {
      const parentMeta = await this.getParentMetadata(discoveredFromRecordId);
      if (parentMeta) {
        parentWalletName = parentMeta.walletName;
        parentSeedName = parentMeta.seedName;
        parentWalletSoftware = parentMeta.walletSoftware;
        parentOwner = parentMeta.owner;
      }
    }

    const newRecordId = await createRecord({
      type: 'transaction',
      inputString: txid,
      label: '',
      tags: [],
      categories: [],
      owner: parentOwner || 'Pending Review',
      source: 'blockchain-sync',
      syncDepth,
      discoveredFromRecordId,
      date: new Date(blockTime * 1000).toISOString().split('T')[0],
      firstSeenBlockTime: blockTime,
      walletName: parentWalletName,
      seedName: parentSeedName,
      walletSoftware: parentWalletSoftware,
    }, { skipNotification: true, skipVocabularySync: true });

    this.deferNotification('records');

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

    return { recordId: newRecordId, isNew: true };
  }

  async getStats(): Promise<{
    totalAddresses: number;
    syncedAddresses: number;
    totalTransactions: number;
    lastSyncTime: number | null;
  }> {
    const totalAddresses = await db.records.where('type').equals('address').count();
    const syncedAddresses = await countAddressSyncState();
    const totalTransactions = await db.blockchainTransactions.count();
    
    const lastSync = await getLatestAddressSyncState();
    
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
    const { getParticipantsByAddress } = await import('./dataFacade');
    const participants = await getParticipantsByAddress(address);

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
    const estimate = await this.getMultiDepthEstimate(options);
    return estimate.depth0;
  }

  /**
   * Get per-depth estimates of how many addresses will be synced.
   * Depth 0 = selected root addresses. Depth 1+ = previously discovered addresses
   * whose discoveredFromRecordId traces back to the selected roots.
   * Only counts addresses that haven't been synced yet at each depth level.
   */
  async getMultiDepthEstimate(options: SyncOptions): Promise<SyncDepthEstimate> {
    const allRecords = await loadAddressRecords();
    return this.getMultiDepthEstimateFromRecords(options, allRecords);
  }

  getMultiDepthEstimateFromRecords(options: SyncOptions, allRecords: Record[]): SyncDepthEstimate {
    const { sourceFilter, sourceSelection, maxDepth } = options;

    const scopeRecordIds = new Set<number>();
    const depthCounts: number[] = [];

    for (let depth = 0; depth < maxDepth; depth++) {
      let needsSyncCount = 0;

      for (const r of allRecords) {
        if (r.type !== 'address' || !r.id) continue;
        const recordDepth = r.syncDepth ?? 0;
        if (recordDepth !== depth) continue;

        let inScope = false;
        if (depth === 0) {
          if (sourceFilter === 'custom' && sourceSelection) {
            inScope = matchesSourceSelection(r, sourceSelection);
          } else {
            switch (sourceFilter) {
              case 'manual-only':
                inScope = r.source !== 'blockchain-sync' && !r.source?.startsWith('tx-import:');
                break;
              case 'include-tx-import':
                inScope = r.source !== 'blockchain-sync';
                break;
              case 'include-blockchain-sync':
                inScope = !r.source?.startsWith('tx-import:');
                break;
              case 'all':
              default:
                inScope = true;
                break;
            }
          }
        } else {
          inScope = !!r.discoveredFromRecordId && scopeRecordIds.has(r.discoveredFromRecordId);
        }

        if (inScope) {
          scopeRecordIds.add(r.id);

          const validation = validateAddress(r.inputString);
          if (validation.isValid) {
            needsSyncCount++;
          }
        }
      }

      depthCounts.push(needsSyncCount);
    }

    return {
      depth0: depthCounts[0] ?? 0,
      perDepth: depthCounts,
      total: depthCounts.reduce((a, b) => a + b, 0),
    };
  }
}

export const transactionSyncService = new TransactionSyncService();

// Extract base wallet name from sources that contain derivation paths
// e.g., "NamaDompet (0/1)" -> "NamaDompet", "Sparrow (m/84'/0'/0'/0/5)" -> "Sparrow"
function extractBaseWalletName(source: string): string {
  // Match patterns like "Name (derivation)" or "Name (derivation); suffix"
  // where derivation contains BIP paths: m/84'/0'/0'/0/5, (0/1), (M/49H/0H/0H), etc.
  // The derivation path may be followed by additional text like "; bip329Import_2026..."
  const match = source.match(/^(.+?)\s*\([0-9mM/'hH,\s\-]+\)/);
  if (match) {
    return match[1].trim();
  }
  return source;
}

export async function loadAddressRecords(): Promise<Record[]> {
  return db.records.where('type').equals('address').toArray();
}

export function getAddressSourcesFromRecords(allRecords: Record[]): SourceCategory[] {
  return _buildSourceCategories(allRecords);
}

export async function getAddressSources(): Promise<SourceCategory[]> {
  const allRecords = await loadAddressRecords();
  return _buildSourceCategories(allRecords);
}

function _buildSourceCategories(allRecords: Record[]): SourceCategory[] {
  
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
