---
name: Dexie bulk-write throughput on heavily-indexed tables
description: Why a literal million-row seed is impractical for a browser scale-check, and how to size a representative substitute
---

A Dexie table with many indexes (compound indexes count too) pays an IndexedDB
B-tree write per index on every insert. In this repo the `records` table
carries ~14 indexes; measured bulk-write throughput in headless Chromium
(Nix chromium, `bulkAdd`/`bulkCreateRecords` — the CRUD wrapper adds no
measurable overhead over raw `bulkAdd`) is only ~700 records/sec regardless
of chunk size. A table with few indexes (e.g. `addressSyncState`, 4 indexes)
seeds several times faster.

**Why this matters:** a literal "seed 1,000,000 records" browser check
against a heavily-indexed table can take 30-40+ minutes just to seed, which
is impractical for a repeatable check. The *scan/read* side is usually not
the bottleneck — reading and processing 100,000+ rows typically completes in
low single-digit seconds once seeded.

**How to apply:** when a task asks for a "million-record" or similarly huge
scale check, measure actual seed throughput first at a small N, then pick the
largest N that seeds within your time budget (in this repo's task environment,
~100,000 rows against `records` fits comfortably in a single 5-minute shell
call). Document the throughput ceiling and the streaming/batch design reason
the tested N's behavior generalizes linearly to the literal target scale,
rather than silently shrinking scope. Make the count env-overridable so a
larger ad hoc manual run stays possible.

See also `cdp-throttle-fast-ops.md`: once seeded, the scan itself is often
too *fast* to reliably click cancel mid-run — throttle CPU via CDP and arm
the cancel click in-page rather than inflating the seed further to slow it down.

**Measuring the effect of removing an index — isolate it from a raw Dexie
table, don't trust the full app path.** Comparing `bulkCreateRecords`
end-to-end before/after dropping indexes showed almost no difference
(~970 rows/sec either way) even though the indexes were genuinely removed.
The reason: end-to-end time is dominated by other per-record app-level work
(record-shape building, vocabulary/notification hooks, vault crypto), which
swamps the index-count signal. Isolating just the schema in a bare throwaway
`new Dexie(name).version(1).stores({...})` table in the same page and timing
`bulkAdd` directly showed the real effect clearly (~500-650 rows/sec
full-vs-reduced index count, consistent across repeated runs/orderings).
When validating an index-removal optimization, benchmark the bare
table/schema in isolation as the primary evidence; an unchanged end-to-end
number does not mean the index change did nothing.
