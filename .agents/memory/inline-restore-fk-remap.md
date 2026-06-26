---
name: Inline backup restore FK remapping
description: Why id-referencing inline tables (evidence -> evidenceAttachments) must remap ids on v3 restore
---

# Inline backup restore must remap id foreign keys

Inline tables in the v3 backup are re-`add`ed on restore (id stripped), so they get
fresh auto-increment ids. `Table.clear()` does NOT reset IndexedDB's key generator,
so restored ids are almost never the originals. Any inline table that references
another inline table BY id must be remapped, or the link silently breaks.

**Concrete case:** `evidenceAttachments.evidenceId` -> `evidence.id`. Restoring
evidence then re-adding attachments with the original `evidenceId` orphaned every
attachment. Fix: capture `bulkAddEvidence` returned ids (`bulkAdd(..., {allKeys:true})`),
build an old->new evidence id map, remap attachment `evidenceId` (fallback to original
if unmapped). Mirrors the records->dependents idMap pattern in `restore.ts`.

**Also:** CRUD `addX` helpers that hardcode `createdAt: Date.now()` silently drop a
restored timestamp. Honor a caller-provided value (`data.createdAt ?? Date.now()`) and
make `createdAt` optional on the Create* input type, like `addCustomField` does.

**Why:** these are exactly the silent, count-passing corruptions a deep-equality
round-trip test catches but a count-only test misses.

**How to apply:** when adding/changing any inline table that carries an id reference
to another table, add (or extend) the id remap in `inline-tables.ts` restore and a
deep-equality round-trip test in `inline-tables-roundtrip.runtime.test.ts`.
