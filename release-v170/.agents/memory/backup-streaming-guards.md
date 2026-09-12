---
name: backup streaming export/restore guards
description: Non-obvious pitfalls in v3 streaming backup and restore ordering, memory guards, and paged attachment cleanup.
---

# fflate onEntry is synchronous; ordering guards must track header order

`readZipStream` (fflate `Unzip`) calls `handlers.onEntry(name)` **synchronously**
as each local file header is parsed. The per-entry data consumers (`onChunk`/
`onEnd`) run **asynchronously** on a single serialized `pending` promise chain.

**Why:** When several entry headers land in one `unzip.push(chunk)`, `onEntry`
fires for all of them before ANY consumer's async work runs. So a "manifest must
be first" guard that checks the async-assigned `manifest` variable inside
`onEntry` falsely fires for well-formed archives (manifest written first) — the
manifest's `onEnd` that assigns `manifest` hasn't run yet.

**How to apply:** Track physical ZIP order with a **synchronous** flag set the
moment the manifest entry's header is reached (`manifestSeen = true` inside
`onEntry`), and gate the ordering check on that flag, never on the async value.
Data processing still happens in header order because the `pending` chain
serializes consumers, so the manifest handler (clear vault + derive key) still
completes before any data row is written.

# Export memory-fallback OOM guard must aggregate ALL streamed tables

The in-memory (download) export sink buffers the **whole** ZIP archive in RAM. A
guard that only checks `recordCount` is wrong: a vault with few records but
millions of `blockchainTransactions` / `transactionParticipants` /
`addressSyncState` rows still OOMs.

**Why:** Code review rejected the first cut for exactly this — small records +
huge tx tables selected `MemorySink` and crashed. The streaming backup rework
targets vaults with ~10M transactions / ~20M participants.

**How to apply:** Gate the memory fallback on the **aggregate** row count across
all streamed large tables plus attachment count, via the pure
`isMemoryFallbackSafe()` / `decideExportSinkKind()` in `lib/backup/sink.ts`.
Fetch **fresh** counts at export time (CRUD count fns), not from async display
state which may be stale/0/failed. Treat unknown counts as **unsafe-by-default**
(`countsKnown=false` → block). Prefer streaming-to-disk sinks (Electron IPC
`ElectronFileSink`, then browser File System Access) so the archive never lives
in memory; only fall back to memory for small, known-size datasets. Residual
(not yet done): guard is count-based, not byte-based — many huge attachment files
could still bloat an in-memory archive.

# Adding a table to STREAMED_TABLES is a multi-file invariant

The set of NDJSON-streamed big tables is **not** localized to `format.ts`. Each
table in `STREAMED_TABLES` must be wired in lockstep across several files or the
backup silently mis-handles it.

**Why:** Lineage tables (`utxoLineage`, `custodySegments`) started inline and
were later promoted to the streamed path. They carry **no `recordId`**, so —
like `blockchainTransactions` — they relink by their own keys (txid/vout,
segmentId) and need NO id-map remapping; `records` only has to be first for the
tables that DO depend on its old→new id map.

**How to apply:** When adding a streamed table you must touch ALL of:
`format.ts` (`STREAMED_TABLES` + `BackupCounts`); `export.ts` (`STREAM_READERS`
page reader + count in `Promise.all` + `counts` + `totalUnits`); `restore.ts`
(`handleBatch` branch, `counts`, `RestoreResult`, `total()` denominator, and a
**clear** in the manifest handler — `restoreV3Backup` ALWAYS replaces); a paged
`get*AfterId` + a `bulkAdd*` + a `count*` in the table's CRUD; the
`ExportPage.tsx` memory-fallback aggregate (`totalRowCount`) so the OOM guard
doesn't undercount; AND the LEGACY path (`legacy-restore-misc.ts` new
`restoreLegacy*` helper + `SettingsPage.tsx` destructure default `[]` + a clear
in the replace block + the restore call). The v3 path is replace-only, so
**merge mode lives only on the legacy path + the defensive `inline-tables.ts`
fallback**. Always KEEP a defensive inline-restore fallback (even for tables
that were never inline) so OLD/hand-edited backups carrying the table inline
aren't silently dropped — but do NOT add it to `readInlineTables`.

**Unique-indexed tables (e.g. `lineageSnapshots.&snapshotId`):** merge mode must
SKIP rows whose unique key already exists (gather existing keys into a `Set` via
a `getExisting*Ids()` index reader, add as you go), mirroring `custodySegments`.
Otherwise a re-merge either doubles rows or throws on the unique index and
ABORTS the whole restore mid-way. Replace mode appends as-is (caller cleared
first), so two backup rows sharing the key still throw — that's intended.

# Restore cleanup must use one resumable filesystem cursor

Successful replace-restore cleanup lists attachment filenames in bounded pages
after the restore, protects every path the restore wrote, and continues one
resumable filesystem traversal until its cursor is exhausted.

**Why:** Holding every old filename until restore success recreates a
filename-sized memory spike. Restarting a filesystem walk for every page is
quadratic, and offset paging is unstable while the consumer deletes stale files.

**How to apply:** Open the traversal on the first bounded page, pass its opaque
cursor into each next page, and explicitly close it if cleanup exits early.
Delete only normalized paths absent from the restore's written-path set. Keep
the sweep success-only and best-effort; cancel/failure cleanup continues to
sweep only files written by that attempt.
