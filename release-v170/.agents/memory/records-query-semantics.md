---
name: Records query & toggle semantics (KYUTXO)
description: Why record counts look "missing" and why search is slow.
---

# "Missing records" is usually the blockchain-discovered toggle, not data loss
Records.tsx defaults `includeBlockchainDiscovered=false`. The unfiltered count shows
`total - (blockchain-discovered + pending-review)` and the residual filterFn drops
`blockchain-discovered`/`pending-review` rows. So a vault that shows fewer records/filter-matches
than an older app version is usually just hiding those two tiers by default — verify against the
toggle before assuming migration dropped rows.

# Global search is always a residual JS .includes() scan
records-query.ts intentionally never uses search text as a primary index narrowing; it is applied as
a residual substring predicate over the narrowed collection (bounded by MAX_MATERIALIZE=10000).
On 1-2M rows this is the dominant cost (minutes). A pasted exact address/txid should be detected and
routed to the `inputStringLower` index (equals/startsWith) — but only after inputStringLower is
repaired (see legacy-migration-gotchas).

# Deep pagination is O(offset)
The id-reverse page fetch uses Dexie `.offset(offset)`, which walks and discards `offset` rows, so
deep pages take minutes on large vaults. Keyset/cursor pagination (id < lastSeenId) is the fix.
