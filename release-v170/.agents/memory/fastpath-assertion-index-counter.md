---
name: Asserting a query fast path in browser checks
description: Why timing-ratio baselines fail to prove a fast path was taken, and the IDBIndex read-counter pattern that works.
---

**Rule:** To prove a "streaming scan vs per-batch anyOf" fast path is actually taken in a real-browser check, count IndexedDB reads on the index only the slow path uses (patch `IDBIndex.prototype.openCursor/openKeyCursor/getAll/getAllKeys/count`, filter by `this.objectStore.name` + `this.name`), with a positive-control probe that runs the slow-path query shape first and asserts the counter fires. Assert the timed run stays under a small allowance (slack for background queries) where the regression signature is orders of magnitude higher.

**Why:** A "full run must beat extrapolated per-batch pace" ratio gate proved meaningless: with synthetic 1-participant-per-address fixtures, sampled per-batch reads are trivially cheap (warm, indexed, tiny), so the extrapolation landed far BELOW the real fast-path run (which includes writes + tally work). The gate only passed via its unreliability escape — i.e. it gated nothing.

**How to apply:** Any browser check whose point is "the fast path is wired, not just fast enough". Keep an absolute wall-time budget as a second, independent gate. Install the counter patch inside the same `page.evaluate` before the timed call.
