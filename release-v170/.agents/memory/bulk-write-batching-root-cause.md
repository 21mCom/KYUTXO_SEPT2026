---
name: Bulk-write perf root cause is the call site, not the helper
description: When a bulk-insert/update path is "slow", verify the real UI/import call site actually calls the batch CRUD helper before optimizing schema or the helper itself.
---

Removing dead Dexie indexes on `records` measurably sped up raw isolated
`bulkAdd` benchmarks, but end-to-end `bulkCreateRecords` throughput was
unchanged — because the real bottleneck wasn't the batch helper or the
schema at all. It was that big call sites (`wallet-import/import-manager.ts`
`executeImport()`, and `pages/BulkImport.tsx`'s address-save loop) were
looping per-record over `createRecord`/`updateRecord`/`createRecordOrigin`/
`captureMergeOrigin`, each its own IndexedDB transaction, and never called
the batch helpers (`bulkCreateRecords`/`bulkUpdateRecords`/
`bulkAddRecordOrigins`) at all.

**Why:** it's tempting to profile and optimize the shared low-level helper
(schema, indexes, the bulk function itself) because that's where "bulk" work
conceptually lives. But a helper that's fast in isolation contributes nothing
if the actual feature code path never calls it. Real-browser profiling showed
serial per-record writes at ~228 rows/sec vs a batched rewrite at ~540-758
rows/sec (2.4-3.3x) on the same operation — all while `bulkCreateRecords`
alone was already near the Dexie `bulkAdd` write ceiling (~700-900 rows/sec
for a heavily-indexed table, see dexie-indexed-bulk-write-throughput.md).

**How to apply:** before optimizing a "slow bulk operation," grep the actual
call site for a loop calling single-record CRUD functions. If found, the fix
is almost always splitting into (1) an in-memory computation phase with zero
DB calls, then (2) chunked batch writes (~1000/chunk) with a per-chunk
fallback to the original serial path on failure (preserves per-record error
attribution without sinking the whole import on one bad row). Only profile
deeper into the batch helper itself once you've confirmed the call site is
actually using it.

Applying the same fix to other call sites (Task #2129: a vault-notes
`updateRecord` loop and a per-transaction `createRecord` loop) reproduced the
same win but at very different magnitudes on the same container: ~2.9-3.3x
for a straightforward same-shape update loop, but only ~1.2-2.5x for a
create+origin loop chunked into several `bulkCreateRecords`+
`bulkAddRecordOrigins` calls versus one unchunked call. Per-chunk transaction
setup overhead is real and shrinks the win as chunk count grows relative to
total N — measure with the actual chunked code path, not a single unchunked
bulk call, and expect run-to-run noise (shared container) rather than a fixed
multiplier.

The delete side has the same anti-pattern (a `for` loop calling
`deleteRecord` once per selected id, e.g. Dashboard.tsx's/Records.tsx's
`handleBulkDelete`) but one extra wrinkle: `deleteRecord` has an auxiliary
per-record side effect (archiving each record's attachments into a
recoverable trash table before the row is removed) that the existing
merge-cancel-only `bulkDeleteRecords` helper deliberately skips. A correct
bulk-delete-with-archiving helper must batch *both* the side effect (one
`archiveAttachments` bulkAdd call covering every id's attachments, fetched via
a single `anyOf(ids)` query) and the primary table deletes — batching only
the record-table delete while still looping the archiving per-record would
silently reintroduce the same bottleneck one call site later. Measured ~5.5x
on 3000 records/chunk-1000 in this container, with an exact-parity check
(archived-attachment count matches N) proving the batched path didn't drop
the archiving cascade.
