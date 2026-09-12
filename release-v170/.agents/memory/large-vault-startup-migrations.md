---
name: Large-vault startup migrations
description: How KYUTXO keeps login fast/reliable on huge vaults — bounded batched startup repairs, once-only flags, fresh-vault skip, and the resumable file-decrypt freeze-on-failure design.
---

# Large-vault startup migrations

KYUTXO runs one-time "startup repair" passes after unlock: attachment-path
normalization, legacy metadata decrypt, legacy file decrypt, and inputStringLower
repair. On 100k-record / 10M-tx / 20M-participant vaults these used to freeze login
because each loaded a whole big table into memory.

## Durable invariants
- Every startup repair MUST walk tables in bounded id-keyset batches and yield
  between batches; never load a whole table. Each pass is gated by a once-only vault
  flag so it runs at most once per vault.
- **Login must never block on migrations.** They are fired in the background
  (not awaited). The hard requirement is that a one-time, possibly hours-long
  migration must never block login again — design every change to preserve this.
- **Fresh-vault fast path must be data-gated.** Marking all migration flags complete
  up front (so a brand-new vault skips every scan) is only safe when the data DB is
  genuinely empty. Check EVERY table the repairs touch (records, regular attachments,
  evidence attachments). **Why:** a vault row created over pre-existing data (import
  flow / late vault creation on upgrade) would otherwise permanently strand that
  legacy data unrepaired. If data is found at setup, fire the repairs in the
  background instead of skipping them.

## File-decrypt resume: freeze, don't break
The file-decrypt checkpoint advances ONLY over fully-clean batches and FREEZES on the
first hard (IO) failure, but the run KEEPS PROCESSING later files (it does NOT break).
- **Why continue-not-break:** breaking on the first failure would let one
  permanently-unreadable file block decryption of every later file forever.
- **Why re-scanning is safe:** real `decryptBinary` THROWS on plaintext, so an
  already-decrypted file is a benign decrypt-fail *skip* on rescan — never
  re-decrypted, never re-corrupted, never a hard failure. With background
  (non-blocking) login, repeated bounded rescans self-heal and never block.
- Resume therefore reprocesses the WHOLE suffix after the last clean checkpoint
  (not "only the failed batch"); only the previously-failed file actually re-decrypts.

## Test conventions
- `scale-guards.static.test.ts` ratchets the count of unbounded full-table read call
  sites down to a BASELINE — only ever lower it as offenders are removed, never raise.
- Prove the runtime bound by asserting the PEAK rows from any single `toArray` ≤ batch
  size; TOTAL rows are always O(N) and useless as a bound.
- Run tests with `vitest run <substring>` FROM THE WORKSPACE ROOT (not `client/`).
  `tsc` is NOT a registered validation step.
