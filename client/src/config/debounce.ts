export const DEBOUNCE_DELAY = {
  SMALL: 150,
  MEDIUM: 300,
  LARGE: 500,
} as const;

export const PAGE_DEBOUNCE: Record<string, number> = {
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
