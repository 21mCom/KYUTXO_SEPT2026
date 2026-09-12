---
name: Restore cancellation contract
description: What cancelling a v3 streaming restore guarantees about vault state, and why.
---

A v3 restore is destructive: it wipes every table before streaming the backup
back in. Cancellation has a hard, three-outcome contract keyed on whether that
clear has run and whether post-cancel cleanup succeeded:

- **Cancel before the clear** → existing vault left fully intact
  (`BackupCancelledError.clearedBeforeCancel === false`).
- **Cancel after the clear, cleanup succeeds** → vault reset to a verified-EMPTY
  state, never half-restored (`clearedBeforeCancel === true`).
- **Cancel after the clear, cleanup FAILS** → fail CLOSED: throw a distinct
  hard error (not `BackupCancelledError`). Never claim a clean/known-empty vault
  when the reset itself errored.

**Why:** a partial restore is the worst outcome — the user can't tell what's
real. A verified-empty vault is recoverable (restore again); a vault we *claim*
is empty but isn't is a data-integrity lie. So the "empty" guarantee may only be
announced after the cleanup clear actually succeeds.

**How to apply:** any future change to the restore abort/cleanup path must keep
these three outcomes distinct — never swallow a cleanup error and still report a
successful cancel. The three cases are locked by the restore cancellation
contract tests; keep them green.

**On-disk files:** `clearVault` is DB/inline-only — it does NOT touch attachment
files on disk. A restore that fails or cancels AFTER the clear must also sweep
the files it already wrote, or they strand as orphans. The restore tracks
successfully-written relPaths (`writtenFiles`) and best-effort deletes them via
the optional `AttachmentFileWriter.delete` before/around the cleanup clear; a
delete failure is swallowed (audit/repair tools surface leftovers) and must
never mask the primary error. Note: a *successful* restore over an existing
vault still leaves the OLD vault's unreferenced files on disk (only overwritten
paths get replaced) — that broader leak is unaddressed.

**Test gotcha:** the `*-files-roundtrip.runtime.test.ts` suites share one
`KYUTXO_DATA_DIR`, and export's `list-all` walks the whole dir — so files left
by a prior test inflate a later test's export. Wipe disk at a test's start when
asserting exact on-disk counts.
