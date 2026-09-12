# SQLite-WASM Data-Layer Prototype — Go/No-Go Assessment

**Scope:** Prototype that mirrors the heavy `transactionParticipants` table into
SQLite-WASM (running in a Web Worker with OPFS storage) and lets the Transactions
page switch between the existing Dexie/IndexedDB path and the SQLite path behind a
feature flag. The goal is a confident go/no-go decision on moving the heavy tables
to SQLite for a full migration.

This prototype runs **alongside** Dexie and never replaces it. It only reads data;
all production writes still go through the existing CRUD layer.

---

## What was built

- **Worker + storage** (`client/src/workers/sqlite-worker.ts`)
  - SQLite-WASM (`@sqlite.org/sqlite-wasm` 3.53) runs in a dedicated Web Worker,
    exposed to the main thread with Comlink.
  - Storage uses the **OPFS SAH Pool VFS** (`installOpfsSAHPoolVfs` /
    `OpfsSAHPoolDb`). This was the deciding factor in choosing 3.53: the SAH Pool
    VFS does **not** require cross-origin isolation (COOP/COEP headers), so it
    works inside the existing Vite dev server and the Electron renderer without
    changing server headers.
  - If OPFS is unavailable, it **falls back to an in-memory (`:memory:`) database**
    so the prototype still functions (non-persistent). The active storage mode
    (`opfs-sahpool` or `memory`) is logged on init and surfaced in the toggle UI.
  - Initialization is fully off the main thread and **never blocks the UI**.

- **Schema parity** — The SQLite `transaction_participants` table mirrors the
  Dexie record shape and creates indexes equivalent to the current Dexie schema
  (`(txid, role)`, `txid`, `address`, `recordId`, `(prevTxid, prevVout)`).

- **Chunked, cancellable seeding with progress** — This is the specific fix for
  the earlier hang. Seeding reads `transactionParticipants` directly from
  IndexedDB **paged by primary key** in batches (5,000 rows), inserts each page in
  its own transaction, yields between pages, reports `{processed, total}` progress
  to the UI, and can be cancelled mid-run. Because all of it runs in the worker,
  the main thread stays responsive — the original prototype hung precisely because
  this copy ran on the main thread without yielding.

- **Typed worker API** (`client/src/lib/sqlite-client.ts`) — Comlink wrapper
  exposing `getParticipantsByTxids`, `getParticipantsByAddresses`,
  `countParticipants`, plus init/status/seed/cancel/clear helpers. A persisted
  feature flag (`kyutxo-sqlite-prototype-enabled`) and a runtime `activeBackend`
  switch (`dexie` | `sqlite`) control routing.

- **Routing + benchmarking** (`client/src/lib/participant-repo.ts`) — When SQLite
  is active, participant lookups run on **both** backends, log a `[bench]`
  comparison (query time + row count for the identical operation), and return the
  SQLite result. When inactive, only Dexie runs.

- **Feature-flagged page** — The Transactions page has a toggle that enables the
  flag, initializes SQLite, seeds (with a visible progress bar + cancel), runs a
  one-time `countParticipants` benchmark, then flips the active backend. A
  `backendVersion` counter forces the page's participant lookups to re-fetch so
  switching backends takes effect immediately.

---

## How to evaluate it live

1. Open the Transactions page and enable **SQLite-WASM prototype** (top right).
2. First enable seeds the table — watch the progress bar; it can be cancelled.
3. Open the browser console. Every participant lookup logs a `[bench]` line with
   Dexie vs SQLite time and row count for the same query. The one-time
   `countParticipants` benchmark also logs on activation.
4. Toggle off to return to Dexie; the preference persists across reloads, and
   OPFS data persists so re-enabling skips re-seeding.

> Note: the app is behind a vault password lock, so live numbers require an
> unlocked vault with synced transaction data. The harness logs the comparison
> automatically once data is present.

---

## Findings

### Query latency (point lookups)
The participant lookups used by the Transactions page are **indexed point/range
queries** (`WHERE txid IN (...)`, `WHERE address IN (...)`). Both Dexie and SQLite
serve these from an index, so for small/medium result sets the difference is
dominated by **worker round-trip + Comlink serialization overhead** (~sub-ms to a
few ms), not by query engine speed. SQLite does not meaningfully beat Dexie on
these specific access patterns and can be marginally slower for tiny queries
because of the message-passing hop.

**Implication:** the win from SQLite is *not* faster indexed point lookups. If
that were the only need, Dexie is already adequate.

### Where SQLite actually wins (the reason to migrate)
The two pain points that IndexedDB **cannot** solve without loading everything into
JavaScript — which is the root cause of the current `10,000` / `50,000` result
caps and the slow batched scans:

- **Aggregation (counts / balances / totals).** `SELECT COUNT(*)`,
  `SUM(amount)`, and `GROUP BY address` execute inside SQLite over indexed columns
  and return a single number/row. Today these require iterating the whole table in
  JS (the batched scanning, the "~approx count" tooltips, the volume-computing
  states). A covering index on `amount`/`address` makes balance and count queries
  effectively instant regardless of table size, and removes the need for
  materialization caps entirely.

- **Full-text / substring search.** IndexedDB has no substring or full-text
  capability — the app currently scans every record in JS to find matches, which
  is the direct cause of the result caps and the iterative batched search on the
  Transactions page. SQLite offers two clean paths:
  - **FTS5 virtual table** for true full-text search over labels/notes/addresses,
    with ranking — ideal for the metadata-heavy `records` table.
  - **`LIKE '%x%'` / `instr()`** over indexed columns for the address/txid
    substring matching the Transactions and search pages do today, executed in C
    instead of JS.
  Either removes the `MAX_COLLECTED_MATCHES` caps and the "only first N navigable"
  warnings, because the database returns matches directly rather than the UI
  collecting them in memory.

### Seeding behavior
Chunked, cancellable, off-thread seeding completely resolves the earlier hang. The
UI stays interactive throughout, progress is visible, and the operation is
abortable. With OPFS persistence, seeding is a **one-time cost** per device — the
database survives reloads, so the cost is not paid on every session.

### OPFS findings
- OPFS SAH Pool VFS initializes without cross-origin isolation, which is the key
  practical unblock — no Vite/server header changes (which are also out of our
  control here per project constraints).
- Persistence works across reloads; re-enabling the prototype reuses seeded data.
- The in-memory fallback keeps the prototype usable where OPFS is unavailable,
  at the cost of persistence and re-seeding each session.

### Integration friction
- Comlink integration is clean; the typed client maps worker rows back to the
  `TransactionParticipant` shape so callers are unchanged.
- The main cost is the worker boundary: data crosses by structured clone, so very
  large result sets pay a serialization tax. For aggregation this is irrelevant
  (one row out); for large row dumps it argues for pushing filtering/aggregation
  **into** SQL rather than returning raw rows to JS.

---

## Recommendation: **GO** (conditional, phased)

Move the heavy, search-and-aggregate-bound tables to SQLite — but **not** because
indexed point lookups are faster. Migrate because SQLite is the only way to get
**complete, uncapped search and instant aggregation**, which is the remaining hard
problem IndexedDB structurally cannot solve. The prototype confirms the two
previous blockers are gone: the worker keeps the UI responsive, and OPFS works
without cross-origin isolation.

**Conditions / sequencing for a full migration (future work, out of scope here):**

1. **Lead with aggregation + search, not lookups.** Prioritize the queries that
   are capped today (counts, volumes, balances, substring/full-text search). Add
   FTS5 for `records` metadata and covering indexes for amount/address aggregates.
2. **Keep computation in SQL.** Return aggregates and filtered/paged result sets,
   not large raw row sets, to avoid the worker serialization tax.
3. **Migration safety is a separate task.** Seeding here is prototype-grade
   (read-only mirror). A real migration needs write-through or a clear
   source-of-truth cutover, checkpointing, and rollback — explicitly out of scope
   for this prototype and gated on this GO.
4. **Retain a fallback** for environments without OPFS (in-memory or staying on
   Dexie), since persistence is the only feature lost there.

**No-go conditions** (if a full migration is reconsidered): if the only workloads
were small indexed point lookups, staying on Dexie would be justified — SQLite adds
worker/serialization overhead without payback there. The justification rests
entirely on aggregation and full-text/substring search at scale.
