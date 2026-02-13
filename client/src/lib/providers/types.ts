import { ScriptType, OpReturnOutput } from '@/lib/database';

export interface BlockchainProvider {
  name: string;
  getBlockHeight(): Promise<number>;
  getAddressTransactions(address: string): Promise<ApiTransaction[]>;
  getAddressTxCount?(address: string): Promise<number>;
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
    prevTxid?: string;
    prevVout?: number;
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

export const DEFAULT_RATE_LIMIT_DELAY = 250;
export const TOR_RATE_LIMIT_DELAY = 500;

export function isLocalOrPrivateUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();
    
    if (hostname.endsWith('.onion')) {
      return false;
    }
    
    const privatePatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^0\./,
      /^169\.254\./,
      /\.local$/i,
    ];
    
    return privatePatterns.some(p => p.test(hostname));
  } catch {
    return false;
  }
}

// Legacy type for backwards compatibility
export type ProviderType = 'mempool' | 'blockstream';

export const MINIMUM_CONFIRMATIONS = 5;

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

export function mapScriptType(apiType: string | undefined): ScriptType {
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

export function hexToText(hex: string): string | undefined {
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

export function extractOpReturnData(scriptpubkey: string | undefined, scriptpubkeyAsm: string | undefined): string {
  if (scriptpubkeyAsm) {
    const parts = scriptpubkeyAsm.split(' ');
    const dataIndex = parts.findIndex(p => p === 'OP_RETURN');
    if (dataIndex >= 0 && parts.length > dataIndex + 1) {
      const dataParts = parts.slice(dataIndex + 1).filter(p => !p.startsWith('OP_'));
      return dataParts.join('');
    }
  }
  
  if (scriptpubkey && scriptpubkey.startsWith('6a') && scriptpubkey.length > 4) {
    const afterOpReturn = scriptpubkey.substring(2);
    const pushOpcode = parseInt(afterOpReturn.substring(0, 2), 16);
    
    if (pushOpcode >= 0x01 && pushOpcode <= 0x4b) {
      return afterOpReturn.substring(2);
    }
    if (pushOpcode === 0x4c && afterOpReturn.length > 4) {
      return afterOpReturn.substring(4);
    }
    if (pushOpcode === 0x4d && afterOpReturn.length > 6) {
      return afterOpReturn.substring(6);
    }
    return afterOpReturn.substring(2);
  }
  return '';
}
