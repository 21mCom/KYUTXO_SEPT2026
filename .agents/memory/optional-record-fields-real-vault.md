---
name: Optional Record fields in real vaults
description: Real vault rows can lack label/tags/notes entirely; jsdom fixtures that always populate them hide browser-only crashes.
---

**Rule:** Stored rows can lack fields the TS type marks required — createRecord spreads input as-is (no defaults), and backup/merge restore writes old-backup rows verbatim, so even fields like `CustodySegment.evidenceTxids` can be absent. Any UI reading `row.arr.map`, `row.tags.length`, `row.label.trim()`, etc. must null-coalesce (`Array.isArray(x) ? x : []`).

**Why:** The Database Doctor Resolve-duplicate dialog passed all jsdom tests (fixtures always set tags/label) but crashed instantly in a real browser vault ("Cannot read properties of undefined (reading 'length')") because the seeded keeper had no tags field. Later, the Continuity Proof "All Custody Segments" list repeated the class: a sparse restored segment with `hopCount > 0` but no `evidenceTxids` crashed `renderSegmentCard` mid-append — with no error boundary this tears down the whole tree, which users experience as "Load more does nothing" (first page fine, click kills the list).

**How to apply:** When writing components or tests over stored rows, include at least one fixture/seed row that omits "required" array/string fields; in browser checks, seed via the real CRUD layer (which reproduces the sparse shape) rather than hand-built full objects. For PAGED lists, place the sparse row OFF page one (lowest ids) so the crash triggers on Load more, matching how users hit it. Render crashes with no error boundary present as dead controls, not error screens.
