// Blockchain API provider for fetching transaction data
// Supports mempool.space, blockstream.info, and self-hosted Electrs/Esplora nodes
// Can route through Tor for privacy when connecting to .onion addresses

import { NodeSettings, NodeProviderType } from '@/lib/database';

export interface BlockchainProvider {
  name: string;
  getBlockHeight(): Promise<number>;
  getAddressTransactions(address: string): Promise<ApiTransaction[]>;
  getTransaction(txid: string): Promise<ApiTransaction | null>;
  testConnection(): Promise<{ success: boolean; blockHeight?: number; error?: string; latency?: number }>;
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

const DEFAULT_RATE_LIMIT_DELAY = 250; // ms between requests to avoid rate limiting
const TOR_RATE_LIMIT_DELAY = 500; // Slower rate limit for Tor connections

// Base class with shared functionality for Esplora-compatible APIs
abstract class EsploraProvider implements BlockchainProvider {
  abstract name: string;
  protected baseUrl: string;
  protected lastRequestTime = 0;
  protected timeout: number;
  protected rateLimitDelay: number;

  constructor(baseUrl: string, timeout: number = 30000, useTor: boolean = false) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = timeout;
    this.rateLimitDelay = useTor ? TOR_RATE_LIMIT_DELAY : DEFAULT_RATE_LIMIT_DELAY;
  }

  protected async rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(`Rate limited by ${this.name}. Please wait a moment and try again.`);
        }
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeout / 1000}s. Try increasing the timeout for slow connections.`);
      }
      throw error;
    }
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

  async testConnection(): Promise<{ success: boolean; blockHeight?: number; error?: string; latency?: number }> {
    const startTime = Date.now();
    try {
      const blockHeight = await this.getBlockHeight();
      const latency = Date.now() - startTime;
      return { success: true, blockHeight, latency };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error',
        latency: Date.now() - startTime
      };
    }
  }
}

// mempool.space public API provider
class MempoolSpaceProvider extends EsploraProvider {
  name = 'mempool.space';

  constructor(network: 'mainnet' | 'testnet' = 'mainnet', timeout: number = 30000) {
    const baseUrl = network === 'mainnet' 
      ? 'https://mempool.space/api'
      : 'https://mempool.space/testnet/api';
    super(baseUrl, timeout, false);
  }
}

// blockstream.info public API provider
class BlockstreamProvider extends EsploraProvider {
  name = 'blockstream.info';

  constructor(network: 'mainnet' | 'testnet' = 'mainnet', timeout: number = 30000) {
    const baseUrl = network === 'mainnet'
      ? 'https://blockstream.info/api'
      : 'https://blockstream.info/testnet/api';
    super(baseUrl, timeout, false);
  }
}

// Custom Electrs/Esplora provider (for self-hosted nodes)
class CustomElectrsProvider extends EsploraProvider {
  name: string;

  constructor(customUrl: string, timeout: number = 30000, useTor: boolean = false) {
    super(customUrl, timeout, useTor);
    // Determine name based on URL
    if (customUrl.includes('.onion')) {
      this.name = 'Custom Electrs (Tor)';
    } else {
      this.name = 'Custom Electrs';
    }
  }
}

// Custom mempool instance provider
class CustomMempoolProvider extends EsploraProvider {
  name: string;

  constructor(customUrl: string, timeout: number = 30000, useTor: boolean = false) {
    // Custom mempool instances use /api path
    const apiUrl = customUrl.endsWith('/api') ? customUrl : `${customUrl}/api`;
    super(apiUrl, timeout, useTor);
    
    if (customUrl.includes('.onion')) {
      this.name = 'Custom Mempool (Tor)';
    } else {
      this.name = 'Custom Mempool';
    }
  }
}

// Legacy type for backwards compatibility
export type ProviderType = 'mempool' | 'blockstream';

// Create a provider from legacy type (for backwards compatibility)
export function createProvider(type: ProviderType = 'mempool', network: 'mainnet' | 'testnet' = 'mainnet'): BlockchainProvider {
  switch (type) {
    case 'blockstream':
      return new BlockstreamProvider(network);
    case 'mempool':
    default:
      return new MempoolSpaceProvider(network);
  }
}

// Create a provider from NodeSettings configuration
export function createProviderFromSettings(settings: NodeSettings): BlockchainProvider {
  const { providerType, customUrl, useTor, requestTimeout, network } = settings;
  
  switch (providerType) {
    case 'blockstream':
      return new BlockstreamProvider(network, requestTimeout);
    
    case 'custom-electrs':
      if (!customUrl) {
        throw new Error('Custom URL is required for custom Electrs provider');
      }
      return new CustomElectrsProvider(customUrl, requestTimeout, useTor);
    
    case 'custom-mempool':
      if (!customUrl) {
        throw new Error('Custom URL is required for custom mempool provider');
      }
      return new CustomMempoolProvider(customUrl, requestTimeout, useTor);
    
    case 'mempool-space':
    default:
      return new MempoolSpaceProvider(network, requestTimeout);
  }
}

// Test connection with given settings without saving
export async function testConnectionWithSettings(settings: NodeSettings): Promise<{
  success: boolean;
  blockHeight?: number;
  error?: string;
  latency?: number;
  providerName: string;
}> {
  try {
    const provider = createProviderFromSettings(settings);
    const result = await provider.testConnection();
    return { ...result, providerName: provider.name };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create provider',
      providerName: 'Unknown',
    };
  }
}

// Get human-readable provider name
export function getProviderDisplayName(providerType: NodeProviderType): string {
  switch (providerType) {
    case 'mempool-space':
      return 'mempool.space (Public)';
    case 'blockstream':
      return 'blockstream.info (Public)';
    case 'custom-electrs':
      return 'Custom Electrs Server';
    case 'custom-mempool':
      return 'Custom Mempool Server';
    default:
      return 'Unknown Provider';
  }
}

// Get privacy warning for provider type
export function getProviderPrivacyInfo(providerType: NodeProviderType, useTor: boolean): {
  level: 'high' | 'medium' | 'low';
  description: string;
} {
  if (providerType === 'custom-electrs' || providerType === 'custom-mempool') {
    if (useTor) {
      return {
        level: 'high',
        description: 'Your own node via Tor. Queries are end-to-end encrypted and your IP is hidden.',
      };
    }
    return {
      level: 'high',
      description: 'Your own node. No third party sees which addresses you query.',
    };
  }
  
  // Public APIs
  if (useTor) {
    return {
      level: 'medium',
      description: 'Public API via Tor. The provider sees your queries but not your IP address.',
    };
  }
  
  return {
    level: 'low',
    description: 'Public API. The provider can see your IP and which addresses you query.',
  };
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
