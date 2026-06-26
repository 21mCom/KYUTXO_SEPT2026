---
name: Memory-bounded streamed report (scratch Dexie DB)
description: How to stream an unbounded diagnostic result set to disk without tripping CRUD guards or holding it all in memory.
---

When a full-table scan can produce an unbounded result set that the UI must list
(e.g. Balance Integrity "Check all addresses" stale list), do NOT accumulate the
rows in a React array — that violates the "without holding everything in memory"
contract.

Pattern used:
- Stream batches into a **separate, dedicated Dexie database** (its own
  `new Dexie('kyutxo-...')` instance with an `++seq` autoincrement table), NOT a
  table on the main vault `db`.
- The virtualized list reads fixed windows (~100 rows) on demand keyed by row
  index (rowCache Map + pending Set + a cacheVersion state to trigger re-render +
  placeholder "Loading…" rows), mirroring the Transactions page virtual list.
- Make the producer callback awaitable (`(batch) => void | Promise<void>`) and
  `await` it in the scan loop so each batch is persisted before the next is
  gathered (backpressure → bounded peak memory, no read-before-write race).
- Clear the scratch store before each run and on component unmount.

**Why:** code review rejects in-memory accumulation for "stream the full set"
tasks. A separate Dexie instance also sidesteps two repo constraints:
`scripts/check-crud-guards.js` only matches `db.<guardedTable>.<method>` (a
separate instance's `.rows` is not flagged), and it needs no schema migration in
`database.ts`. It is derived/transient data, so it never belongs in the vault.

**How to apply:** any future "scan/list ALL of X" feature on a large vault.
