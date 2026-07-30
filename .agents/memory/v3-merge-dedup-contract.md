---
name: v3 backup merge de-dup contract
description: Merge-mode restore must de-dupe EVERY table by natural key, including within-stream duplicates — reviewers reject partial coverage.
---

Merge-mode backup restore is only accepted when the natural-key de-duplication contract holds for **every** persisted table, not just the headline streamed ones.

**The full surface:**
- Streamed tables: records (by inputString), attachments, participants, blockchainTransactions (txid), addressSyncState (address), lineage tables (natural keys).
- Records need a **restore-wide** inputString→liveId map: per-batch DB lookups miss duplicates split ACROSS batches (earlier batch's insert isn't "existing" yet) and duplicates WITHIN one batch (batch collected before any insert). Collapse in-batch dups onto the first occurrence's eventual id and remap dependent rows' FKs.
- Inline tables: vocabulary (tags/categories/owners/walletNames/seedNames/walletSoftware — raw restore helpers are blind Dexie `add`s, de-dupe by name), custom fields (slug), derivation templates (fingerprint+scriptType+path+network — no unique index), price data (pass restoreMode through to its shared helper; don't hardcode "replace").

**Why:** three successive code-review rejections each found one more table family that duplicated on re-merge. `inputString` and vocab names are indexed but NOT unique, so nothing at the DB level stops duplicates.

**How to apply:** when adding merge/idempotence semantics to any restore path, enumerate every table the backup carries (streamed + inline) and add both an existing-rows check and a within-incoming-stream seen-set; test idempotence (merge same backup twice) plus same-batch and cross-batch duplicate identities with dependent-row FK assertions.
