---
name: UTXOs screen engine read path
description: When/why the UTXOs page reads owned UTXOs from the native SQLite engine vs Dexie, and why getAddressAggregates is unused there.
---

# UTXOs screen engine read path

The UTXOs page uses the native SQLite read-engine for ALL exact-mode views: the
default user-curated set, the "include blockchain-discovered" view, and the "as of"
date view. The ONLY exact-mode sub-case off the engine is the heuristic (no-prevout)
mode. Gated behind `engineReadyForReads()` AND a records-fingerprint match (count +
maxId + maxUpdatedAt) exactly like the Records screen; any mismatch/error → Dexie.

**Engine query shape:** `countOwnedUtxos`/`getOwnedUtxos` take an options object
`{ tiers?, afterId?, limit, asOfBlockTime? }` (not a bare tiers array). Both build
the live anti-join via the shared `buildLiveOwnedUtxosClause(tiers, asOfBlockTime?)`
helper. Bind-param order is fixed: output-cutoff, then tier list, then spend-cutoff.
- `tiers` undefined → default `OWNED_TIERS` (== `USER_CURATED_TIERS`) and can hit the
  materialized fast path. Page passes the widened set
  `[...USER_CURATED_TIERS,'blockchain-discovered','pending-review']` when the toggle is on.
- `asOfBlockTime` set → live path only (fast path is skipped whenever asOf != null);
  cutoff bounds BOTH the output's tx blockTime (>0 && <=cutoff) and the spending
  input's tx blockTime, matching the Dexie exact path. Page cutoff =
  `floor(selectedDate/1000)+86400` (end-of-day inclusive). Heuristic mode has no engine
  equivalent and stays on Dexie.

**Why `engineGetAddressAggregates` is intentionally NOT used here** (despite being
listed alongside getOwnedUtxos/countOwnedUtxos): the page needs individual UTXOs
for the expandable per-address rows, and the engine has no "owned UTXOs by
address" query — so the full owned set must be loaded via `engineGetOwnedUtxos`
(keyset-paged). Address-level totals are then derived client-side from that single
source of truth; calling getAddressAggregates would be redundant and could
disagree with the summed UTXO set.

**How to apply:** owned UTXOs carry no blockTime/blockHeight — enrich each by
fetching its txid from `blockchainTransactions` (getTransactionsByTxids) before
computing dates / value-at-receipt. Keep the engine fetch separate from the
record-metadata + price enrichment memo so price/label changes don't re-run the
SQLite query. While the engine decision is still resolving ('pending'), skip the
Dexie participant load so it is never done just to be thrown away.
