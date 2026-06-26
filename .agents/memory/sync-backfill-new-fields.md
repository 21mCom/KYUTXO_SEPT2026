---
name: Sync backfill of new tx fields
description: Why backfilling new blockchainTransactions columns onto old rows must happen inside the height-skip branch of syncAddress, not only the existing-tx branch.
---

# Backfilling new fields onto already-synced transactions

When a new column is added to `blockchainTransactions` (e.g. wallet-fingerprint
fields) and you need to populate it on rows that were synced before the feature,
the backfill must run inside the **already-synced-height skip branch** of
`syncAddress` (`transaction-sync.ts`), not only the existing-tx branch.

**Why:** incremental sync checks `parsed.blockHeight <= syncState.lastSyncedHeight`
*before* it looks up the existing row, and `continue`s. After a full sync,
`lastSyncedHeight == currentHeight`, so on re-sync EVERY old tx hits that skip
branch and never reaches the existing-tx lookup. If you only backfill in the
existing-tx branch, a normal re-sync backfills nothing. There is no separate
"full rescan" trigger that resets sync state for this purpose.

**How to apply:** in the height-skip branch, gate on the parsed row actually
carrying the new data, do an indexed `txid` lookup, and update via the CRUD
layer only when the existing row lacks it. Also backfill in the existing-tx
branch (covers txs seen above lastSyncedHeight via another address). Use
`{ skipNotification: true }` + `deferNotification('blockchainTransactions')` so
the UI refreshes once per run. The single-address re-sync path reuses
`syncAddress`, so it's covered automatically. The same gap affects any future
backfill (e.g. outpoint/prevout data).
