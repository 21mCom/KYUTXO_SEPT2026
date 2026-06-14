---
name: Startup migration design
description: How KYUTXO's one-time legacy migrations run at login and the invariants that keep large vaults from breaking.
---

# Startup migration design

On login, `AuthContext` runs one-time migrations: attachment-path normalization, then legacy field decryption, then legacy attachment-file decryption (restoring plaintext from a preserved `_legacyEncryptedPayload`; field-level encryption was removed in v1.1.28).

Invariants that must be preserved:
- **Serialized, not concurrent.** Path normalization must `await` before legacy decrypt, which must `await` before file decrypt. Running them concurrently on a large vault starves them into IndexedDB `AbortError`/`TransactionInactiveError` aborts (surfaces as "Failed to load filtered records").
- **Single-flight.** The migration is fire-and-forget from `login()`. A `migrationInFlightRef` guard prevents a logout/re-login from launching a second concurrent run. `logout()` must NOT clear `isMigrating` while `migrationInFlightRef` is true.
- **App gated during migration.** `App.tsx` `AppContent` must not mount the authenticated app (Dashboard/Records queries) while `isMigrating || legacyMigrationProgress || fileDecryptProgress`; otherwise data queries compete with the migration.
- **Completion flags only on full success.** Per-table checkpoints and the global "complete" flag are only written when there were no read failures and no failed decrypts, so a partial/aborted run safely retries next login. The work is idempotent (rows rewritten with the same restored data).
- **Transient DB errors are retried, not fatal.** `withDbRetry` (exp backoff) wraps reads/writes; counts use indexed `table.count()` and a count failure means "indeterminate", never "skip the table".

**Why:** Large vaults (tens of thousands of rows / many attachment files) previously hung at "0/0" or aborted because of concurrency + fragile full-scan counting.
**How to apply:** When touching login/migration/gating, keep all five invariants. Note `withTimeout` around per-file read/write does NOT cancel the underlying Electron IPC/fetch — it only unblocks the loop.
