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
  getAddressTxCountsBatch?(addresses: string[], signal?: AbortSignal): Promise<Map<string, number | { error: string }>>;
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
  getAddressBalancesBatch?(addresses: string[], signal?: AbortSignal): Promise<Map<string, number | { error: string }>>;
  /**
   * On-demand history walk: return first/last seen times (and, on Electrum,
   * also receivedSats / sentSats which cannot be computed cheaply).
   *
   * For addresses with long histories (exchange hot wallets, mining pools) this
   * walks every confirmed transaction and can take many seconds. The optional
   * onProgress callback reports the running count of transactions scanned so the
   * UI can show progress instead of an indeterminate spinner.
   *
   * Pass an AbortSignal to stop the walk promptly (within one in-flight
   * request / between pages) when the user cancels mid-scan.
   */
  getAddressHistoryDates?(
    address: string,
    onProgress?: (scanned: number) => void,
    signal?: AbortSignal,
  ): Promise<AddressHistoryDates>;
  /**
   * Optional: check whether a specific output (txid:vout) has been spent.
   * Available on Esplora-compatible providers via the /tx/:txid/outspend/:vout
   * endpoint. Returns null when the transaction/output is unknown to the node.
   */
  getTxOutspend?(
    txid: string,
    vout: number,
    signal?: AbortSignal,
  ): Promise<{ spent: boolean; spentTxid?: string } | null>;
  /**
   * Optional: list the currently-unspent outpoints for an address (Electrum
   * listunspent). Used to verify a specific outpoint on providers that lack a
   * direct outspend endpoint.
   */
  getAddressUtxoOutpoints?(
    address: string,
    signal?: AbortSignal,
  ): Promise<Array<{ txid: string; vout: number; valueSats: number }>>;
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

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return NaN;
    return Number(part);
  });
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? bytes
    : null;
}

function parseIpv6(hostname: string): number[] | null {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!value.includes(':') || value.includes('%')) return null;

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const groups: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const ipv4 = parseIpv4(token);
      if (ipv4) {
        if (index !== tokens.length - 1) return null;
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      groups.push(parseInt(token, 16));
    }
    return groups;
  };

  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;

  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) return null;
  return [...left, ...Array(zeroCount).fill(0), ...right];
}

export function isLocalOrPrivateHostname(rawHostname: string): boolean {
  const hostname = rawHostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return true;
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  const ipv6 = parseIpv6(hostname);
  if (!ipv6) return false;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:7f00:1) inherits the
  // embedded IPv4 address classification.
  if (
    ipv6.slice(0, 5).every((group) => group === 0) &&
    ipv6[5] === 0xffff
  ) {
    return isLocalOrPrivateHostname(
      `${ipv6[6] >> 8}.${ipv6[6] & 0xff}.${ipv6[7] >> 8}.${ipv6[7] & 0xff}`,
    );
  }

  const isUnspecified = ipv6.every((group) => group === 0);
  const isLoopback = ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1;
  const isUniqueLocal = (ipv6[0] & 0xfe00) === 0xfc00; // fc00::/7
  const isLinkLocal = (ipv6[0] & 0xffc0) === 0xfe80; // fe80::/10
  return isUnspecified || isLoopback || isUniqueLocal || isLinkLocal;
}

export function isLocalOrPrivateUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname;
    
    if (hostname.toLowerCase().endsWith('.onion')) {
      return false;
    }
    return isLocalOrPrivateHostname(hostname);
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
