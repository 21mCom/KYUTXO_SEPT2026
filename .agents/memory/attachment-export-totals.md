---
name: Attachment export totals
description: The fail-closed invariant for manifest-first attachment exports.
---

Successful backups must compare the number and exact bytes of attachment files actually added to the archive with the filesystem summary written into the manifest. Any mismatch aborts the sink before finalization. Only enforce byte equality when the runtime supplied an exact filesystem total; metadata-size fallbacks are estimates.

**Why:** The restore preflight needs the manifest count and byte total to describe the archive exactly, but the manifest is intentionally written before the separate attachment streaming traversal. Concurrent local file changes can otherwise leave a valid-looking archive with false sizing metadata.

**How to apply:** Keep browser and Electron summaries aligned, count a file only after it can be statted, and route all production exports through the shared post-stream invariant.