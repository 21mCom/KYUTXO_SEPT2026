---
name: createdAt sorts need id tie-breaks
description: Ordering rows by Date.now() timestamps alone is flaky — same-millisecond inserts sort arbitrarily.
---

**Rule:** Any "most recent row wins" logic sorted by a `Date.now()` createdAt must tie-break by auto-increment id (`b.createdAt - a.createdAt || b.id - a.id`).

**Why:** Rows inserted in the same millisecond sort arbitrarily; a de-dup that compares against the "latest" row then intermittently picks the older one (surfaced as a test that passed alone but failed under parallel suite load, and would mis-de-dup in production too).

**How to apply:** When adding or reviewing recency-ordered queries/sorts over Dexie tables, include the id tie-break; when a recency test flakes only under load, suspect a timestamp tie before blaming the harness.
