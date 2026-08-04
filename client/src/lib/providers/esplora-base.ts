import { isElectron, getElectronAPI } from '../electron';
import { syncTorProxySettings, invalidateTorProxySettingsSync } from '../tor-proxy-settings-sync';
import { BlockchainProvider, ApiTransaction, AddressInfo, AddressHistoryDates, DEFAULT_RATE_LIMIT_DELAY, TOR_RATE_LIMIT_DELAY, isLocalOrPrivateUrl } from './types';

// Base class with shared functionality for Esplora-compatible APIs
export abstract class EsploraProvider implements BlockchainProvider {
  abstract name: string;
  protected baseUrl: string;
  protected lastRequestTime = 0;
  protected timeout: number;
  protected rateLimitDelay: number;
  protected useTor: boolean;
  protected torProxyUrl?: string;
  protected trustedLocalHosts: string[];

  constructor(baseUrl: string, timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string, trustedLocalHosts: string[] = []) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeout = timeout;
    this.rateLimitDelay = useTor ? TOR_RATE_LIMIT_DELAY : DEFAULT_RATE_LIMIT_DELAY;
    this.useTor = useTor;
    this.torProxyUrl = torProxyUrl;
    this.trustedLocalHosts = trustedLocalHosts;
  }

  protected async rateLimitedFetch(url: string, externalSignal?: AbortSignal): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
    
    if (this.useTor) {
      return this.torProxiedFetch(url, externalSignal);
    }
    
    if (isElectron() && isLocalOrPrivateUrl(url)) {
      return this.torProxiedFetch(url, externalSignal);
    }
    
    // Combine the caller's abort signal with the per-request timeout signal so
    // either a user-initiated stop OR a timeout cancels the in-flight request.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutId);
        controller.abort();
      } else {
        onExternalAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(`Rate limited by ${this.name}. Please wait a moment and try again.`);
        }
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        // Distinguish user-cancelled abort from a timeout abort.
        if (externalSignal?.aborted) {
          throw new Error('Sync cancelled');
        }
        throw new Error(`Request timed out after ${this.timeout / 1000}s. Try increasing the timeout for slow connections.`);
      }
      throw error;
    }
  }

  protected async torProxiedFetch(url: string, externalSignal?: AbortSignal): Promise<Response> {
    // Bail out immediately if already cancelled before launching any IPC/fetch.
    if (externalSignal?.aborted) throw new Error('Sync cancelled');

    let result: {
      success: boolean;
      status?: number;
      statusText?: string;
      data?: unknown;
      error?: string;
      latency?: number;
      contentType?: string;
    };

    const startTime = Date.now();

    // Ensure the proxy's server-side allowlist knows this provider's host (and
    // the configured trusted local hosts / SOCKS proxy) before requesting.
    // Deduped: only re-pushes when the payload actually changes.
    await syncTorProxySettings({
      customProviderUrl: this.baseUrl,
      trustedLocalHosts: this.trustedLocalHosts,
      torProxyUrl: this.torProxyUrl,
    });

    if (isElectron()) {
      const electronAPI = getElectronAPI();
      console.log(`[KYUTXO] [${new Date().toISOString()}] Calling Electron IPC torRequest...`);
      // Electron IPC cannot be aborted mid-flight, so we race the call against
      // the external signal to stop waiting for its result on cancellation.
      const ipcPromise = electronAPI.torRequest({
        url,
        method: 'GET',
        timeout: this.timeout,
      });
      if (externalSignal) {
        result = await new Promise<typeof result>((resolve, reject) => {
          const onAbort = () => reject(new Error('Sync cancelled'));
          externalSignal.addEventListener('abort', onAbort, { once: true });
          ipcPromise.then(
            (v) => { externalSignal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { externalSignal.removeEventListener('abort', onAbort); reject(e); },
          );
        });
      } else {
        result = await ipcPromise;
      }
      console.log(`[KYUTXO] [${new Date().toISOString()}] Electron IPC returned - success: ${result.success}, elapsed: ${Date.now() - startTime}ms`);
    } else {
      // Browser proxy path: pass the external signal so the connection to our
      // local proxy server is aborted when the user stops the resolve.
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          method: 'GET',
          timeout: this.timeout,
        }),
        signal: externalSignal,
      };
      let proxyResponse = await fetch('/api/tor/request', requestInit);
      if (proxyResponse.status === 428) {
        // The server lost its synced settings (e.g. it restarted). Re-push and
        // retry once before surfacing the failure.
        invalidateTorProxySettingsSync();
        await syncTorProxySettings(
          {
            customProviderUrl: this.baseUrl,
            trustedLocalHosts: this.trustedLocalHosts,
            torProxyUrl: this.torProxyUrl,
          },
          { force: true },
        );
        proxyResponse = await fetch('/api/tor/request', requestInit);
      }
      result = await proxyResponse.json();
    }

    if (!result.success && !result.status) {
      throw new Error(result.error || 'Tor proxy request failed');
    }

    if (!result.success && result.status) {
      const status = result.status;
      const statusText = result.statusText || 'Unknown';
      
      if (status === 429) {
        throw new Error(`Rate limited by ${this.name} (via Tor). Please wait a moment and try again.`);
      }
      if (status === 403) {
        throw new Error(`Access forbidden by ${this.name}. Status: ${status} ${statusText}`);
      }
      if (status === 502) {
        throw new Error(`${this.name} returned 502 Bad Gateway. This usually means the Mempool service on your node isn't running. Check that Mempool is installed and running on your Umbrel/node.`);
      }
      if (status === 503) {
        throw new Error(`${this.name} returned 503 Service Unavailable. The Mempool service may be starting up or overloaded.`);
      }
      if (status === 504) {
        throw new Error(`${this.name} returned 504 Gateway Timeout. The connection to your node's Mempool service timed out.`);
      }
      if (status >= 500) {
        throw new Error(`Server error from ${this.name}: ${status} ${statusText}`);
      }
      throw new Error(`API request failed: ${status} ${statusText}${result.error ? ` - ${result.error}` : ''}`);
    }

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

  async getTipBlockHash(): Promise<string> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/blocks/tip/hash`);
    return response.text();
  }

  async getAddressTransactions(address: string): Promise<ApiTransaction[]> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/address/${address}/txs`);
    return response.json();
  }

  async getAddressTxCount(address: string): Promise<number> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/address/${address}`);
    const data = await response.json();
    return (data.chain_stats?.tx_count ?? 0) + (data.mempool_stats?.tx_count ?? 0);
  }

  async getAddressInfo(address: string): Promise<AddressInfo> {
    const statsResponse = await this.rateLimitedFetch(`${this.baseUrl}/address/${address}`);
    const stats = await statsResponse.json();

    const chainStats = stats.chain_stats ?? {};
    const txCount: number = (chainStats.tx_count ?? 0) + (stats.mempool_stats?.tx_count ?? 0);
    const receivedSats: number = chainStats.funded_txo_sum ?? 0;
    const sentSats: number = chainStats.spent_txo_sum ?? 0;
    const balanceSats: number = receivedSats - sentSats;

    if (txCount === 0) {
      return { txCount: 0, receivedSats: 0, sentSats: 0, balanceSats: 0 };
    }

    // Paginate backwards through all transaction history (most-recent first)
    // to find accurate first/last-seen block times. No page cap — runs until
    // the API returns an empty page (i.e. full history has been walked).
    let firstSeenTime: number | undefined;
    let lastSeenTime: number | undefined;
    let lastTxid: string | undefined;

    for (;;) {
      const url = lastTxid
        ? `${this.baseUrl}/address/${address}/txs/chain/${lastTxid}`
        : `${this.baseUrl}/address/${address}/txs`;

      const txsResponse = await this.rateLimitedFetch(url);
      const txs: import('./types').ApiTransaction[] = await txsResponse.json();

      if (!txs || txs.length === 0) break;

      for (const tx of txs) {
        if (!tx.status.confirmed || !tx.status.block_time) continue;
        const t = tx.status.block_time;
        if (lastSeenTime === undefined || t > lastSeenTime) lastSeenTime = t;
        if (firstSeenTime === undefined || t < firstSeenTime) firstSeenTime = t;
      }

      lastTxid = txs[txs.length - 1].txid;

      // Esplora returns 25 txs per page; fewer means we've reached the end.
      if (txs.length < 25) break;
    }

    return { txCount, receivedSats, sentSats, balanceSats, firstSeenTime, lastSeenTime };
  }

  // Fast tier: a single address-summary call returns all four core fields
  // (tx count, funded/spent sums, balance). No history pagination.
  async getAddressCoreStats(address: string, signal?: AbortSignal): Promise<AddressInfo> {
    const statsResponse = await this.rateLimitedFetch(`${this.baseUrl}/address/${address}`, signal);
    const stats = await statsResponse.json();

    const chainStats = stats.chain_stats ?? {};
    const txCount: number = (chainStats.tx_count ?? 0) + (stats.mempool_stats?.tx_count ?? 0);
    const receivedSats: number = chainStats.funded_txo_sum ?? 0;
    const sentSats: number = chainStats.spent_txo_sum ?? 0;
    const balanceSats: number = receivedSats - sentSats;

    return { txCount, receivedSats, sentSats, balanceSats };
  }

  // On-demand tier: walk the full transaction history (most-recent first) to
  // find accurate first/last-seen block times. Received/Sent already come from
  // the fast tier's chain_stats on Esplora, so only dates are returned here.
  async getAddressHistoryDates(
    address: string,
    onProgress?: (scanned: number) => void,
    signal?: AbortSignal,
  ): Promise<AddressHistoryDates> {
    let firstSeenTime: number | undefined;
    let lastSeenTime: number | undefined;
    let lastTxid: string | undefined;
    let scanned = 0;

    for (;;) {
      // Bail out between pages when the user cancels mid-walk. The in-flight
      // request itself is also aborted via the signal passed to
      // rateLimitedFetch below.
      if (signal?.aborted) throw new Error('Sync cancelled');

      const url = lastTxid
        ? `${this.baseUrl}/address/${address}/txs/chain/${lastTxid}`
        : `${this.baseUrl}/address/${address}/txs`;

      const txsResponse = await this.rateLimitedFetch(url, signal);
      const txs: ApiTransaction[] = await txsResponse.json();

      if (!txs || txs.length === 0) break;

      for (const tx of txs) {
        if (!tx.status.confirmed || !tx.status.block_time) continue;
        const t = tx.status.block_time;
        if (lastSeenTime === undefined || t > lastSeenTime) lastSeenTime = t;
        if (firstSeenTime === undefined || t < firstSeenTime) firstSeenTime = t;
      }

      scanned += txs.length;
      onProgress?.(scanned);

      lastTxid = txs[txs.length - 1].txid;

      // Esplora returns 25 txs per page; fewer means we've reached the end.
      if (txs.length < 25) break;
    }

    return { firstSeenTime, lastSeenTime };
  }

  async getTransaction(txid: string, signal?: AbortSignal): Promise<ApiTransaction | null> {
    try {
      const response = await this.rateLimitedFetch(`${this.baseUrl}/tx/${txid}`, signal);
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
