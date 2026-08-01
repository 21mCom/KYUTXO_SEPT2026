import { ScriptType, OpReturnOutput } from '@/lib/database';

export interface AddressInfo {
  txCount: number;
  /** Undefined when the fast-path could not compute it cheaply (Electrum). */
  receivedSats?: number;
  /** Undefined when the fast-path could not compute it cheaply (Electrum). */
  sentSats?: number;
  balanceSats: number;
  firstSeenTime?: number;
  lastSeenTime?: number;
}

/**
 * Returned by the on-demand history walk. On Electrum, receivedSats / sentSats
 * are also filled here (they cannot be computed cheaply on that protocol).
 */
export interface AddressHistoryDates {
  firstSeenTime?: number;
  lastSeenTime?: number;
  /** Filled by Electrum history path where the fast-path left them blank. */
  receivedSats?: number;
  /** Filled by Electrum history path where the fast-path left them blank. */
  sentSats?: number;
}

export interface BlockchainProvider {
  name: string;
  getBlockHeight(): Promise<number>;
  /** Optional: fetch the hash of the current chain tip. Only available on
   *  Esplora-compatible providers (not Electrum). Used by the proof-of-control
   *  freshness anchor feature. */
  getTipBlockHash?(): Promise<string>;
  getAddressTransactions(
    address: string,
    onProgress?: (scanned: number) => void,
  ): Promise<ApiTransaction[]>;
  getAddressTxCount?(address: string): Promise<number>;
  /** Fetch a single transaction by txid. Pass an AbortSignal to cancel the
   *  in-flight HTTP request if the caller is stopped by the user. */
  getTransaction(txid: string, signal?: AbortSignal): Promise<ApiTransaction | null>;
  testConnection(): Promise<{ success: boolean; blockHeight?: number; error?: string; latency?: number }>;
  /** Optional: cheaply fetch aggregated address stats from the node. */
  getAddressInfo?(address: string): Promise<AddressInfo>;
  /**
   * Fast-tier: return only the cheap core fields without walking history.
   * On Esplora this is a single address-summary call (all four core fields).
   * On Electrum this fills txCount + balanceSats; receivedSats/sentSats are left
   * undefined and will be filled by getAddressHistoryDates.
   */
  getAddressCoreStats?(address: string, signal?: AbortSignal): Promise<AddressInfo>;
  /**
   * Optional batch fast-path: fetch confirmed tx counts for many addresses in
   * one request (Electrum batch history). Returns a map keyed by address —
   * a number on success, `{ error }` for per-address failures. Callers fall
   * back to per-address getAddressCoreStats for addresses missing from the
   * map or when the whole batch throws.
   */
  getAddressTxCountsBatch?(addresses: string[]): Promise<Map<string, number | { error: string }>>;
  /**
   * Optional companion to getAddressTxCountsBatch: the cheap single-call
   * balance lookup (sum of unspent outputs) used to complete core stats when
   * the tx count already came from a batch.
   */
  getAddressBalanceSats?(address: string): Promise<number>;
  /**
   * Optional batch fast-path for balances: fetch the sum of unspent outputs
   * for many addresses in one request (Electrum batch listunspent). Returns a
   * map keyed by address — a number on success, `{ error }` for per-address
   * failures. Callers fall back to per-address getAddressBalanceSats for
   * addresses missing from the map or when the whole batch throws.
   */
  getAddressBalancesBatch?(addresses: string[]): Promise<Map<string, number | { error: string }>>;
  /**
   * On-demand history walk: return first/last seen times (and, on Electrum,
   * also receivedSats / sentSats which cannot be computed cheaply).
   *
   * For addresses with long histories (exchange hot wallets, mining pools) this
   * walks every confirmed transaction and can take many seconds. The optional
   * onProgress callback reports the running count of transactions scanned so the
   * UI can show progress instead of an indeterminate spinner.
   */
  getAddressHistoryDates?(
    address: string,
    onProgress?: (scanned: number) => void,
  ): Promise<AddressHistoryDates>;
}

export interface ApiTransaction {
  txid: string;
  version?: number;
  locktime?: number;
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
    sequence?: number;
    witness?: string[];
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
  /** Wallet fingerprinting fields — populated when the API provides version/locktime/sequence */
  nVersion?: number;
  nLockTime?: number;
  hasRbf?: boolean;
  isBip69Ordered?: boolean;
  hasWitness?: boolean;
  hasCoinbaseInput?: boolean;
  /** Whether at least one input uses a low-R DER signature (Bitcoin Core style) */
  hasLowRSig?: boolean;
  /** True when SOME inputs have SegWit witness data and SOME do not (mixed) */
  hasMixedWitness?: boolean;
  /** True when at least one fingerprint field was successfully captured */
  rawFingerprintCaptured: boolean;
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
    /** Omitted by newer desktop builds: proxy URLs stay out of IPC payloads. */
    url?: string;
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
