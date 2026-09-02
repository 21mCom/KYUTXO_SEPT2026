import { EsploraProvider } from './esplora-base';

// mempool.space public API provider
export class MempoolSpaceProvider extends EsploraProvider {
  name = 'mempool.space';

  constructor(network: 'mainnet' | 'testnet' = 'mainnet', timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string, trustedLocalHosts: string[] = []) {
    const baseUrl = network === 'mainnet' 
      ? 'https://mempool.space/api'
      : 'https://mempool.space/testnet/api';
    super(baseUrl, timeout, useTor, torProxyUrl, trustedLocalHosts);
    if (useTor) {
      this.name = 'mempool.space (via Tor)';
    }
  }
}
