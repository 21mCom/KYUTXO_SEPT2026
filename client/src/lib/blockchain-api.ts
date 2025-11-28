// Blockchain API provider for fetching transaction data
// Supports mempool.space (default) with future support for local Bitcoin node

export interface BlockchainProvider {
  name: string;
  getBlockHeight(): Promise<number>;
  getAddressTransactions(address: string): Promise<ApiTransaction[]>;
  getTransaction(txid: string): Promise<ApiTransaction | null>;
}

export interface ApiTransaction {
  txid: string;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_time?: number;
  };
  fee: number;
  weight: number;
  vin: Array<{
    txid: string;
    vout: number;
    prevout?: {
      scriptpubkey_address?: string;
      value: number;
    };
  }>;
  vout: Array<{
    scriptpubkey_address?: string;
    value: number;
    n: number;
  }>;
}

export interface ParsedTransaction {
  txid: string;
  blockHeight: number;
  blockTime: number;
  fee: number;
  feeRate: number;
  inputs: Array<{
    address: string;
    amount: number;
  }>;
  outputs: Array<{
    address: string;
    amount: number;
    vout: number;
  }>;
}

const RATE_LIMIT_DELAY = 250; // ms between requests to avoid rate limiting

class MempoolSpaceProvider implements BlockchainProvider {
  name = 'mempool.space';
  private baseUrl: string;
  private lastRequestTime = 0;

  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    this.baseUrl = network === 'mainnet' 
      ? 'https://mempool.space/api'
      : 'https://mempool.space/testnet/api';
  }

  private async rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
    
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Rate limited by mempool.space. Please wait a moment and try again.');
      }
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  async getBlockHeight(): Promise<number> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/blocks/tip/height`);
    return response.json();
  }

  async getAddressTransactions(address: string): Promise<ApiTransaction[]> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/address/${address}/txs`);
    return response.json();
  }

  async getTransaction(txid: string): Promise<ApiTransaction | null> {
    try {
      const response = await this.rateLimitedFetch(`${this.baseUrl}/tx/${txid}`);
      return response.json();
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }
}

class BlockstreamProvider implements BlockchainProvider {
  name = 'blockstream.info';
  private baseUrl: string;
  private lastRequestTime = 0;

  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    this.baseUrl = network === 'mainnet'
      ? 'https://blockstream.info/api'
      : 'https://blockstream.info/testnet/api';
  }

  private async rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
    
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Rate limited by blockstream.info. Please wait a moment and try again.');
      }
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  async getBlockHeight(): Promise<number> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/blocks/tip/height`);
    return response.json();
  }

  async getAddressTransactions(address: string): Promise<ApiTransaction[]> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/address/${address}/txs`);
    return response.json();
  }

  async getTransaction(txid: string): Promise<ApiTransaction | null> {
    try {
      const response = await this.rateLimitedFetch(`${this.baseUrl}/tx/${txid}`);
      return response.json();
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }
}

export type ProviderType = 'mempool' | 'blockstream';

export function createProvider(type: ProviderType = 'mempool', network: 'mainnet' | 'testnet' = 'mainnet'): BlockchainProvider {
  switch (type) {
    case 'blockstream':
      return new BlockstreamProvider(network);
    case 'mempool':
    default:
      return new MempoolSpaceProvider(network);
  }
}

export function parseTransaction(tx: ApiTransaction): ParsedTransaction | null {
  if (!tx.status.confirmed || !tx.status.block_height || !tx.status.block_time) {
    return null;
  }

  const inputs: ParsedTransaction['inputs'] = [];
  const outputs: ParsedTransaction['outputs'] = [];

  for (const vin of tx.vin) {
    if (vin.prevout?.scriptpubkey_address) {
      inputs.push({
        address: vin.prevout.scriptpubkey_address,
        amount: vin.prevout.value,
      });
    }
  }

  for (const vout of tx.vout) {
    if (vout.scriptpubkey_address) {
      outputs.push({
        address: vout.scriptpubkey_address,
        amount: vout.value,
        vout: vout.n,
      });
    }
  }

  const feeRate = tx.weight > 0 ? Math.round((tx.fee / tx.weight) * 4) : 0;

  return {
    txid: tx.txid,
    blockHeight: tx.status.block_height,
    blockTime: tx.status.block_time,
    fee: tx.fee,
    feeRate,
    inputs,
    outputs,
  };
}

export const MINIMUM_CONFIRMATIONS = 5;
