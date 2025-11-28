// Transaction Sync Service
// Syncs blockchain transaction data for addresses in the local database

import { db, type Record, type BlockchainTransaction, type TransactionParticipant, type AddressSyncState } from './database';
import { createProvider, parseTransaction, MINIMUM_CONFIRMATIONS, type ProviderType, type ParsedTransaction } from './blockchain-api';
import { validateAddress } from './bitcoin';

export interface SyncProgress {
  phase: 'idle' | 'fetching-height' | 'syncing-addresses' | 'processing' | 'complete' | 'error';
  currentAddress?: string;
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
  errors: string[];
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

export class TransactionSyncService {
  private provider;
  private onProgress?: SyncProgressCallback;

  constructor(providerType: ProviderType = 'mempool') {
    this.provider = createProvider(providerType);
  }

  setProgressCallback(callback: SyncProgressCallback) {
    this.onProgress = callback;
  }

  private updateProgress(progress: Partial<SyncProgress>) {
    if (this.onProgress) {
      this.onProgress(progress as SyncProgress);
    }
  }

  async syncAllAddresses(): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      addressesSynced: 0,
      transactionsImported: 0,
      transactionsUpdated: 0,
      newAddressRecords: 0,
      errors: [],
    };

    try {
      this.updateProgress({
        phase: 'fetching-height',
        addressesTotal: 0,
        addressesProcessed: 0,
        transactionsFound: 0,
        transactionsNew: 0,
        newAddressRecords: 0,
      });

      const currentHeight = await this.provider.getBlockHeight();
      const minConfirmedHeight = currentHeight - MINIMUM_CONFIRMATIONS;

      const addressRecords = await db.records
        .where('type')
        .equals('address')
        .toArray();

      if (addressRecords.length === 0) {
        this.updateProgress({ phase: 'complete' });
        result.success = true;
        return result;
      }

      this.updateProgress({
        phase: 'syncing-addresses',
        addressesTotal: addressRecords.length,
      });

      // Filter to only valid Bitcoin addresses (skip P2PK scripts, raw public keys, etc.)
      const validAddressRecords = addressRecords.filter(record => {
        const validation = validateAddress(record.inputString);
        return validation.isValid;
      });

      const skippedCount = addressRecords.length - validAddressRecords.length;
      if (skippedCount > 0) {
        console.log(`Skipping ${skippedCount} records with non-standard address formats`);
      }

      for (let i = 0; i < validAddressRecords.length; i++) {
        const record = validAddressRecords[i];
        const address = record.inputString;

        this.updateProgress({
          phase: 'syncing-addresses',
          currentAddress: address,
          addressesProcessed: i,
          addressesTotal: validAddressRecords.length,
        });

        try {
          const syncResult = await this.syncAddress(address, record.id!, minConfirmedHeight, currentHeight);
          result.transactionsImported += syncResult.imported;
          result.transactionsUpdated += syncResult.updated;
          result.newAddressRecords += syncResult.newRecords;
          result.addressesSynced++;

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

      this.updateProgress({
        phase: 'complete',
        addressesProcessed: addressRecords.length,
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
    currentHeight: number
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
        const { recordId, isNew } = await this.findOrCreateAddressRecord(input.address);
        if (isNew) stats.newRecords++;

        await db.transactionParticipants.add({
          txid: parsed.txid,
          role: 'input',
          address: input.address,
          amount: input.amount,
          recordId,
        });
      }

      for (const output of parsed.outputs) {
        const { recordId, isNew } = await this.findOrCreateAddressRecord(output.address);
        if (isNew) stats.newRecords++;

        await db.transactionParticipants.add({
          txid: parsed.txid,
          role: 'output',
          address: output.address,
          amount: output.amount,
          vout: output.vout,
          recordId,
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

  private async findOrCreateAddressRecord(address: string): Promise<{ recordId: number; isNew: boolean }> {
    const existing = await db.records.where('inputString').equals(address).first();
    
    if (existing && existing.id) {
      return { recordId: existing.id, isNew: false };
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
      createdAt: now,
      updatedAt: now,
    });

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
