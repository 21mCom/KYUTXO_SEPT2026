---
name: records-query planner key coverage
description: Adding a new operator to an existing filterable field in records-query.ts's index-narrowing planner requires a matching FIELD_PRIORITY / classifyFilter entry, or the fast index path silently disappears with no failing test.
---

`client/src/lib/records-query.ts`'s `classifyFilter` decides whether a `ColumnFilter` can be turned
into a Dexie index lookup (`equals` / `startsWith` / `multiEntry` / `anyOf`) or must fall back to a
broader scan (tier-based `anyOf`, or a full-table walk) filtered purely by the residual JS predicate.
It gates on a `${field}_${operator}` lookup into a `FIELD_PRIORITY` map — if that exact key isn't
present, `classifyFilter` returns `null` **before even entering the `switch`**, regardless of what
the `switch` cases below it could otherwise handle.

**Why this bites**: correctness never breaks. The residual predicate (`applyColumnFilters` /
`matchesColumnFilter`) is applied unconditionally via `collection.and(residualPredicate)`
independent of whatever narrowing was chosen, so a missing priority-table entry produces the
*right rows* — just via the wrong, much broader Dexie query (e.g. the default address-importance-tier
`anyOf` scanning every curated-tier row instead of an indexed multiEntry/anyOf lookup on the actual
filter field). No unit test catches this because none of them assert *which* Dexie index a query
plan used — only the final row set, which is identical either way.

**How to apply**: whenever a filter producer starts emitting a new `operator` value for a field that
already has index support under a different operator (e.g. adding an `isAnyOf` multi-select next to
an existing `equals`/`includes`/`startsWith` single-value filter), add the corresponding
`${field}_${operator}` key to `FIELD_PRIORITY` and a matching branch in `classifyFilter`'s `switch`,
and verify with `records-query.test.ts` / `records-query.equivalence.test.ts` plus a manual
`pickPrimaryNarrowing(...)` probe that the strategy source becomes `"column-filter"` (not
`"address-importance-tiers"` or `"full-table"`) for the new operator. `anyOf` narrowings on
user-typed text fields (tags/categories/owner/walletName/seedName) also need `anyOfIgnoreCase`
instead of `anyOf`, matching the residual predicate's case-insensitive comparison — plain `anyOf` is
only correct for case-sensitive enum fields like `addressImportance`.
