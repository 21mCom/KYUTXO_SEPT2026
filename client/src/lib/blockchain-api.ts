// Blockchain API provider for fetching transaction data
// Supports mempool.space, blockstream.info, and self-hosted Electrs/Esplora nodes
// Can route through Tor for privacy when connecting to .onion addresses

import { NodeSettings, NodeProviderType, ScriptType, OpReturnOutput } from '@/lib/database';
import { isElectron, getElectronAPI, TorRequestResult as ElectronTorRequestResult, TorStatusResult as ElectronTorStatusResult, TorTestResult as ElectronTorTestResult } from './electron';

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
  size: number;
  weight: number;
  vin: Array<{
    txid: string;
    vout: number;
    prevout?: {
      scriptpubkey?: string;
      scriptpubkey_asm?: string;
      scriptpubkey_type?: string;
      scriptpubkey_address?: string;
      value: number;
    };
  }>;
  vout: Array<{
    scriptpubkey?: string;
    scriptpubkey_asm?: string;
    scriptpubkey_type?: string;
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
  size: number;
  weight: number;
  vsize: number;
  inputs: Array<{
    address: string;
    amount: number;
    scriptType?: ScriptType;
    prevTxid?: string;  // The txid of the transaction that created this UTXO (undefined for coinbase)
    prevVout?: number;  // The output index in that transaction (undefined for coinbase)
  }>;
  outputs: Array<{
    address: string;
    amount: number;
    vout: number;
    scriptType?: ScriptType;
  }>;
  hasOpReturn: boolean;
  opReturnData: OpReturnOutput[];
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
  protected useTor: boolean;
  protected torProxyUrl?: string;

  constructor(baseUrl: string, timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = timeout;
    this.rateLimitDelay = useTor ? TOR_RATE_LIMIT_DELAY : DEFAULT_RATE_LIMIT_DELAY;
    this.useTor = useTor;
    this.torProxyUrl = torProxyUrl;
  }

  protected async rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
    
    // Route through backend Tor proxy if enabled
    if (this.useTor) {
      return this.torProxiedFetch(url);
    }
    
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

  protected async torProxiedFetch(url: string): Promise<Response> {
    let result: {
      success: boolean;
      status?: number;
      statusText?: string;
      data?: unknown;
      error?: string;
      latency?: number;
      contentType?: string;
    };

    // Use Electron IPC in portable app, or backend API in dev mode
    if (isElectron()) {
      const electronAPI = getElectronAPI();
      result = await electronAPI.torRequest({
        url,
        method: 'GET',
        timeout: this.timeout,
        torProxyUrl: this.torProxyUrl,
        allowedHost: this.baseUrl,
      });
    } else {
      const proxyResponse = await fetch('/api/tor/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          method: 'GET',
          timeout: this.timeout,
          torProxyUrl: this.torProxyUrl,
          allowedHost: this.baseUrl,
        }),
      });
      result = await proxyResponse.json();
    }

    // Handle proxy-level errors (connection failed, timeout, etc.)
    if (!result.success && !result.status) {
      throw new Error(result.error || 'Tor proxy request failed');
    }

    // Handle HTTP-level errors with better context
    if (!result.success && result.status) {
      const status = result.status;
      const statusText = result.statusText || 'Unknown';
      
      if (status === 429) {
        throw new Error(`Rate limited by ${this.name} (via Tor). Please wait a moment and try again.`);
      }
      if (status === 403) {
        throw new Error(`Access forbidden by ${this.name}. Status: ${status} ${statusText}`);
      }
      if (status >= 500) {
        throw new Error(`Server error from ${this.name}: ${status} ${statusText}`);
      }
      throw new Error(`API request failed: ${status} ${statusText}${result.error ? ` - ${result.error}` : ''}`);
    }

    // Use upstream content-type if available, otherwise determine from data
    const contentType = result.contentType || 
      (typeof result.data === 'object' && result.data !== null ? 'application/json' : 'text/plain');
    
    const responseBody = typeof result.data === 'string' 
      ? result.data 
      : JSON.stringify(result.data);
    
    return new Response(responseBody, {
      status: result.status || 200,
      statusText: result.statusText || 'OK',
      headers: { 'Content-Type': contentType },
    });
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

  constructor(network: 'mainnet' | 'testnet' = 'mainnet', timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string) {
    const baseUrl = network === 'mainnet' 
      ? 'https://mempool.space/api'
      : 'https://mempool.space/testnet/api';
    super(baseUrl, timeout, useTor, torProxyUrl);
    if (useTor) {
      this.name = 'mempool.space (via Tor)';
    }
  }
}

// blockstream.info public API provider
class BlockstreamProvider extends EsploraProvider {
  name = 'blockstream.info';

  constructor(network: 'mainnet' | 'testnet' = 'mainnet', timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string) {
    const baseUrl = network === 'mainnet'
      ? 'https://blockstream.info/api'
      : 'https://blockstream.info/testnet/api';
    super(baseUrl, timeout, useTor, torProxyUrl);
    if (useTor) {
      this.name = 'blockstream.info (via Tor)';
    }
  }
}

// Custom Electrs/Esplora provider (for self-hosted nodes)
class CustomElectrsProvider extends EsploraProvider {
  name: string;

  constructor(customUrl: string, timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string) {
    super(customUrl, timeout, useTor, torProxyUrl);
    // Determine name based on URL
    if (customUrl.includes('.onion')) {
      this.name = 'Custom Electrs (Tor)';
    } else if (useTor) {
      this.name = 'Custom Electrs (via Tor)';
    } else {
      this.name = 'Custom Electrs';
    }
  }
}

// Custom mempool instance provider
class CustomMempoolProvider extends EsploraProvider {
  name: string;

  constructor(customUrl: string, timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string) {
    // Custom mempool instances use /api path
    const apiUrl = customUrl.endsWith('/api') ? customUrl : `${customUrl}/api`;
    super(apiUrl, timeout, useTor, torProxyUrl);
    
    if (customUrl.includes('.onion')) {
      this.name = 'Custom Mempool (Tor)';
    } else if (useTor) {
      this.name = 'Custom Mempool (via Tor)';
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
  const { providerType, customUrl, useTor, requestTimeout, network, torProxyUrl } = settings;
  
  switch (providerType) {
    case 'blockstream':
      return new BlockstreamProvider(network, requestTimeout, useTor, torProxyUrl);
    
    case 'custom-electrs':
      if (!customUrl) {
        throw new Error('Custom URL is required for custom Electrs provider');
      }
      return new CustomElectrsProvider(customUrl, requestTimeout, useTor, torProxyUrl);
    
    case 'custom-mempool':
      if (!customUrl) {
        throw new Error('Custom URL is required for custom mempool provider');
      }
      return new CustomMempoolProvider(customUrl, requestTimeout, useTor, torProxyUrl);
    
    case 'mempool-space':
    default:
      return new MempoolSpaceProvider(network, requestTimeout, useTor, torProxyUrl);
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

function mapScriptType(apiType: string | undefined): ScriptType {
  if (!apiType) return 'unknown';
  const typeMap: Record<string, ScriptType> = {
    'p2pkh': 'p2pkh',
    'p2sh': 'p2sh',
    'v0_p2wpkh': 'v0_p2wpkh',
    'v0_p2wsh': 'v0_p2wsh',
    'v1_p2tr': 'v1_p2tr',
    'p2pk': 'p2pk',
    'op_return': 'op_return',
    'multisig': 'multisig',
    'nonstandard': 'nonstandard',
  };
  return typeMap[apiType] || 'unknown';
}

function hexToText(hex: string): string | undefined {
  try {
    const bytes = hex.match(/.{1,2}/g);
    if (!bytes) return undefined;
    const text = bytes.map(b => String.fromCharCode(parseInt(b, 16))).join('');
    if (/^[\x20-\x7E\n\r\t]*$/.test(text)) {
      return text;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractOpReturnData(scriptpubkey: string | undefined, scriptpubkeyAsm: string | undefined): string {
  // Prefer ASM format which gives us the decoded data directly
  if (scriptpubkeyAsm) {
    const parts = scriptpubkeyAsm.split(' ');
    const dataIndex = parts.findIndex(p => p === 'OP_RETURN');
    if (dataIndex >= 0 && parts.length > dataIndex + 1) {
      // Filter out OP_ codes and join remaining hex data parts
      const dataParts = parts.slice(dataIndex + 1).filter(p => !p.startsWith('OP_'));
      return dataParts.join('');
    }
  }
  
  // Fallback to raw hex parsing if ASM not available
  // OP_RETURN scripts: 6a (OP_RETURN) + push opcode + data
  if (scriptpubkey && scriptpubkey.startsWith('6a') && scriptpubkey.length > 4) {
    const afterOpReturn = scriptpubkey.substring(2); // Skip '6a' (OP_RETURN)
    const pushOpcode = parseInt(afterOpReturn.substring(0, 2), 16);
    
    // Direct push: 0x01-0x4b (1-75 bytes) - length is the opcode itself
    if (pushOpcode >= 0x01 && pushOpcode <= 0x4b) {
      return afterOpReturn.substring(2); // Skip the length byte, return data
    }
    // OP_PUSHDATA1 (0x4c): next byte is length, then data
    if (pushOpcode === 0x4c && afterOpReturn.length > 4) {
      return afterOpReturn.substring(4); // Skip 4c + length byte
    }
    // OP_PUSHDATA2 (0x4d): next 2 bytes are length, then data
    if (pushOpcode === 0x4d && afterOpReturn.length > 6) {
      return afterOpReturn.substring(6); // Skip 4d + 2 length bytes
    }
    // OP_0 or unknown - just return everything after OP_RETURN
    return afterOpReturn.substring(2);
  }
  return '';
}

export function parseTransaction(tx: ApiTransaction): ParsedTransaction | null {
  if (!tx.status.confirmed || !tx.status.block_height || !tx.status.block_time) {
    return null;
  }

  const inputs: ParsedTransaction['inputs'] = [];
  const outputs: ParsedTransaction['outputs'] = [];
  const opReturnData: OpReturnOutput[] = [];

  for (const vin of tx.vin) {
    if (vin.prevout?.scriptpubkey_address) {
      inputs.push({
        address: vin.prevout.scriptpubkey_address,
        amount: vin.prevout.value,
        scriptType: mapScriptType(vin.prevout.scriptpubkey_type),
        prevTxid: vin.txid,   // The transaction that created the UTXO being spent
        prevVout: vin.vout,   // The output index in that transaction
      });
    }
  }

  for (const vout of tx.vout) {
    const scriptType = mapScriptType(vout.scriptpubkey_type);
    
    if (scriptType === 'op_return') {
      const dataHex = extractOpReturnData(vout.scriptpubkey, vout.scriptpubkey_asm);
      opReturnData.push({
        vout: vout.n,
        dataHex,
        dataText: hexToText(dataHex),
        dataAsm: vout.scriptpubkey_asm,
      });
    } else if (vout.scriptpubkey_address) {
      outputs.push({
        address: vout.scriptpubkey_address,
        amount: vout.value,
        vout: vout.n,
        scriptType,
      });
    }
  }

  const feeRate = tx.weight > 0 ? Math.round((tx.fee / tx.weight) * 4) : 0;
  const vsize = tx.weight > 0 ? Math.ceil(tx.weight / 4) : tx.size || 0;

  return {
    txid: tx.txid,
    blockHeight: tx.status.block_height,
    blockTime: tx.status.block_time,
    fee: tx.fee,
    feeRate,
    size: tx.size || 0,
    weight: tx.weight || 0,
    vsize,
    inputs,
    outputs,
    hasOpReturn: opReturnData.length > 0,
    opReturnData,
  };
}

export const MINIMUM_CONFIRMATIONS = 5;

// Tor connectivity testing
export interface TorStatus {
  torAvailable: boolean;
  proxies: Array<{
    name: string;
    url: string;
    port: number;
    available: boolean;
    isTor?: boolean;
    exitIp?: string;
    latency?: number;
    error?: string;
  }>;
  recommendation: string;
}

export interface TorTestResult {
  success: boolean;
  proxyUrl?: string;
  proxyName?: string;
  isTor?: boolean;
  torIp?: string;
  latency?: number;
  message?: string;
  error?: string;
  testedProxies?: string[];
}

// Test if Tor is available and working
export async function testTorConnectivity(customProxyUrl?: string): Promise<TorTestResult> {
  try {
    // Use Electron IPC in portable app, or backend API in dev mode
    if (isElectron()) {
      const electronAPI = getElectronAPI();
      return await electronAPI.torTest(customProxyUrl);
    } else {
      const response = await fetch('/api/tor/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ torProxyUrl: customProxyUrl }),
      });
      return await response.json();
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to test Tor connectivity',
    };
  }
}

// Get current Tor status (checks all known proxy ports)
export async function getTorStatus(): Promise<TorStatus> {
  try {
    // Use Electron IPC in portable app, or backend API in dev mode
    if (isElectron()) {
      const electronAPI = getElectronAPI();
      return await electronAPI.torStatus();
    } else {
      const response = await fetch('/api/tor/status');
      return await response.json();
    }
  } catch (error) {
    return {
      torAvailable: false,
      proxies: [],
      recommendation: error instanceof Error ? error.message : 'Failed to check Tor status',
    };
  }
}
