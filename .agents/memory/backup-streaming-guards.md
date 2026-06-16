---
name: backup streaming export/restore guards
description: Non-obvious pitfalls in the v3 streaming backup — fflate sync-vs-async ordering, and the memory-fallback OOM guard.
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
huge tx tables selected `MemorySink` and crashed. Task #254 targets 10M tx / 20M
participants.

**How to apply:** Gate the memory fallback on the **aggregate** row count across
all streamed large tables (records + transactions + participants +
addressSyncState) plus attachment count, via the pure `isMemoryFallbackSafe()` /
`decideExportSinkKind()` in `lib/backup/sink.ts`. Fetch **fresh** counts at
export time (CRUD count fns), not from async display state which may be stale/0/
failed. Treat unknown counts as **unsafe-by-default** (`countsKnown=false` →
block). Prefer streaming-to-disk sinks (Electron IPC `ElectronFileSink`, then
browser File System Access) so the archive never lives in memory; only fall back
to memory for small, known-size datasets. Residual (not yet done): guard is
count-based, not byte-based — many huge attachment files could still bloat an
in-memory archive.
