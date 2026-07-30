---
name: Transactions entity-filter parity & scale
description: Semantics + performance rules for entity filters on transaction queries (AND-of-EXISTS meaning, txid-set derivation shape, curated tier set, vocab-sourced dropdowns).
---

Entity filters (address/wallet/seed/owner/tag/category) mean AND-of-independent
conditions: each dimension may be satisfied by a DIFFERENT participant of the
same transaction. A fallback that pre-combines all predicates into one record
query computes a stricter, WRONG set — build one txid set per dimension and
intersect.

**Scale shape:** never express an entity filter as a per-transaction correlated
EXISTS — that walks the ENTIRE transaction table probing participants per row
(O(all txs) even for a one-address filter, rejected in code review). Instead
derive the matching txid set from the selective side (participants/records
indexes), INTERSECT per dimension, and CROSS JOIN back to the tx table via its
unique txid index. CROSS JOIN (not JOIN) pins SQLite's join order: with
hard-to-estimate subqueries (json_each tag matching) the planner otherwise flips
to scanning the tx table. Guard the shape with EXPLAIN QUERY PLAN tests (assert
no SCAN of the tx table) plus a generous-bound 1M-row latency benchmark — plan
guards are the deterministic tripwire, timing bounds are only demonstrative.

Other rules learned here:
- The curated default view's tier set excludes NULL importance (IndexedDB
  compound-index semantics), unlike the balances allowlist which treats NULL as
  curated. The engine's curated-only option must match the page's Dexie set.
- Entity dropdowns source values from the vocabulary tables; plain record
  creation does NOT auto-sync vocab, so browser-check seeds must create vocab
  entries explicitly.
- The scale-guards static ratchet regex-matches COMMENTS too — don't name
  full-load CRUD helpers with a trailing `(` in doc comments.
- Address filter matches participants directly (linked or not); record-linked
  dimensions join via the participant's recordId, so discovered records that
  inherit a walletName DO match a wallet filter once include-discovered is on.

**Bounded fallback prefix:** for huge-vault first pages without the engine, don't materialize full per-dimension txid sets or even a full `primaryKeys()` scan (code review rejects both as O(table)). Keyset-page the blockTime index newest-first with a (blockTime, seen-ids-at-that-blockTime) cursor — Dexie reverse iteration yields id DESC within equal blockTime, matching engine order. Prove boundedness in tests with a small batchSize param + a Dexie `reading` hook counting materialized rows.
