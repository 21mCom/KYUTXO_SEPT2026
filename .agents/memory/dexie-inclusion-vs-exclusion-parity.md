---
name: Dexie inclusion-index vs exclusion-semantics parity
description: Why anyOf() narrowings silently hide unknown/missing enum keys that SQL exclusion predicates show, and the fix pattern (dynamic uniqueKeys + re-runnable repair)
---

**Rule:** When one read path narrows with a Dexie inclusion index (`where(field).anyOf(staticList)`) and another uses exclusion semantics (SQL `field IS NULL OR field NOT IN (hidden…)`), rows carrying unknown/legacy values silently diverge: browse/engine show them, the Dexie-narrowed search does not. Never add a "hide these enum values" feature with inclusion semantics on one path and exclusion on the other.

**Why:** Old backups restore legacy enum strings verbatim; one-time normalization migrations never re-run. The divergence is invisible (no error — rows just drop out of one surface), and users read it as data loss.

**Fix pattern:**
- Resolve the visible value list dynamically at query time: `orderBy(field).uniqueKeys()` minus the hidden values, unioned with the static list; fall back to the static list on error. `uniqueKeys()` cost is bounded by the number of DISTINCT values, fine at 100k+ rows.
- Pair with a re-runnable, provenance-aware repair that normalizes stray values (see tier-provenance-classification.md).
- Residual gap: rows MISSING the indexed key entirely are invisible to EVERY Dexie index on that field (Dexie cannot index absent keys). Cover them via alternate paths (engine SQL exclusion, exact-identifier lookups on other indexes) plus the repair; document the gap — don't pretend the index can reach them.
- When hidden-by-default rows can match a search, count them (capped walk on the hidden-value index; engine include-minus-exclude count diff) and surface an explicit "N matches hidden" hint with a one-click include — never a bare "No results".
