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

**Also (savedPsbts → evidence refs):** references the OTHER direction (a restored row
carrying an id INTO evidence) need the maps exported from `restoreEvidenceRows` and
applied in that table's own restore helper, remapping through them and DROPPING refs
whose target isn't in the backup (never leave a stale numeric id — after a wipe it can
collide with an unrelated live row). Merge-skipped duplicate evidence maps onto the
existing live document by identity (attachments by filename) so the refs stay valid.

**Why:** these are exactly the silent, count-passing corruptions a deep-equality
round-trip test catches but a count-only test misses.

**How to apply:** when adding/changing any inline table that carries an id reference
to another table, add (or extend) the id remap in `inline-tables.ts` restore and a
deep-equality round-trip test in `inline-tables-roundtrip.runtime.test.ts`.
