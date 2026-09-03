---
name: Derived report checkpoints
description: Safety and memory rules for large native reports derived from the engine mirror.
---

Native report checkpoints must be keyed to every source-table field used by the existing mirror freshness gate. Persisted checkpoint metadata is observability only; never read it as report data or let it bypass the freshness gate.

**Why:** A row-count page cap alone does not bound IPC or renderer memory when one row contains unbounded nested arrays. Detail responses can also race a mirror refresh and display data from a different snapshot.

**How to apply:** Strip heavy nested data from list windows, page each independently sized list and nested detail collection, and require detail requests/responses to match the checkpoint key of the visible list page. Reserve complete payloads for explicit export operations.