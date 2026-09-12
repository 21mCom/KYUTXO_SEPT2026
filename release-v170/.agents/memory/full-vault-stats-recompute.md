---
name: Full-vault stats recompute fast path
description: Set-oriented full-table scan beats per-batch anyOf lookups for whole-vault address stats; browser benchmarks must not run right after bulk seeding.
---

- Whole-vault per-address stats recompute is fastest as ONE streaming pass over transactionParticipants + one over blockchainTransactions (aggregate in memory, then write), not per-batch `anyOf(addresses)` round-trips. At 30k addr / 60k participants: ~14s vs ~47s in a real browser; batched path stays as the fallback above a row-count cap and for SMALL filtered recomputes — a filtered request covering ≥50% of the vault AND ≥1000 rows reuses the scan for computation while writes stay scoped to the requested subset.
- Equivalence tests that use the filtered path as a batched-path ORACLE must issue requests below the size floor (chunk the address list), or the oracle itself silently takes the scan path.
- **Why:** each 100-address batch costs 4+ Dexie index queries (participants by address, spend inputs by outpoint, block times, sync states); a full scan reads every row exactly once.
- **How to apply:** vault-wide attribution of blank-address prevout spend inputs must happen AFTER the scan (owner output may appear later in the cursor than the spending input); attribute to the outpoint owner unless the row already carries that owner's address.
- Benchmark gotcha: a compute run started immediately after 100k+ IndexedDB bulkAdds is heavily penalized (write-buffer/compaction). Comparing two implementations in one page, the FIRST one run looks slower — swap the order (or warm the DB) before trusting the numbers.
