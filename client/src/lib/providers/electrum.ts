import { isElectron, getElectronAPI } from '../electron';
import { BlockchainProvider, ApiTransaction } from './types';

// Electrum protocol provider - uses TCP instead of HTTP for faster bulk queries
// Note: This provider is experimental and primarily optimized for getting transaction history.
// For production use with 10k+ addresses, consider using batch endpoints with concurrency limits.
// Clean Electrum host - remove http:// prefix and trailing slashes
// Electrum uses raw TCP, not HTTP
function cleanElectrumHost(host: string): string {
  if (!host) return host;
  let cleaned = host.trim();
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  cleaned = cleaned.replace(/\/+$/, '');
  return cleaned;
}

export class ElectrumProvider implements BlockchainProvider {
  name = 'Electrum Protocol';
  private host: string;
  private port: number;
  private useSSL: boolean;
  private timeout: number;
  private transactionCache: Map<string, ApiTransaction> = new Map();
  private static readonly TX_FETCH_CONCURRENCY = 5;

  constructor(host: string, port: number = 50001, useSSL: boolean = false, timeout: number = 30000) {
    if (!host || host.trim() === '') {
      throw new Error('Electrum host is required');
    }
    this.host = cleanElectrumHost(host);
    this.port = port;
    this.useSSL = useSSL;
    this.timeout = timeout;
    this.name = `Electrum (${this.host}:${port})`;
    console.log(`[ElectrumProvider] Initialized with ${this.host}:${port} (SSL: ${useSSL})`);
  }

  private ensureElectron(): void {
    if (!isElectron()) {
      throw new Error('Electrum protocol requires the desktop app. Please use HTTP-based sync in web mode.');
    }
  }

  async getBlockHeight(): Promise<number> {
    this.ensureElectron();
    
    const api = getElectronAPI();
    const result = await api.electrumTest({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      timeout: this.timeout,
    });
    
    if (!result.success || result.blockHeight === undefined) {
      throw new Error(result.error || 'Failed to get block height via Electrum');
    }
    
    return result.blockHeight;
  }

  async getAddressTransactions(address: string): Promise<ApiTransaction[]> {
    this.ensureElectron();
    
    const api = getElectronAPI();
    
    const historyResult = await api.electrumGetHistory({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      address,
      timeout: this.timeout,
    });
    
    if (!historyResult.success) {
      throw new Error(historyResult.error || 'Failed to get address history via Electrum');
    }
    
    const transactions: ApiTransaction[] = [];
    const uncached = historyResult.history.filter(item => {
      if (this.transactionCache.has(item.tx_hash)) {
        transactions.push(this.transactionCache.get(item.tx_hash)!);
        return false;
      }
      return true;
    });
    
    for (let i = 0; i < uncached.length; i += ElectrumProvider.TX_FETCH_CONCURRENCY) {
      const batch = uncached.slice(i, i + ElectrumProvider.TX_FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (item) => {
          try {
            const txResult = await api.electrumGetTransaction({
              host: this.host,
              port: this.port,
              useSSL: this.useSSL,
              txid: item.tx_hash,
              verbose: true,
              timeout: this.timeout,
            });
            
            if (txResult.success && txResult.transaction) {
              return { txid: item.tx_hash, height: item.height, tx: txResult.transaction };
            }
          } catch (e) {
            console.warn(`[Electrum] Failed to fetch tx ${item.tx_hash}:`, e);
          }
          return null;
        })
      );
      
      for (const result of results) {
        if (result) {
          const tx = this.convertElectrumTxToApiTx(result.tx, result.height);
          this.transactionCache.set(result.txid, tx);
          transactions.push(tx);
        }
      }
    }
    
    return transactions;
  }

  async getAddressTxCount(address: string): Promise<number> {
    this.ensureElectron();
    const api = getElectronAPI();
    const historyResult = await api.electrumGetHistory({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      address,
      timeout: this.timeout,
    });
    if (!historyResult.success) {
      throw new Error(historyResult.error || 'Failed to get address history via Electrum');
    }
    return historyResult.history.length;
  }

  async getTransaction(txid: string): Promise<ApiTransaction | null> {
    this.ensureElectron();
    
    if (this.transactionCache.has(txid)) {
      return this.transactionCache.get(txid)!;
    }
    
    const api = getElectronAPI();
    const result = await api.electrumGetTransaction({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      txid,
      verbose: true,
      timeout: this.timeout,
    });
    
    if (!result.success || !result.transaction) {
      return null;
    }
    
    const tx = this.convertElectrumTxToApiTx(result.transaction, 0);
    this.transactionCache.set(txid, tx);
    return tx;
  }

  async testConnection(): Promise<{ success: boolean; blockHeight?: number; error?: string; latency?: number }> {
    if (!isElectron()) {
      return { success: false, error: 'Electrum protocol requires the desktop app' };
    }
    
    const api = getElectronAPI();
    const result = await api.electrumTest({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      timeout: this.timeout,
    });
    
    return {
      success: result.success,
      blockHeight: result.blockHeight,
      error: result.error,
      latency: result.latency,
    };
  }

  // Convert Electrum transaction format to our ApiTransaction format
  // Electrum verbose tx format differs from Esplora - handle both BTC and satoshi values
  private convertElectrumTxToApiTx(electrumTx: unknown, height: number): ApiTransaction {
    const tx = electrumTx as {
      txid?: string;
      hash?: string;
      version?: number;
      locktime?: number;
      size?: number;
      vsize?: number;
      weight?: number;
      fee?: number;
      time?: number;
      blocktime?: number;
      confirmations?: number;
      vin?: Array<{
        txid?: string;
        vout?: number;
        sequence?: number;
        txinwitness?: string[];
        scriptSig?: { hex?: string; asm?: string };
        value?: number;
        prevout?: {
          scriptpubkey?: string;
          scriptpubkey_asm?: string;
          scriptpubkey_type?: string;
          scriptpubkey_address?: string;
          value?: number;
        };
      }>;
      vout?: Array<{
        value?: number;
        n?: number;
        scriptPubKey?: {
          hex?: string;
          asm?: string;
          type?: string;
          address?: string;
          addresses?: string[];
        };
      }>;
    };
    
    const firstVoutValue = tx.vout?.[0]?.value || 0;
    const isSatoshis = firstVoutValue > 21_000_000;
    
    const toSatoshis = (val: number | undefined): number => {
      if (val === undefined) return 0;
      return isSatoshis ? Math.round(val) : Math.round(val * 100_000_000);
    };
    
    return {
      txid: tx.txid || tx.hash || '',
      version: tx.version,
      locktime: tx.locktime,
      status: {
        confirmed: height > 0,
        block_height: height > 0 ? height : undefined,
        block_time: tx.blocktime || tx.time,
      },
      fee: tx.fee ? toSatoshis(tx.fee) : 0,
      size: tx.size || 0,
      weight: tx.weight || (tx.vsize ? tx.vsize * 4 : (tx.size ? tx.size * 4 : 0)),
      vin: (tx.vin || []).map(input => ({
        txid: input.txid || '',
        vout: input.vout || 0,
        sequence: input.sequence,
        witness: input.txinwitness,
        prevout: input.prevout ? {
          value: input.prevout.value !== undefined ? toSatoshis(input.prevout.value) : 0,
          scriptpubkey: input.prevout.scriptpubkey,
          scriptpubkey_asm: input.prevout.scriptpubkey_asm,
          scriptpubkey_type: input.prevout.scriptpubkey_type,
          scriptpubkey_address: input.prevout.scriptpubkey_address,
        } : (input.value !== undefined ? {
          value: toSatoshis(input.value),
        } : undefined),
      })),
      vout: (tx.vout || []).map((output, idx) => ({
        value: toSatoshis(output.value),
        n: output.n ?? idx,
        scriptpubkey: output.scriptPubKey?.hex,
        scriptpubkey_asm: output.scriptPubKey?.asm,
        scriptpubkey_type: output.scriptPubKey?.type,
        scriptpubkey_address: output.scriptPubKey?.address || (output.scriptPubKey?.addresses?.[0]),
      })),
    };
  }
}
