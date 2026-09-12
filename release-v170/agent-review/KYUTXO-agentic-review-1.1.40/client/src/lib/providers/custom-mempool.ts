import { EsploraProvider } from './esplora-base';

// Custom mempool instance provider
export class CustomMempoolProvider extends EsploraProvider {
  name: string;

  constructor(customUrl: string, timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string, trustedLocalHosts: string[] = []) {
    const apiUrl = customUrl.endsWith('/api') ? customUrl : `${customUrl}/api`;
    super(apiUrl, timeout, useTor, torProxyUrl, trustedLocalHosts);
    
    if (customUrl.includes('.onion')) {
      this.name = 'Custom Mempool (Tor)';
    } else if (useTor) {
      this.name = 'Custom Mempool (via Tor)';
    } else {
      this.name = 'Custom Mempool';
    }
  }
}
