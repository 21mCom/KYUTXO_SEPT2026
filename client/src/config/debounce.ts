export type PageName =
  | 'UTXOs'
  | 'Transactions'
  | 'Records'
  | 'Evidence'
  | 'WalletOverview'
  | 'AddressReuse'
  | 'Dashboard'
  | 'VaultManagement'
  | 'ConflictResolution';

export const DEBOUNCE_DELAY = {
  SMALL: 150,
  MEDIUM: 300,
  LARGE: 500,
} as const;

export const PAGE_DEBOUNCE: Record<PageName, number> = {
  UTXOs: DEBOUNCE_DELAY.LARGE,
  Transactions: DEBOUNCE_DELAY.LARGE,

  Records: DEBOUNCE_DELAY.MEDIUM,
  Evidence: DEBOUNCE_DELAY.MEDIUM,
  WalletOverview: DEBOUNCE_DELAY.MEDIUM,
  AddressReuse: DEBOUNCE_DELAY.MEDIUM,
  Dashboard: DEBOUNCE_DELAY.MEDIUM,

  VaultManagement: DEBOUNCE_DELAY.SMALL,
  ConflictResolution: DEBOUNCE_DELAY.SMALL,
};

export const DEFAULT_SEARCH_PENDING_OPACITY = 'opacity-60';

export const PAGE_SEARCH_PENDING_OPACITY: Record<PageName, string> = {
  UTXOs: 'opacity-50',
  Transactions: 'opacity-50',

  Records: DEFAULT_SEARCH_PENDING_OPACITY,
  Evidence: DEFAULT_SEARCH_PENDING_OPACITY,
  WalletOverview: DEFAULT_SEARCH_PENDING_OPACITY,
  AddressReuse: DEFAULT_SEARCH_PENDING_OPACITY,
  Dashboard: DEFAULT_SEARCH_PENDING_OPACITY,

  VaultManagement: 'opacity-70',
  ConflictResolution: 'opacity-70',
};

export function getSearchPendingOpacity(page: PageName): string {
  return PAGE_SEARCH_PENDING_OPACITY[page] ?? DEFAULT_SEARCH_PENDING_OPACITY;
}
