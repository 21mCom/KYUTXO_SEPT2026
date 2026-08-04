import { isElectron, getElectronAPI } from '../electron';
import { BlockchainProvider, ApiTransaction, AddressInfo, AddressHistoryDates } from './types';
import { computeHistoryFromTxs } from './address-history';

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

/**
 * Thrown by getTransaction() when the transaction exists but its confirmation
 * status genuinely cannot be determined — e.g. the server returned raw hex
 * despite the verbose flag, the verbose response carries confirmation
 * evidence (blockhash) but no usable `confirmations` count, or the chain-tip
 * lookup needed to derive a height failed. Callers must NOT treat this as
 * "unconfirmed": the transaction may well be confirmed. Nothing is cached in
 * this case, so a later retry can succeed.
 */
export class ConfirmationStatusUnknownError extends Error {
  constructor(
    message = 'Could not determine confirmation status — check your node connection.',
  ) {
    super(message);
    this.name = 'ConfirmationStatusUnknownError';
  }
}

export class ElectrumProvider implements BlockchainProvider {
  name = 'Electrum Protocol';
  private host: string;
  private port: number;
  private useSSL: boolean;
  private timeout: number;
  private useTor: boolean = false;
  private torProxyUrl?: string;
  private transactionCache: Map<string, ApiTransaction> = new Map();
  private static readonly TX_FETCH_CONCURRENCY = 5;
  // Chain-tip cache backing getTipHeightForDerivation(). Refreshed by every
  // getBlockHeight() call and kept for a short TTL so a batch of txid-driven
  // getTransaction() calls derives heights from one tip lookup instead of one
  // network round-trip per transaction.
  private static readonly TIP_HEIGHT_TTL_MS = 60_000;
  private cachedTipHeight: number | null = null;
  private cachedTipHeightAt = 0;
  private tipHeightFetch: Promise<number> | null = null;
  // blockhash → derived block height, remembered for the session. All
  // transactions in one block share one exact height, so this memo both
  // (a) keeps heights exact for repeat blocks without any tip lookup, and
  // (b) detects a chain tip that advanced mid-batch: if a fetch derives a
  // LOWER height for a blockhash we've already seen, the server's
  // `confirmations` grew against a new tip while we still hold the old
  // cached one — refresh the tip instead of storing an off-by-one height.
  private derivedHeightByBlockHash: Map<string, number> = new Map();

  /**
   * Server's blockhash at a given height, used to verify a derived height for
   * a block the memo has never seen. Returns null on any failure — the caller
   * then keeps its best-effort derivation rather than dropping the height.
   */
  private async getServerBlockHashAtHeight(height: number): Promise<string | null> {
    try {
      const api = getElectronAPI();
      const result = await api.electrumGetBlockHash({
        host: this.host,
        port: this.port,
        useSSL: this.useSSL,
        height,
        timeout: this.timeout,
        ...this.torParams(),
      });
      if (result.success && typeof result.blockHash === 'string' && result.blockHash.length > 0) {
        return result.blockHash;
      }
      return null;
    } catch {
      return null;
    }
  }

  constructor(
    host: string,
    port: number = 50001,
    useSSL: boolean = false,
    timeout: number = 30000,
    torOptions?: { useTor?: boolean; torProxyUrl?: string },
  ) {
    if (!host || host.trim() === '') {
      throw new Error('Electrum host is required');
    }
    this.host = cleanElectrumHost(host);
    this.port = port;
    this.useSSL = useSSL;
    this.timeout = timeout;
    this.useTor = torOptions?.useTor ?? false;
    this.torProxyUrl = torOptions?.torProxyUrl;
    this.name = `Electrum (${this.host}:${port}${this.useTor ? ' via Tor' : ''})`;
    console.log(`[ElectrumProvider] Initialized with ${this.host}:${port} (SSL: ${useSSL}, transport: ${this.useTor ? 'Tor' : 'direct'})`);
  }

  // Tor routing params spread into every IPC call so the main process opens
  // the socket through the SOCKS proxy when Tor is enabled.
  private torParams(): { useTor?: boolean; torProxyUrl?: string } {
    return this.useTor ? { useTor: true, torProxyUrl: this.torProxyUrl } : {};
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
      ...this.torParams(),
    });
    
    if (!result.success || result.blockHeight === undefined) {
      throw new Error(result.error || 'Failed to get block height via Electrum');
    }
    
    // Prime the tip cache used to derive per-transaction heights from
    // confirmation counts. The txid backfill probes getBlockHeight() before a
    // batch run, so its getTransaction() calls reuse this tip for free.
    this.cachedTipHeight = result.blockHeight;
    this.cachedTipHeightAt = Date.now();
    return result.blockHeight;
  }

  /**
   * Chain-tip height used by getTransaction() to convert the server-reported
   * `confirmations` count into a block height. Cached for a short TTL and
   * deduped across concurrent callers, so a batch run (the txid backfill
   * fetches orphans in concurrent chunks) costs at most one tip lookup per
   * TTL window rather than one per transaction. Returns null when the tip
   * cannot be determined — the caller then reports the transaction as
   * unconfirmed (and skips caching it) instead of guessing a height.
   */
  private async getTipHeightForDerivation(): Promise<number | null> {
    if (
      this.cachedTipHeight !== null &&
      Date.now() - this.cachedTipHeightAt < ElectrumProvider.TIP_HEIGHT_TTL_MS
    ) {
      return this.cachedTipHeight;
    }
    if (!this.tipHeightFetch) {
      this.tipHeightFetch = this.getBlockHeight().finally(() => {
        this.tipHeightFetch = null;
      });
    }
    try {
      return await this.tipHeightFetch;
    } catch {
      return null;
    }
  }

  async getAddressTransactions(
    address: string,
    onProgress?: (scanned: number) => void,
    signal?: AbortSignal,
  ): Promise<ApiTransaction[]> {
    this.ensureElectron();
    
    // Bail out before the history lookup if the caller already cancelled.
    if (signal?.aborted) throw new Error('Sync cancelled');
    
    const api = getElectronAPI();
    
    const historyResult = await api.electrumGetHistory({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      address,
      timeout: this.timeout,
      ...this.torParams(),
    });
    
    if (!historyResult.success) {
      throw new Error(historyResult.error || 'Failed to get address history via Electrum');
    }
    
    const transactions: ApiTransaction[] = [];
    let scanned = 0;
    const uncached = historyResult.history.filter(item => {
      if (this.transactionCache.has(item.tx_hash)) {
        transactions.push(this.transactionCache.get(item.tx_hash)!);
        return false;
      }
      return true;
    });
    // Cached txs already counted toward the running scan total.
    scanned = transactions.length;
    if (scanned > 0) onProgress?.(scanned);
    
    for (let i = 0; i < uncached.length; i += ElectrumProvider.TX_FETCH_CONCURRENCY) {
      // Bail out between batches when the user cancels mid-walk. IPC calls
      // themselves cannot be aborted, so this stops after the in-flight batch.
      if (signal?.aborted) throw new Error('Sync cancelled');
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
              ...this.torParams(),
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

      scanned += batch.length;
      onProgress?.(scanned);
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
      ...this.torParams(),
    });
    if (!historyResult.success) {
      throw new Error(historyResult.error || 'Failed to get address history via Electrum');
    }
    return historyResult.history.length;
  }

  // Fast tier: only Transactions (history length) and Balance (sum of unspent
  // outputs) are cheap one-call values on Electrum. Lifetime Received / Sent
  // are NOT available cheaply — they're left undefined and filled later by
  // getAddressHistoryDates.
  async getAddressCoreStats(address: string): Promise<AddressInfo> {
    this.ensureElectron();
    const api = getElectronAPI();

    // Transactions: length of the address history (one call).
    const historyResult = await api.electrumGetHistory({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      address,
      timeout: this.timeout,
      ...this.torParams(),
    });
    if (!historyResult.success) {
      throw new Error(historyResult.error || 'Failed to get address history via Electrum');
    }
    const txCount = historyResult.history.length;

    // Balance: sum of unspent outputs (one call). Reuses the existing
    // electrum-get-utxos IPC rather than adding a new endpoint.
    const utxoResult = await api.electrumGetUtxos({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      address,
      timeout: this.timeout,
      ...this.torParams(),
    });
    if (!utxoResult.success) {
      throw new Error(utxoResult.error || 'Failed to get address UTXOs via Electrum');
    }
    let balanceSats = 0;
    for (const utxo of utxoResult.utxos || []) {
      balanceSats += utxo.value || 0;
    }

    return { txCount, balanceSats };
  }

  // Batch fast-path used by the Address Checker: one IPC round-trip fetches
  // the history (→ tx count) for a whole chunk of addresses over the pooled
  // Electrum connection. Per-address failures are reported in the map so the
  // caller can fall back to per-address calls for just those rows.
  async getAddressTxCountsBatch(
    addresses: string[],
  ): Promise<Map<string, number | { error: string }>> {
    this.ensureElectron();
    const api = getElectronAPI();
    const result = await api.electrumBatchGetHistory({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      addresses,
      timeout: this.timeout,
      ...this.torParams(),
    });
    if (!result.success) {
      throw new Error(result.error || 'Batch history lookup failed');
    }
    const out = new Map<string, number | { error: string }>();
    for (const entry of result.results || []) {
      if (entry.success) {
        out.set(entry.address, (entry.history || []).length);
      } else {
        out.set(entry.address, { error: entry.error || 'History lookup failed' });
      }
    }
    return out;
  }

  // Batch companion to getAddressBalanceSats: one IPC round-trip fetches the
  // unspent outputs for a whole chunk of addresses over the pooled Electrum
  // connection. Per-address failures are reported in the map so the caller
  // can fall back to per-address calls for just those rows.
  async getAddressBalancesBatch(
    addresses: string[],
  ): Promise<Map<string, number | { error: string }>> {
    this.ensureElectron();
    const api = getElectronAPI();
    const result = await api.electrumBatchGetUtxos({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      addresses,
      timeout: this.timeout,
      ...this.torParams(),
    });
    if (!result.success) {
      throw new Error(result.error || 'Batch UTXO lookup failed');
    }
    const out = new Map<string, number | { error: string }>();
    for (const entry of result.results || []) {
      if (entry.success) {
        let balanceSats = 0;
        for (const utxo of entry.utxos || []) {
          balanceSats += utxo.value || 0;
        }
        out.set(entry.address, balanceSats);
      } else {
        out.set(entry.address, { error: entry.error || 'UTXO lookup failed' });
      }
    }
    return out;
  }

  // Cheap single-call balance (sum of unspent outputs), used to complete core
  // stats when the tx count already came from getAddressTxCountsBatch.
  async getAddressBalanceSats(address: string): Promise<number> {
    this.ensureElectron();
    const api = getElectronAPI();
    const utxoResult = await api.electrumGetUtxos({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      address,
      timeout: this.timeout,
      ...this.torParams(),
    });
    if (!utxoResult.success) {
      throw new Error(utxoResult.error || 'Failed to get address UTXOs via Electrum');
    }
    let balanceSats = 0;
    for (const utxo of utxoResult.utxos || []) {
      balanceSats += utxo.value || 0;
    }
    return balanceSats;
  }

  // On-demand tier: walk every transaction to compute Received, Sent and the
  // first/last-seen block times. Electrum verbose txs do NOT carry prevout
  // addresses, so spends can't be detected by matching input addresses (that
  // reports 0 sent). Instead we build the set of outpoints that paid TO this
  // address — every funding output appears in the address history — and detect
  // spends by matching each input's prevout reference (txid:vout) against it.
  async getAddressHistoryDates(
    address: string,
    onProgress?: (scanned: number) => void,
    signal?: AbortSignal,
  ): Promise<AddressHistoryDates> {
    const txs = await this.getAddressTransactions(address, onProgress, signal);
    return computeHistoryFromTxs(address, txs);
  }

  async getTransaction(txid: string, signal?: AbortSignal): Promise<ApiTransaction | null> {
    // Bail out before making an IPC call if the caller has already stopped.
    if (signal?.aborted) throw new Error('Sync cancelled');
    this.ensureElectron();
    
    // Serve cache hits, but never trust a cached UNCONFIRMED entry: the cache
    // has no TTL, so an entry cached while the transaction was in the mempool
    // would otherwise pin "unconfirmed" for the whole session even after the
    // transaction confirms. Re-fetching picks up the current status instead.
    const cached = this.transactionCache.get(txid);
    if (cached && cached.status.confirmed) {
      return cached;
    }
    
    const api = getElectronAPI();
    const result = await api.electrumGetTransaction({
      host: this.host,
      port: this.port,
      useSSL: this.useSSL,
      txid,
      verbose: true,
      timeout: this.timeout,
      ...this.torParams(),
    });
    
    if (!result.success || !result.transaction) {
      return null;
    }
    
    // Electrum's verbose response carries no block height, but it does report
    // a `confirmations` count computed against the server's own tip. Derive
    // the height from the current chain tip so confirmed transactions are not
    // mis-reported as unconfirmed (hardcoding height 0 here made the
    // txid-driven backfill skip every confirmed transaction as "not yet
    // confirmed", so the startup rebuild could never converge). Zero, missing,
    // or negative confirmations (mempool / conflicted) keep the unconfirmed
    // status.
    //
    // NOTE: the address-history path (getAddressTransactions) is untouched —
    // it converts with real per-transaction heights from history entries.
    //
    // When the status genuinely cannot be determined (raw-hex response, no
    // usable `confirmations` despite confirmation evidence, or a failed tip
    // lookup) this throws ConfirmationStatusUnknownError instead of silently
    // converting with height 0 — reporting "unconfirmed" for a long-confirmed
    // transaction is factually wrong and misleads the user.
    if (typeof result.transaction === 'string') {
      // Server ignored the verbose flag and returned raw hex: we have no
      // confirmation data at all.
      throw new ConfirmationStatusUnknownError(
        'Could not determine confirmation status — the Electrum server does not support verbose transaction lookups.',
      );
    }
    const raw = result.transaction as {
      confirmations?: unknown;
      blockhash?: unknown;
      blocktime?: unknown;
    };
    const hasUsableConfirmations =
      typeof raw?.confirmations === 'number' && Number.isFinite(raw.confirmations);
    const confirmations = hasUsableConfirmations ? (raw.confirmations as number) : 0;
    const blockHash =
      typeof raw?.blockhash === 'string' && raw.blockhash.length > 0
        ? raw.blockhash
        : undefined;
    const hasConfirmationEvidence =
      blockHash !== undefined || typeof raw?.blocktime === 'number';
    
    if (!hasUsableConfirmations && hasConfirmationEvidence) {
      // The response carries confirmation evidence (a blockhash/blocktime)
      // but no usable `confirmations` count. Best-effort recovery: if this session
      // already derived an exact height for that block, reuse it. Otherwise
      // the status is unknown, not "unconfirmed".
      const known =
        blockHash !== undefined ? this.derivedHeightByBlockHash.get(blockHash) : undefined;
      if (known !== undefined && known > 0) {
        const tx = this.convertElectrumTxToApiTx(result.transaction, known);
        if (tx.status.confirmed) this.transactionCache.set(txid, tx);
        return tx;
      }
      throw new ConfirmationStatusUnknownError(
        'Could not determine confirmation status — the Electrum server omitted the confirmation count.',
      );
    }
    
    let height = 0;
    if (confirmations > 0) {
      const tip = await this.getTipHeightForDerivation();
      if (tip === null) {
        // The server says the transaction is confirmed, but the tip lookup
        // failed so we cannot derive its height. Best-effort recovery: reuse
        // a height this session already derived for the same block. Failing
        // that, the status is unknown — never report "unconfirmed" here.
        const known = blockHash !== undefined ? this.derivedHeightByBlockHash.get(blockHash) : undefined;
        if (known !== undefined && known > 0) {
          height = known;
        } else {
          throw new ConfirmationStatusUnknownError();
        }
      }
      if (tip !== null) {
        let derived = tip - confirmations + 1;
        if (blockHash !== undefined) {
          const known = this.derivedHeightByBlockHash.get(blockHash);
          if (known !== undefined && derived < known) {
            // Evidence of a new block found mid-batch: this blockhash was
            // already derived at `known`, so a lower value can only mean the
            // server's `confirmations` are now computed against a newer tip
            // than our cached one. Invalidate the cache and re-derive from a
            // fresh tip so this row — and every later one in the batch —
            // stays exact. Costs one extra tip round-trip per real new block,
            // not per transaction.
            this.cachedTipHeightAt = 0;
            const freshTip = await this.getTipHeightForDerivation();
            if (freshTip !== null) derived = freshTip - confirmations + 1;
            // If the refresh failed (or the server raced yet another block),
            // fall back to the memoized exact height for this block.
            if (derived < known) derived = known;
          } else if (known === undefined && derived > 0) {
            // First fetch in a block the memo has NEVER seen: there is no
            // regression evidence available, so a tip that advanced right
            // before this fetch could still make `derived` one block too low.
            // Verify against the server's blockhash at the derived height —
            // one cheap header lookup per new blockhash, skipped for every
            // repeat block via the memo. A mismatch means our cached tip is
            // stale: refresh it and re-derive. If the lookup itself fails,
            // keep the best-effort derivation (previous behavior).
            const serverHash = await this.getServerBlockHashAtHeight(derived);
            if (serverHash !== null && serverHash !== blockHash) {
              this.cachedTipHeightAt = 0;
              const freshTip = await this.getTipHeightForDerivation();
              if (freshTip !== null) derived = freshTip - confirmations + 1;
            }
          }
          if (derived > 0) {
            this.derivedHeightByBlockHash.set(
              blockHash,
              Math.max(known ?? 0, derived),
            );
          }
        }
        // Guard against inconsistent server data (confirmations beyond the
        // tip): the server claims the transaction is confirmed, but we cannot
        // derive a plausible height — status unknown, never "unconfirmed".
        if (derived > 0) {
          height = derived;
        } else {
          throw new ConfirmationStatusUnknownError();
        }
      }
    }
    
    const tx = this.convertElectrumTxToApiTx(result.transaction, height);
    // Only cache entries whose status is settled. Caching an unconfirmed
    // conversion would poison the cache shared with the address-history sync
    // path (and, before the confirmations handling above, DID poison it with
    // a false "unconfirmed" for every txid-driven fetch).
    if (tx.status.confirmed) {
      this.transactionCache.set(txid, tx);
    }
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
      ...this.torParams(),
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
