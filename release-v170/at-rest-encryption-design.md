# Built-in at-rest encryption design

## Status and decision

This is a design decision and implementation contract, not an implementation.
The current application still uses plaintext IndexedDB and plaintext attachment
files. The login and Settings copy must continue to say so until the release
gates in this document pass.

For packaged Electron builds, the target is:

1. A SQLCipher-backed SQLite database owned by a native Electron worker. It
   becomes the primary vault store; the existing native SQLite engine is not
   promoted from read replica to primary by itself.
2. An encrypted, chunked attachment store owned by the same main-process
   boundary. Attachment bytes must not be exposed as plaintext files in the
   data directory.
3. A narrow, typed IPC/repository interface for the renderer. The renderer
   must not receive a database path, open SQLite, or read the attachment
   directory directly.
4. Dexie as the browser/development fallback only. That mode must retain the
   current warning and must never report built-in at-rest encryption.

This is the only design in scope for built-in protection. Encrypting individual
IndexedDB fields, or encrypting only the existing native read replica, is not
acceptable because IndexedDB indexes and the live primary store would still
disclose vault data.

## Why this design

### Rejected approaches

- **Field or record encryption in IndexedDB:** leaves table structure, indexes,
  sizes, and any unhandled field readable; every query path would also need
  bespoke encrypted-index handling. A missed write path would silently create
  plaintext rows.
- **Encrypted native read replica:** protects only a copy while the Dexie
  primary database and attachment files remain plaintext. It does not meet the
  requirement.
- **One encrypted export file used as the live database:** would require
  rewriting or loading the vault for ordinary queries, breaks current
  pagination and large-vault behavior, and makes crash recovery harder.
- **An encrypted folder or OS key store:** depends on a platform facility the
  feature is intended to replace, and makes portable vaults non-portable.

SQLCipher keeps SQLite transactions, indexes, and keyset queries while
encrypting the database pages and SQLite journal/WAL files. A separate
chunked file format keeps large attachments streamable without putting them in
SQLite BLOBs or building an entire file in renderer memory.

## On-disk format

The protected data directory contains only:

- A small, non-sensitive metadata header with a format version, vault UUID,
  salt, KDF record, active generation, and a wrapped random vault data key.
  It must not contain labels, addresses, notes, filenames, attachment sizes,
  or a reusable plaintext password verifier.
- The SQLCipher database and its encrypted journal/WAL files.
- Opaque, randomly named encrypted attachment objects.
- A non-sensitive migration/recovery marker. Marker values may describe a
  phase and generation, but never contain vault rows or paths in user-facing
  output.

The random vault data key (VDK) is generated once for the protected vault.
The password derives a wrapping key using the current versioned Argon2id
parameters and the existing encryption-key domain label. The VDK is wrapped
with AES-GCM and authenticated metadata. The VDK is then used only through
domain-separated subkeys:

- one SQLCipher key;
- one attachment-content key;
- one attachment-name/format key if the implementation needs it.

Password changes re-wrap the VDK instead of re-encrypting every database page
and attachment. This makes a password change bounded and avoids a second
multi-hour migration. A forgotten password remains unrecoverable without an
encrypted backup; there is deliberately no recovery bypass.

Attachment objects use a versioned header followed by fixed-size encrypted
chunks. Every chunk has a unique nonce and authenticated data containing the
vault/object identifier, format version, chunk index, and plaintext length.
Reads and writes are streamed through the main process. No temporary plaintext
attachment is created.

The metadata header is not secret, but it is integrity-protected by the
wrapped-key envelope. A candidate password must successfully unwrap the VDK
and open an authenticated sentinel before the vault is considered unlocked.
Wrong-password errors are generic and do not reveal whether a partial store
exists.

## Key and lock lifecycle

- The password is accepted only through the existing trusted login flow and is
  never persisted.
- The main process passes a validated unlock request to the native worker. The
  worker owns the open SQLCipher connection and VDK while the vault is open.
- Lock closes the database, cancels/finishes the protected attachment session,
  drops the worker's key references on a best-effort basis, and then crosses
  the normal `AuthContext` lock boundary.
- Protected-store IPC calls fail closed while locked. They do not open a
  database or attachment object as a side effect.
- The renderer receives records and attachment data only for an authenticated
  request. It may still hold data that React or the browser has already
  rendered; at-rest encryption does not protect a compromised live process or
  memory forensics.
- The password verifier and migration flags move into the protected settings
  table. Device-local UI preferences remain outside the vault and must never
  be treated as protected vault data.

The KDF record travels with the protected store. New stores use the current
Argon2id record; legacy PBKDF2 parameters remain readable during migration.
The password itself does not change when a plaintext vault opts in.

## Plaintext-vault migration

Migration is opt-in, packaged-Electron-only, and must be an explicit,
recoverable state machine:

1. **Preflight:** verify the current password, verify that the source vault is
   readable, audit attachment links, calculate the space requirement, and
   require enough free space for a staged encrypted store plus the source.
   The UI must explain that old deleted bytes cannot be securely erased on all
   filesystems, especially SSDs.
2. **Freeze:** prevent writes and show a progress overlay. The source remains
   the authoritative vault during this phase. A migration generation and phase
   are recorded without sensitive data.
3. **Stage:** stream every Dexie table, settings row, and attachment into a
   new protected store on the same filesystem. Preserve IDs and all nullable
   fields exactly. Do not mutate or delete the source while copying.
4. **Verify:** reopen the staged store using the candidate password and verify
   per-table row counts, stable digests over canonical serialized rows,
   attachment byte counts, attachment digests, foreign-key/reference checks,
   and the SQLCipher integrity check. A missing row, duplicate, or attachment
   mismatch aborts migration.
5. **Commit:** fsync staged files and directories, atomically publish the
   protected generation, and only then remove the live IndexedDB database and
   plaintext attachment tree through controlled main/renderer APIs. Re-scan
   the active data directory before declaring the store protected.
6. **Complete:** write the completion marker only after the protected store
   opens, the sentinel succeeds, the verification scan succeeds, and no active
   plaintext source remains. Until then, the UI must say migration is
   incomplete and must not claim at-rest protection.

If any preflight, copy, verification, or cleanup step fails, the source vault
remains available and the protected generation is discarded or left as a
recoverable staged generation. The source is never deleted merely because a
copy started. A crash is recovered from the marker: an unverified stage is
removed, a verified-but-uncommitted stage is resumed or committed, and an
ambiguous commit is resolved by opening and verifying both generations before
choosing one. There is no path that reports success from a marker alone.

Deletion of old IndexedDB/attachment files prevents normal application access,
but filesystem deletion cannot prove that old plaintext sectors were
overwritten. Consequently the product may claim protection for the active
store, not forensic erasure of bytes already written by a prior plaintext
store. A user requiring that stronger guarantee must securely wipe or retire
the old device/container.

## Backup and restore

- Backups remain independent encrypted v3 archives with a fresh salt and the
  versioned encryption-key KDF. A protected vault defaults to encrypted
  backups; plaintext backup remains an explicit opt-in with a warning.
- Export reads authenticated rows and streams attachment plaintext only
  through the in-process export pipeline. It must never copy a SQLCipher
  database file, WAL, journal, or protected attachment object into an
  archive.
- Restore decrypts and validates into a staging protected store. It checks the
  manifest sentinel, counts, row/reference integrity, attachment digests, and
  SQLCipher integrity before an atomic generation swap.
- Wrong-password, truncated, corrupt, and disk-full restores leave the active
  vault untouched. A partial staging generation is safe to delete or resume
  and is never mounted as the active vault.
- A protected backup can recover a lost local store, but it cannot recover a
  forgotten password. The backup password is independent of the local vault
  password and must be requested explicitly.

## Crash safety and consistency

- SQLCipher uses transactions, `synchronous=FULL`, and an encrypted WAL or
  rollback journal. The implementation must prove that the chosen SQLCipher
  build encrypts temporary, journal, and WAL pages too.
- Protected attachment writes use a same-directory temporary encrypted object,
  flush and fsync it, then atomically rename it. The database row is committed
  only after the object is durable.
- Deletes are journaled as tombstones: the metadata change is durable first,
  and object removal is retryable and idempotent. An orphaned encrypted object
  is harmless and is reconciled later; a database row never points to a
  partially written object.
- Migration, password re-wrap, restore, and generation cleanup are
  idempotent. Every failure path leaves either the last verified generation or
  a clearly recoverable staged generation.
- Main-process logs contain operation names and counts only. They never include
  passwords, keys, row data, attachment filenames, absolute paths, or raw
  filesystem errors.

## Performance and packaging requirements

Before release, a prototype must be built and tested for every supported
Electron target (Windows, macOS, Linux, and supported CPU architectures):

- SQLCipher and its native addon must be rebuilt for the exact Electron ABI and
  load from the packaged application without depending on a system library.
- Migration and restore must stream in bounded batches and never materialize
  the full vault or an attachment in renderer memory.
- Normal reads must use the same keyset pagination and indexed query shapes as
  the current large-vault paths. KDF derivation happens once per unlock, not
  once per row or request.
- Benchmarks must compare protected and current stores on representative
  large-vault reads, bulk imports, edits, attachment uploads/downloads,
  export, restore, lock, and unlock. A performance regression is a release
  blocker if it causes existing bounded/virtualized flows to load the whole
  vault.
- Packaged tests must inspect the data directory while locked and after
  writes; no active database, WAL/journal, attachment object, temp file, or
  backup staging file may contain recognizable fixture plaintext.

## Implementation boundaries

The implementation must be split into independently testable layers:

1. Native protected-store worker and typed main-process IPC, including key
   lifecycle and crash recovery.
2. A renderer repository adapter that preserves the existing CRUD contracts
   and uses Dexie only outside protected packaged mode.
3. Encrypted attachment streaming and reconciliation.
4. Plaintext-to-protected migration and protected backup/restore generation
   swaps.
5. AuthContext integration, protected-store status, and only then UI copy.

The existing `client/src/lib/database.ts` schema and CRUD modules must not be
silently bypassed by a second renderer database. `electron/main.cjs` must
select the protected store before the renderer can issue data requests.
`AuthContext` must treat protected-store unlock and verification as part of
login, not as an optimistic UI flag.

## Release gates for changing UI claims

No login, Settings, threat-model, or help text may say that the vault is
protected at rest until all of these are passing in a real packaged build:

- fresh protected-vault create, unlock, lock, reopen, and wrong-password tests;
- plaintext-vault migration with zero data loss, including interrupted runs at
  every migration phase and successful resume/rollback;
- protected database and attachment tamper detection;
- password re-wrap and encrypted-backup recovery;
- crash injection during a database transaction, attachment write, restore,
  and generation swap;
- locked-state filesystem inspection proving no active plaintext store;
- representative large-vault performance and bounded-memory checks on every
  packaged target;
- a browser check proving `AuthContext` reports protection only after the
  main-process verification result, never from a local setting alone.

Until then, the current copy — “the password locks access to the app; it does
not encrypt vault data stored on disk” — is accurate and must stay.
