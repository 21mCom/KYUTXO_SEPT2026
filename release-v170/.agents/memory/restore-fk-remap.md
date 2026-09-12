---
name: Restore/import FK remap
description: Why backup-restore and import flows must remap dependent-row foreign keys when records are re-inserted with new autoincrement ids.
---

# Restore/import FK remap

When a restore/import flow re-inserts parent rows via a bulk create that assigns
**new** autoincrement primary keys (e.g. `bulkCreateRecords` on `db.records`,
which uses Dexie `bulkAdd` with `allKeys:true` and returns new ids in input
order), every dependent row that references the parent by id must have its
foreign key rewritten old→new. Keeping the backup's original id is wrong because
that id space no longer exists after re-insert.

**Why:** A backup restore once linked attachments / transaction participants /
addressSyncState to the backup's stale `recordId` values, producing dangling or
cross-wired links and breaking downstream cleanup classification. The id a row
had when it was exported is meaningless after it is re-added.

**How to apply:**
- Build an `oldId -> newId` map while inserting parents.
- In **merge** mode, map skipped (already-present) parents to the existing live
  id, not a new one (dedup by a stable natural key, e.g. `inputStringLower`).
- For dependents where the FK is **required** (attachments → recordId): skip the
  row as an orphan if the parent didn't map.
- For dependents where the FK is **optional** (participants, addressSyncState →
  recordId): leave it `undefined` when unmapped (keep the row, just unlinked).
- Known remaining gap: evidence/evidenceAttachment restore has the same class of
  issue for `evidenceId` (not yet remapped) — treat as separate hardening work.
