import { EsploraProvider } from './esplora-base';

// blockstream.info public API provider
export class BlockstreamProvider extends EsploraProvider {
  name = 'blockstream.info';

  constructor(network: 'mainnet' | 'testnet' = 'mainnet', timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string, trustedLocalHosts: string[] = []) {
    const baseUrl = network === 'mainnet'
      ? 'https://blockstream.info/api'
      : 'https://blockstream.info/testnet/api';
    super(baseUrl, timeout, useTor, torProxyUrl, trustedLocalHosts);
    if (useTor) {
      this.name = 'blockstream.info (via Tor)';
    }
  }
}
