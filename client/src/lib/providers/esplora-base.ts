import { isElectron, getElectronAPI } from '../electron';
import { BlockchainProvider, ApiTransaction, DEFAULT_RATE_LIMIT_DELAY, TOR_RATE_LIMIT_DELAY, isLocalOrPrivateUrl } from './types';

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

  protected async rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
    
    if (this.useTor) {
      return this.torProxiedFetch(url);
    }
    
    if (isElectron() && isLocalOrPrivateUrl(url)) {
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

    const startTime = Date.now();

    if (isElectron()) {
      const electronAPI = getElectronAPI();
      console.log(`[KYUTXO] [${new Date().toISOString()}] Calling Electron IPC torRequest...`);
      result = await electronAPI.torRequest({
        url,
        method: 'GET',
        timeout: this.timeout,
        torProxyUrl: this.torProxyUrl,
        allowedHost: this.baseUrl,
        trustedLocalHosts: this.trustedLocalHosts,
      });
      console.log(`[KYUTXO] [${new Date().toISOString()}] Electron IPC returned - success: ${result.success}, elapsed: ${Date.now() - startTime}ms`);
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
          trustedLocalHosts: this.trustedLocalHosts,
        }),
      });
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

  async getAddressTransactions(address: string): Promise<ApiTransaction[]> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/address/${address}/txs`);
    return response.json();
  }

  async getAddressTxCount(address: string): Promise<number> {
    const response = await this.rateLimitedFetch(`${this.baseUrl}/address/${address}`);
    const data = await response.json();
    return (data.chain_stats?.tx_count ?? 0) + (data.mempool_stats?.tx_count ?? 0);
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
