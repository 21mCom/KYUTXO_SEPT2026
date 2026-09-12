export type PageName =
  | 'UTXOs'
  | 'Transactions'
  | 'Records'
  | 'Evidence'
  | 'WalletOverview'
  | 'AddressReuse'
  | 'Dashboard'
  | 'ExportPage'
  | 'adversary-scenarios-panel'
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
  ExportPage: DEBOUNCE_DELAY.MEDIUM,
  'adversary-scenarios-panel': DEBOUNCE_DELAY.MEDIUM,

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
  ExportPage: DEFAULT_SEARCH_PENDING_OPACITY,
  'adversary-scenarios-panel': DEFAULT_SEARCH_PENDING_OPACITY,

  VaultManagement: 'opacity-70',
  ConflictResolution: 'opacity-70',
};

export const SEARCH_FADE_STORAGE_KEY = 'search-fade-intensity';

export const SEARCH_FADE_OPTIONS = [
  { value: 'default', label: 'Default (varies by page)' },
  { value: 'opacity-100', label: 'Off' },
  { value: 'opacity-80', label: 'Subtle' },
  { value: 'opacity-70', label: 'Light' },
  { value: 'opacity-60', label: 'Medium' },
  { value: 'opacity-50', label: 'Strong' },
  { value: 'opacity-40', label: 'Heavy' },
] as const;

export type SearchFadeOption = (typeof SEARCH_FADE_OPTIONS)[number]['value'];

const VALID_FADE_VALUES = new Set<string>(
  SEARCH_FADE_OPTIONS.map((o) => o.value),
);

export function getSearchFadePreference(): SearchFadeOption {
  if (typeof window === 'undefined') return 'default';
  const stored = localStorage.getItem(SEARCH_FADE_STORAGE_KEY);
  if (stored && VALID_FADE_VALUES.has(stored)) return stored as SearchFadeOption;
  return 'default';
}

export function setSearchFadePreference(value: SearchFadeOption): void {
  if (value === 'default') {
    localStorage.removeItem(SEARCH_FADE_STORAGE_KEY);
  } else {
    localStorage.setItem(SEARCH_FADE_STORAGE_KEY, value);
  }
}

export function getSearchPendingOpacity(page: PageName): string {
  const userPref = getSearchFadePreference();
  if (userPref !== 'default') return userPref;
  return PAGE_SEARCH_PENDING_OPACITY[page] ?? DEFAULT_SEARCH_PENDING_OPACITY;
}
