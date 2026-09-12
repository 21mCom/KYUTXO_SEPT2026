---
name: Engine mirror freshness gate
description: Why a screen reading from the native SQLite mirror must verify freshness, not just READY state, before trusting it.
---

# Engine mirror freshness gate

The native better-sqlite3 read-engine is a **read replica** of the live Dexie/IndexedDB
vault. It is rebuilt only by an explicit, full reseed (today triggered from the engine
diagnostics screen) — there is **no incremental sync** on Dexie writes.

**Rule:** Before any live screen serves a read from the engine, it must confirm the mirror
is CURRENT — engine readiness (worker `snapshot.ready`) only proves the last seed completed
+ passed integrity, NOT that it still matches the vault.

**Why:** After any create/edit/delete the engine stays `READY` but stale, so reads would
show missing/deleted rows and wrong counts/pagination — a silent data regression on a live
screen. (Code review rejected a readiness-only gate for exactly this.)

**How to apply:** Compare a cheap fingerprint of the relevant table on both sides and only
use the engine when all parts match; on any mismatch OR any error, fall back to the Dexie
path. For the records table the fingerprint is `{count, maxId, maxUpdatedAt}`:
- create → bumps count + maxId (caught even if the row carries a backdated updatedAt, which
  the create path allows via `updatedAt ?? now`).
- delete → lowers count.
- edit → bumps updatedAt (both `updateRecord` and `bulkUpdateRecords` set `Date.now()`).

Use index-only reads for the Dexie side (`count()` + `orderBy('id').last()` +
`orderBy('updatedAt').last()`) — never a full scan. The engine side computes the same in one
SQL `SELECT COUNT/MAX`. Better long-term: incremental mirror updates or a synced
generation/high-water marker so the engine path is usable right after writes.
