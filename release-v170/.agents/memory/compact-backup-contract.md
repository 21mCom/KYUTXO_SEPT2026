---
name: Compact backup prune/rebuild contract
description: Invariants any backup or table change must preserve for the compact (prune bare discovered records) export option.
---

**Rule:** The compact export prunes only rows whose every anchor is discovery-bare (records via a frozen field classification; history rows only when no kept record/address/tx-record touches them). Restore of a compact-marked backup rebuilds `blockchain-discovered` shells locally for any kept participant whose recordId is missing from the id map (reusing an existing record by inputString in merge mode). Post-restore network sync can NEVER recreate pruned rows — `syncAddress` skips already-synced heights and already-known txids, and counterparty discovery only runs for newly imported txs — so the local shell rebuild is the only correction path.

**Why:** The original plan assumption "a post-restore sync re-adds discovered records" was false; shipping that would have silently produced restored vaults with dangling recordIds and missing counterparties.

**How to apply:**
- Any NEW streamed backup table must be classified into the compact row filters (drop / keep / scrub) or compact backups will silently keep or drop its rows wrong.
- Any NEW `Record` field must be classified machine-vs-user in the classification map; the freeze test fails the build until it is. Unknown runtime-only keys with meaningful values fail safe to "keep".
- Bare tx-type records are pruned iff their txid's transaction is pruned — keeping them would trigger post-restore orphan-tx network backfill for history the user chose to drop.
- Every rebuilt-shell insert path must join the merge undo log so cancel removes them.
- Plan sets (dropped ids/addresses/txids) are in-memory Sets, matching the merge-restore natural-key precedent; revisit the scratch-Dexie pattern only if discovered rows reach many millions.
- `discoveredFromRecordId` is scrubbed at export when the target is dropped; restore does NOT remap this field (pre-existing quirk shared with full restores — pointers hold stale backup ids).
