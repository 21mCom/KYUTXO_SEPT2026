---
name: Legacy migration gotchas (KYUTXO v1.1.28 decryption)
description: Non-obvious data-integrity traps in the one-time legacy decrypt/path migration on large vaults.
---

# inputStringLower goes stale after legacy record decryption
`decryptLegacyRecords` (client/src/lib/legacy-decrypt.ts) restores `inputString` from the
`_legacyEncryptedPayload` but historically did NOT recompute `inputStringLower`.
The v30 DB migration populates `inputStringLower` from `inputString`, but at that point
formerly-encrypted records have empty/placeholder `inputString` (sensitive field stored only
in the encrypted blob; v29 also blanks `[encrypted]` placeholders), so `inputStringLower`
ends up empty. After decryption restores plaintext `inputString`, `inputStringLower` stays empty.

**Why it matters:** every indexed inputString lookup (`.where('inputStringLower').equals/startsWith`)
silently MISSES formerly-encrypted records. Any "fast path" that routes a pasted address/txid to
the index returns incomplete results unless `inputStringLower` is repaired first.
**How to apply:** when restoring/writing records, always recompute `inputStringLower` in lockstep
with `inputString` (record-crud already does on create/update). For already-migrated vaults, run a
batched repair (keyset iteration + withDbRetry, NOT a full-table .modify in one tx — large vaults
are 5GB+ and abort).

# Attachment path prefix mismatch (Electron vs server)
Server (server/attachments.ts) stores `objectStoragePath` WITH an `attachments/` prefix and
resolves download/delete against DATA_DIR; Electron (electron/file-handlers.cjs) stores WITHOUT
the prefix and resolves read/write/rename/delete against attachmentsDir. A vault carrying prefixed
paths is unreadable under Electron (`attachmentsDir/attachments/...`) → attachments appear "deleted".
**Fix direction:** make BOTH backends prefix-tolerant (strip a leading `attachments/` before
joining the base dir) rather than bulk-rewriting stored DB paths. Keep the `..`/absolute-path
security checks.

# Root-folder (single-segment) attachments are skipped by migrateAttachmentPaths
`migrateAttachmentPaths` parses `[attachments/]<dir>/<file>` (2-3 segments). A legacy path that is a
single segment (`file.pdf` or `attachments/file.pdf`) yields fileName===undefined and hits
`if(!dirName||!fileName)continue` → never migrated to the hashed/opaque layout, never re-decrypted
via the normal flow. No code physically deletes them — they are orphaned/unreadable, likely still on
disk. "PDF failures" are not file-type-specific (AES-GCM is type-agnostic); they just happened to be
among the root-folder files. Recovery must be copy-then-verify-then-DB-update and must NOT delete old
dirs until verified.
