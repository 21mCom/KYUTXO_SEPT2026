---
name: UTXOs screen engine read path
description: When/why the UTXOs page reads owned UTXOs from the native SQLite engine vs Dexie, and why getAddressAggregates is unused there.
---

# UTXOs screen engine read path

The UTXOs page uses the native SQLite read-engine fast path ONLY when ALL hold:
exact mode, blockchain-discovered toggle OFF, and no "as of" date selected. Gated
behind `engineReadyForReads()` AND a records-fingerprint match (count + maxId +
maxUpdatedAt) exactly like the Records screen; any mismatch/error → Dexie.

**Why these gates:** the engine's owned-UTXO query is an EXACT prevout anti-join
over user-curated tiers only (`OWNED_TIERS` == `USER_CURATED_TIERS`); it does not
replicate the heuristic amount-matching mode and has no historical block-time
cutoff. So heuristic mode, the blockchain-discovered view, and date filters must
stay on the in-browser Dexie computation.

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
