---
name: Derived report checkpoints
description: Safety and memory rules for large native reports derived from the engine mirror.
---

Native report checkpoints must be keyed to every source-table field used by the existing mirror freshness gate. Persisted checkpoint metadata is observability only; never read it as report data or let it bypass the freshness gate.

**Why:** A row-count page cap alone does not bound IPC or renderer memory when one row contains unbounded nested arrays. Detail responses can also race a mirror refresh and display data from a different snapshot.

**How to apply:** Strip heavy nested data from list windows, page each independently sized list and nested detail collection, and require detail requests/responses to match the checkpoint key of the visible list page. Reserve complete payloads for explicit export operations.

For protected-vault reports, materialize and cache inside the encrypted worker rather than the renderer. Key the cache to collision-resistant, full-content source and policy fingerprints; use a monotonic revision only to invalidate quickly after committed writes, and clear cached report state on lock/close.

**Why:** Renderer caches retain sensitive data after lock, miss protected-store writes, and can publish pre-commit snapshots. Count/revision-only keys do not prove immutable report identity.

**How to apply:** Keep raw source arrays build-local, return bounded checkpoint-bearing projections over fixed IPC vocabulary, and make browser fallback use the same shared calculator plus collision-resistant content fingerprints.