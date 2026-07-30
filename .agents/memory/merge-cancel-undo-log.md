---
name: Merge-cancel undo log
description: How cancelling a v3 merge restore rolls back everything the merge added
---

Cancelling a v3 merge restore triggers an in-memory session undo log (chosen over DB tagging — would need schema bumps across all streamed tables — and snapshot-diff — unaffordable at scale).

Rules to preserve when touching the restore pipeline:
- Every merge INSERT path must record its new ids in the undo log — streamed tables AND the inline-compatibility lineage/segments/snapshots (restoreInlineTables returns their inserted ids; don't drop that return).
- Enrichments record priors: transactions capture only the changed keys' prior values; participants capture the whole original live row before first enrichment.
- Attachment files: only sweep files whose ROW this merge inserted (colliding paths are shared content backing pre-existing rows). Needs-Review orphan files must be undone via the exact filename writeReview() RETURNS (folder de-dupes names) + deleteReview().
- Undo failure sets mergeUndoFailed on BackupCancelledError; re-running merge stays safe (all tables de-dupe by natural key). Inline METADATA (vocab/custom fields/templates/evidence/prices) is intentionally not undone; the toast stays honest about that.

**Why:** code review rejected twice for missed insert paths (inline lineage; writeReview files) — any new merge write path must join the log or cancel leaves residue.
