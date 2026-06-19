---
name: owned-UTXO materialization
description: Why/how big-vault owned-UTXO reads are materialized at finalize instead of computed live.
---

At-scale (~13M participants) the two slowest native-SQLite reads were owned-UTXO
count and first-page latency. Root cause: a per-output anti-join with two
correlated subqueries (owned-tier records EXISTS + blockTime JOIN) plus a full
TEMP B-TREE sort. These are density-dependent and indexes alone cannot fix them.

**Decision:** materialize the owned-UTXO set once at finalize into an `ownedUtxos`
table (participant `id` reused as PRIMARY KEY). Count served from a cached scalar
in `engineMeta`; first page is a pure PK keyset scan (`id > ? ORDER BY id`).

**Why:** fits the engine's full-rebuild replica model — table is dropped on every
seedBegin/clear and rebuilt after createIndexes. Runs the expensive anti-join
EXACTLY ONCE (~10s) instead of on every read.

**How to apply:**
- Gate reads with `ownedUtxosReady(db, tiers)`: requires the table to exist AND an
  `engineMeta` tier signature == sorted JSON of the tier set. On mismatch (custom
  tiers, no build, unit tests) reads MUST fall back to the EXACT live anti-join —
  do not change the live SQL.
- When writing the cache, set the COUNT meta first and the tier SIGNATURE last;
  ownedUtxosReady gates on the signature so it only flips ready once count exists.
- `dropMirrorTables` must drop ownedUtxos and clear the meta keys, or stale reads
  ship. Any future incremental write path must rebuild or invalidate likewise.
- This is a reusable pattern: the next slowest read at scale is `countRecords`
  (owned-only tier, ~249ms) — same cached-count-at-finalize approach applies.
