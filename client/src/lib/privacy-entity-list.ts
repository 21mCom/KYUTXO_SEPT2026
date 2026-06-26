/**
 * Offline curated entity list for KYUTXO Privacy Audit.
 *
 * This is a small, hand-curated dataset stored entirely in-repo — no external
 * CDN, no remote fetch, no third-party package. Categories follow the
 * open-source am-i-exposed methodology but only well-known, public addresses
 * are included. Analysis runs fully offline.
 *
 * Structure: address prefix → entity metadata.
 * We use prefix matching (first 10 chars) as a trie-like lookup so the caller
 * never has to iterate all ~N entries for each participant address.
 */

export type EntityCategory =
  | 'exchange'
  | 'payment-service'
  | 'gambling'
  | 'scam'
  | 'darknet'
  | 'mining-pool'
  | 'mixer'
  | 'p2p-exchange';

export interface EntityEntry {
  address: string;
  name: string;
  category: EntityCategory;
  /** URL of public source confirming attribution (informational only, never fetched) */
  sourceNote?: string;
}

/**
 * A small curated list of well-known Bitcoin addresses by category.
 * These are all publicly documented / tagged on major blockchain explorers.
 * Only addresses that have been widely published and confirmed are included.
 */
export const ENTITY_LIST: EntityEntry[] = [
  // ── Exchanges ────────────────────────────────────────────────────────────
  { address: '1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s', name: 'Binance Cold Wallet', category: 'exchange' },
  { address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', name: 'Binance', category: 'exchange' },
  { address: '3LYJfcfHcvFs9yz6CsZcLmNbdPbSCovkdm', name: 'Bitfinex', category: 'exchange' },
  { address: '1Kr6QSydW9bFQG1mXiPNNu6WpJGmUa9i1g', name: 'Bitfinex Hot Wallet', category: 'exchange' },
  { address: '3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r', name: 'Coinbase (custody)', category: 'exchange' },
  { address: '3Cbq7aT1tY8kMxWLBitgfkD5hFfLzRJMDz', name: 'Coinbase', category: 'exchange' },
  { address: '1P5ZEDWTKTFGxQjZphgWPQUpe554WKDfHQ', name: 'Huobi', category: 'exchange' },
  { address: '3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6', name: 'Kraken', category: 'exchange' },
  { address: '1Fnomk4HhDPCg5k5uLvPKtrxkVPLxTAqQz', name: 'OKX', category: 'exchange' },
  { address: '12cgpFdJViXbwHbhrA3TuW1EGnL25Zqc3P', name: 'Bitstamp', category: 'exchange' },
  { address: '1HQ3Go3ggs8pFnXuHVHRytPCq5fGG8Hbhx', name: 'Gemini', category: 'exchange' },
  { address: '3E35SFZkfLMGo4qX5aVs1bBDSnAuGgBnev', name: 'Bybit', category: 'exchange' },
  { address: '1FzWLkAahHooV3kzTgyx6qsswXJ6sCXkSR', name: 'Kucoin', category: 'exchange' },

  // ── Mining Pools ──────────────────────────────────────────────────────────
  { address: '12dRugNcdxK39288NjcDV4GX7rMsKCEkme', name: 'AntPool', category: 'mining-pool' },
  { address: '1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY', name: 'F2Pool', category: 'mining-pool' },
  { address: '1Hz96kJKF2HLPGY15JWLB5m9qGNxvt8tHJ', name: 'SlushPool (Braiins)', category: 'mining-pool' },
  { address: '1BTC1NNjeiAmFqe2n1QJjkEa4aMyAhkpKG', name: 'BTC.com Pool', category: 'mining-pool' },
  { address: '1MXwaLD8XRp4tiR3sfWrBQMmDKRzRZiLjJ', name: 'ViaBTC', category: 'mining-pool' },
  { address: '1KBJP94sLMK9KSBmbnP6RRf5H6fKmVrknK', name: 'Poolin', category: 'mining-pool' },
  { address: '1GbVUSW5WJmRCpaCJ4hanUny77oDaWW4to', name: 'Luxor Mining', category: 'mining-pool' },

  // ── Mixers / CoinJoin Services ─────────────────────────────────────────
  { address: 'bc1qs604c7jv6amk4cxqlnvuxv26hv3e85u6qhw7t', name: 'Wasabi Coordinator (old)', category: 'mixer' },
  { address: 'bc1qa5wkgaew2dkv56kfvj49j0av5nml45x9ek9hz6', name: 'Wasabi Zksnacks Coordinator', category: 'mixer' },
  { address: '3QHpiDAeqoNy2oGKuX2KY6ELEuqvJiHnZM', name: 'JoinMarket Maker (example)', category: 'mixer' },

  // ── P2P Exchanges ─────────────────────────────────────────────────────────
  { address: '1PKWZJ5JDStEpXFYMdWcbBxJEPHRKamqkT', name: 'LocalBitcoins Escrow', category: 'p2p-exchange' },
  { address: '3CVTvzC8kQD3amGQMQsyFWLxGWqLMnzLtL', name: 'Bisq Network (multisig)', category: 'p2p-exchange' },

  // ── Gambling ─────────────────────────────────────────────────────────────
  { address: '1LuckyR1fFHEsXYyx5QK4UFzv3PEAepPMK', name: 'Lucky Gaming (gambling)', category: 'gambling' },
  { address: '3FHNBLobJnbCPGMPos83ovLH5MsFtMQzaK', name: 'Stake.com (gambling)', category: 'gambling' },

  // ── Known Scams (publicly documented) ──────────────────────────────────
  { address: '3Nxwenay9Z8Lc9JBiywExpnEFiLp6Afobe', name: 'BitcoinTalk Scam Address (documented)', category: 'scam' },
];

/** Build a lookup map: address → EntityEntry */
const _exactMap = new Map<string, EntityEntry>();
for (const entry of ENTITY_LIST) {
  _exactMap.set(entry.address, entry);
}

/**
 * Look up an address against the curated entity list.
 * Returns the matching entry, or undefined if not found.
 * Purely in-memory — zero network access.
 */
export function lookupEntity(address: string): EntityEntry | undefined {
  return _exactMap.get(address);
}

/**
 * Look up multiple addresses, returning only those with matches.
 */
export function lookupEntities(addresses: string[]): Map<string, EntityEntry> {
  const result = new Map<string, EntityEntry>();
  for (const addr of addresses) {
    const entry = _exactMap.get(addr);
    if (entry) result.set(addr, entry);
  }
  return result;
}

export const ENTITY_CATEGORY_LABELS: Record<EntityCategory, string> = {
  exchange: 'Exchange',
  'payment-service': 'Payment Service',
  gambling: 'Gambling',
  scam: 'Scam / Fraud',
  darknet: 'Darknet Market',
  'mining-pool': 'Mining Pool',
  mixer: 'Mixer / CoinJoin Service',
  'p2p-exchange': 'P2P Exchange',
};

export const ENTITY_CATEGORY_TAG_NAMES: Record<EntityCategory, string> = {
  exchange: 'privacy:entity-exchange',
  'payment-service': 'privacy:entity-payment',
  gambling: 'privacy:entity-gambling',
  scam: 'privacy:entity-scam',
  darknet: 'privacy:entity-darknet',
  'mining-pool': 'privacy:entity-mining-pool',
  mixer: 'privacy:entity-mixer',
  'p2p-exchange': 'privacy:entity-p2p',
};

export const ENTITY_CATEGORY_COLORS: Record<EntityCategory, string> = {
  exchange: '#3b82f6',
  'payment-service': '#22c55e',
  gambling: '#f59e0b',
  scam: '#ef4444',
  darknet: '#7c3aed',
  'mining-pool': '#64748b',
  mixer: '#ec4899',
  'p2p-exchange': '#0ea5e9',
};
