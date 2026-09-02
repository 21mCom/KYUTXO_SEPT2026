import { EsploraProvider } from './esplora-base';

// Custom Electrs/Esplora provider (for self-hosted nodes)
export class CustomElectrsProvider extends EsploraProvider {
  name: string;

  constructor(customUrl: string, timeout: number = 30000, useTor: boolean = false, torProxyUrl?: string, trustedLocalHosts: string[] = []) {
    super(customUrl, timeout, useTor, torProxyUrl, trustedLocalHosts);
    if (customUrl.includes('.onion')) {
      this.name = 'Custom Electrs (Tor)';
    } else if (useTor) {
      this.name = 'Custom Electrs (via Tor)';
    } else {
      this.name = 'Custom Electrs';
    }
  }
}
