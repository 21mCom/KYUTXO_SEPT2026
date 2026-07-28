---
name: Bulk-import vocabulary must use ensure*
description: Why strict createOwner/createWalletName/createSeedName/createWalletSoftware calls after a record-save loop always throw "already exists" and sink the whole import.
---

Rule: after any loop that creates records, never call the strict vocabulary
creators (`createOwner`, `createWalletName`, `createSeedName`,
`createWalletSoftware`, `createTag`, `createCategory`) guarded only by React
hook state. Use the idempotent `ensure*` helpers (or `sync*ToMaster`) from
`vocabulary-crud`, and treat vocabulary problems as non-fatal warnings.

**Why:** every `createRecord` fire-and-forgets `syncRecordVocabulary`, which
inserts owner/walletName/seedName/walletSoftware rows mid-loop. The hook state
captured at render time is stale, so the "does it exist yet?" guard passes and
the strict create throws `"... already exists"` AFTER all records were written.
The save's catch then shows "Save failed" and skips the completion step, so
users conclude the import was lost even though every row persisted (Descriptor
Import failed this way on literally every save because walletSoftware defaults
to "Sparrow").

**How to apply:** in import/save flows, run vocabulary upkeep inside its own
try/catch that appends a warning instead of failing the import; verify the
completion summary against a post-save DB re-lookup so counts reflect actual
database state. Regression pattern: seed the vocabulary tables first, then run
the save and assert it still succeeds (see the descriptor-import save tests).
