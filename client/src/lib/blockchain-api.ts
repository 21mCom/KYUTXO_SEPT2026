// Blockchain API provider for fetching transaction data
// Supports mempool.space, blockstream.info, and self-hosted Electrs/Esplora nodes
// Can route through Tor for privacy when connecting to .onion addresses

import { NodeSettings, NodeProviderType, DEFAULT_TRUSTED_LOCAL_HOSTS, OpReturnOutput } from '@/lib/database';
import { isElectron, getElectronAPI } from './electron';
import {
  BlockchainProvider,
  ApiTransaction,
  ParsedTransaction,
  ProviderType,
  TorStatus,
  TorTestResult,
  MINIMUM_CONFIRMATIONS,
  mapScriptType,
  hexToText,
  extractOpReturnData,
} from './providers';
import { MempoolSpaceProvider } from './providers/mempool-space';
import { BlockstreamProvider } from './providers/blockstream';
import { CustomElectrsProvider } from './providers/custom-electrs';
import { CustomMempoolProvider } from './providers/custom-mempool';
import { ElectrumProvider } from './providers/electrum';
import {
  assertFirstSyncConfirmed,
  assertNetworkAccessAllowed,
} from './network-privacy';

export type { BlockchainProvider, ApiTransaction, ParsedTransaction, TorStatus, TorTestResult };
export type { ProviderType };
export { MINIMUM_CONFIRMATIONS };

// Maximum time (ms) to wait on the FIRST live-balance address attempt before
// declaring the node unreachable. Deliberately shorter than the full per-request
// timeout so an unreachable node fails fast instead of hanging address-by-address.
export const NODE_PROBE_TIMEOUT_MS = 5000;

// After a successful start, this many consecutive node-unreachable failures means
// the node went down mid-check: short-circuit the whole live-balance check instead
// of grinding through every remaining address one full timeout at a time. Isolated
// single transient failures stay below this threshold and surface per-row.
export const NODE_UNREACHABLE_CONSECUTIVE_LIMIT = 3;

function guardProvider(provider: BlockchainProvider): BlockchainProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        // Re-check the live runtime policy before every provider operation.
        // This is the enforcement boundary shared by current and future pages.
        assertNetworkAccessAllowed();
        if (typeof property === 'string' && property.startsWith('getAddress')) {
          assertFirstSyncConfirmed();
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

// Classify an error as a node-level connectivity failure (node down, refused,
// DNS failure, proxy failure, or our short probe timeout) rather than a
// transient/per-address error (e.g. a single 404/500 or rate limit). Used by the
// live-balance path to decide whether to fail the whole check up front.
export function isNodeUnreachableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  // Our short probe aborts with a TimeoutError, and the message we throw on the
  // race begins with "Node unreachable".
  if (name === 'TimeoutError') return true;
  return /node unreachable|failed to fetch|networkerror|network request failed|fetch failed|tor proxy request failed|econnrefused|enotfound|ehostunreach|etimedout|connection refused|timed out|getaddrinfo/i.test(
    message,
  );
}

// Create a provider from legacy type (for backwards compatibility)
export function createProvider(type: ProviderType = 'mempool', network: 'mainnet' | 'testnet' = 'mainnet'): BlockchainProvider {
  switch (type) {
    case 'blockstream':
      return guardProvider(new BlockstreamProvider(network));
    case 'mempool':
    default:
      return guardProvider(new MempoolSpaceProvider(network));
  }
}

// Create a provider from NodeSettings configuration
export function createProviderFromSettings(settings: NodeSettings): BlockchainProvider {
  assertNetworkAccessAllowed(settings);
  const { providerType, customUrl, useTor, requestTimeout, network, torProxyUrl, trustedLocalHosts, allowLocalNetwork } = settings;
  // Only use trusted local hosts when allowLocalNetwork is explicitly enabled (SECURITY)
  // This prevents accidental local network access on public networks
  const localHosts = allowLocalNetwork ? (trustedLocalHosts || [...DEFAULT_TRUSTED_LOCAL_HOSTS]) : [];
  
  // Use Electrum protocol if enabled and configured (EXCLUSIVELY - no HTTP fallback)
  if (settings.useElectrum && settings.electrumHost && isElectron()) {
    console.log(`[BlockchainAPI] Using Electrum protocol exclusively (${settings.electrumHost}:${settings.electrumPort || 50001})`);
    return guardProvider(new ElectrumProvider(
      settings.electrumHost,
      settings.electrumPort || 50001,
      settings.electrumSSL || false,
      requestTimeout,
      // Route Electrum through the configured Tor SOCKS proxy when Tor is on
      // (also enables .onion Electrum hosts).
      { useTor, torProxyUrl }
    ));
  }
  
  // Log which HTTP provider is being used
  console.log(`[BlockchainAPI] Using HTTP provider: ${providerType}`);
  if (settings.useElectrum && !isElectron()) {
    console.warn('[BlockchainAPI] Electrum enabled but not in Electron - falling back to HTTP provider');
  }
  
  switch (providerType) {
    case 'blockstream':
      return guardProvider(new BlockstreamProvider(network, requestTimeout, useTor, torProxyUrl, localHosts));
    
    case 'custom-electrs':
      if (!customUrl) {
        throw new Error('Custom URL is required for custom Electrs provider');
      }
      return guardProvider(new CustomElectrsProvider(customUrl, requestTimeout, useTor, torProxyUrl, localHosts));
    
    case 'custom-mempool':
      if (!customUrl) {
        throw new Error('Custom URL is required for custom mempool provider');
      }
      return guardProvider(new CustomMempoolProvider(customUrl, requestTimeout, useTor, torProxyUrl, localHosts));
    
    case 'mempool-space':
    default:
      return guardProvider(new MempoolSpaceProvider(network, requestTimeout, useTor, torProxyUrl, localHosts));
  }
}

// Test connection with given settings without saving
export async function testConnectionWithSettings(settings: NodeSettings): Promise<{
  success: boolean;
  blockHeight?: number;
  error?: string;
  latency?: number;
  providerName: string;
  testedUrl?: string;
}> {
  try {
    const provider = createProviderFromSettings(settings);
    const result = await provider.testConnection();
    
    // Include the tested URL for diagnostics (helps users verify their config)
    let testedUrl: string | undefined;
    if (settings.providerType === 'custom-mempool' && settings.customUrl) {
      const baseUrl = settings.customUrl.endsWith('/api') 
        ? settings.customUrl 
        : `${settings.customUrl}/api`;
      testedUrl = `${baseUrl}/blocks/tip/height`;
    }
    
    return { ...result, providerName: provider.name, testedUrl };
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
  const opReturnData: OpReturnOutput[] = [];

  for (const vin of tx.vin) {
    const isCoinbase = !vin.txid || /^0{64}$/.test(vin.txid);
    if (isCoinbase) continue;

    inputs.push({
      address: vin.prevout?.scriptpubkey_address || '',
      amount: vin.prevout?.value ?? 0,
      scriptType: vin.prevout?.scriptpubkey_type ? mapScriptType(vin.prevout.scriptpubkey_type) : undefined,
      prevTxid: vin.txid,
      prevVout: vin.vout,
    });
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

  // ── Wallet fingerprinting extraction ─────────────────────────────────────
  // Fields available from the esplora/mempool API when present in the raw tx.
  const hasCoinbaseInput = tx.vin.some(v => !v.txid || /^0{64}$/.test(v.txid));
  const nVersion: number | undefined = tx.version;
  const nLockTime: number | undefined = tx.locktime;
  // hasRbf = true when ALL inputs signal RBF (nSequence < 0xFFFFFFFE).
  // Bitcoin Core sets nSequence = 0xFFFFFFFD on ALL inputs by default, so
  // a tx where every input is < 0xFFFFFFFE is a Bitcoin Core fingerprint.
  // A tx where ANY input has nSequence >= 0xFFFFFFFE does not fully signal RBF.
  const hasRbf: boolean | undefined =
    tx.vin.some(v => v.sequence !== undefined)
      ? tx.vin.every(v => typeof v.sequence === 'number' && v.sequence < 0xFFFFFFFE)
      : undefined;

  // Witness detection and mixed-witness fingerprinting
  const witnessAvailable = tx.vin.some(v => v.witness !== undefined);
  const hasWitness: boolean | undefined = witnessAvailable
    ? tx.vin.some(v => Array.isArray(v.witness) && v.witness.length > 0)
    : undefined;
  // Mixed witness: some inputs have witness data, some do not → wallet fingerprint
  const hasMixedWitness: boolean | undefined = witnessAvailable
    ? tx.vin.some(v => Array.isArray(v.witness) && v.witness.length > 0) &&
      tx.vin.some(v => !Array.isArray(v.witness) || v.witness.length === 0)
    : undefined;

  // Low-R DER signature detection from witness data.
  // Bitcoin Core and privacy wallets use low-R grinding: R first byte < 0x80
  // (no DER 0x00 padding prefix needed). Detectable from SegWit witness[0].
  function isLowRDERSig(sigHex: string): boolean {
    if (!sigHex || sigHex.length < 8) return false;
    const bytes: number[] = [];
    for (let i = 0; i + 1 < sigHex.length; i += 2) {
      bytes.push(parseInt(sigHex.slice(i, i + 2), 16));
    }
    if (bytes.length < 6 || bytes[0] !== 0x30 || bytes[2] !== 0x02) return false;
    const rStart = 4;
    if (rStart >= bytes.length) return false;
    return bytes[rStart] < 0x80; // high bit clear → low-R (no leading 0x00 padding)
  }
  const hasLowRSig: boolean | undefined = witnessAvailable
    ? tx.vin.some(v => Array.isArray(v.witness) && v.witness.some(w => isLowRDERSig(w)))
    : undefined;

  // BIP69: inputs sorted by txid+vout lex, outputs sorted by value then scriptpubkey
  let isBip69Ordered: boolean | undefined;
  if (tx.vin.every(v => v.txid !== undefined && v.vout !== undefined)) {
    const inputsSorted = [...tx.vin].sort((a, b) => {
      const cmp = a.txid.localeCompare(b.txid);
      return cmp !== 0 ? cmp : a.vout - b.vout;
    });
    const inputsBip69 = tx.vin.every((v, i) => v.txid === inputsSorted[i].txid && v.vout === inputsSorted[i].vout);
    const outputsSorted = [...tx.vout].sort((a, b) => {
      if (a.value !== b.value) return a.value - b.value;
      return (a.scriptpubkey ?? '').localeCompare(b.scriptpubkey ?? '');
    });
    const outputsBip69 = tx.vout.every((v, i) => v.n === outputsSorted[i].n);
    isBip69Ordered = inputsBip69 && outputsBip69;
  }

  const rawFingerprintCaptured = nVersion !== undefined || nLockTime !== undefined;

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
    nVersion,
    nLockTime,
    hasRbf,
    isBip69Ordered,
    hasWitness,
    hasCoinbaseInput,
    hasLowRSig,
    hasMixedWitness,
    rawFingerprintCaptured,
  };
}

// Tor connectivity testing
// Test if Tor is available and working. The proxies tested (including the
// user's configured custom SOCKS proxy) come from server-side settings — sync
// settings via syncTorProxySettings first if unsaved changes should apply.
export async function testTorConnectivity(settings?: NodeSettings): Promise<TorTestResult> {
  try {
    assertNetworkAccessAllowed(settings);
    if (isElectron()) {
      const electronAPI = getElectronAPI();
      return await electronAPI.torTest();
    } else {
      const response = await fetch('/api/tor/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
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
