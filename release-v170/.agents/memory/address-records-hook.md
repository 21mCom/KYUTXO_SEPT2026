---
name: Address-records loading & sync-signal scoping
description: How analysis pages should load address-type records and react to record changes without being flooded by blockchain-sync writes.
---

Analysis/report pages (BalanceOverview, UTXOs, WalletOverview, HopPointReport,
SourceOfFundsReport) load address-type records through the shared
`useAddressRecords` hook (`client/src/hooks/use-address-records.ts`), not a raw
`useLiveQuery`.

**Rule:** Prefer the shared hook + the debounced db-change signal bus
(`useDbChangeSignal(['records'], 250, { filter })`) over `useLiveQuery` for
address-record loads on heavy pages.

**Why:** Blockchain sync writes records in tight batches. A raw `useLiveQuery`
re-runs on every write, causing UI churn during a sync. The signal bus lets us
(a) debounce a sync flood into a single reload, and (b) drop sync-origin pulses
entirely when a page only shows user-curated tiers (filter on
`meta.origin === 'blockchain-sync'`).

**How to apply:** Call `useAddressRecords({ includeBlockchainDiscovered })`.
When false, it queries only USER_CURATED_TIERS via the `[type+addressImportance]`
index AND ignores sync-origin signal pulses. The hook returns `records` as `[]`
(never `undefined`) plus `isLoading` — pages relying on `undefined`-means-loading
must use `isLoading` instead. Writers must publish `meta.origin` for the filter
to work (sync uses `'blockchain-sync'`; manual recompute uses `'user'`).
