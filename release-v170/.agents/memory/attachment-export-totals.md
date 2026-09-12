---
name: Attachment export totals
description: The fail-closed invariant for manifest-first attachment exports.
---

Successful backups must compare the number, exact bytes, and an order-independent path+content fingerprint of attachment files actually added to the archive with stable filesystem summaries taken before and after streaming. Any mismatch aborts the sink before finalization. Only enforce byte equality when the runtime supplied an exact filesystem total; metadata-size fallbacks are estimates.

**Why:** The restore preflight needs the manifest count and byte total to describe the archive exactly, but the manifest is intentionally written before the separate attachment streaming traversal. Counts and bytes miss same-sized rewrites, and a single pre-stream fingerprint misses rewrites to files already archived while later files are still streaming.

**How to apply:** Keep browser and Electron summaries aligned; hash through an open file handle and reject identity/timestamp changes during the read; compare pre-stream, archived-byte, and post-stream fingerprints through the shared invariant.