---
name: Attachment files are never unlinked on record/attachment delete
description: Record/attachment deletion archives metadata and leaves bytes on disk; physical purge is explicit-only. Don't reintroduce file unlinking in delete paths.
---

# Deleting a record or attachment must NOT unlink the file
Record deletion (`deleteRecord`) and the per-attachment "remove" action (`trashAttachment`) archive
attachment metadata into the `trashedAttachments` Dexie table and leave the file bytes on disk. They
never call the physical delete. All record-delete entry points (Records single + multi-select,
Dashboard, Cleanup bulk) funnel through `deleteRecord`, so protecting that one function covers them all.

**Why:** a large real vault lost attachment files after the v1.1.28 de-encryption upgrade because the
old `deleteRecord` silently unlinked every attached file (no confirm, no undo); the Database Cleanup
tool amplified this across many records at once. Offline-first means "recoverable" = still on local
disk, recoverable from Settings > Deleted Attachments.

**How to apply:**
- Physical deletion (`deleteFile` / `api.deleteAttachment`) is allowed ONLY for upload rollback
  (`uploadAttachment` failure) and the EXPLICIT user purge in Settings (download-then-purge or
  "empty trash"). Never wire it into a delete/cleanup path again.
- `archiveAttachments` is binary-safe: it copies metadata only (filename/mimeType/size/path/
  identifier), never reads/moves/transforms bytes, so a recovered file is byte-identical.
- The read-only `auditAttachments()` intentionally reports these kept files as orphaned/recoverable
  (file on disk, no DB row) — that is truth, not a bug.
- Evidence document deletion (`Evidence.tsx`) still unlinks files immediately — same data-loss shape,
  NOT yet protected (out of scope of the record-attachment work).
