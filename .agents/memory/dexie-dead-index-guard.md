---
name: Dexie dead-index guard pattern
description: How to build a lint/test guard that stops a Dexie table's index list from silently regaining a dead (unused) index.
---

Records-style tables in this codebase often narrow queries through a
**dynamic column-filter planner** (e.g. `records-query.ts`'s `classifyFilter`
switching on a field name string, then calling `db.records.where(n.field)`),
plus dynamic dispatch in CRUD helpers (`propagateStringFieldRename(field, ...)`,
a `groupBy`-driven `indexField` ternary). A plain source grep for
`.where('fieldName')` will never find these call sites, so a fully generic
"scan every `.where()`/`.orderBy()` literal and flag zero-hit index tokens"
guard produces false positives on real, used indexes.

**Why:** the first draft of a guard for the `records` table's index list
(task-scoped to preventing dead indexes like `syncDepth`/`flowType`/
`[owner+id]`/`[walletName+id]` from reappearing after they were dropped)
would have falsely flagged `label`, `owner`, `walletName`, `seedName`,
`walletSoftware`, `tags`, `categories`, `type`, `addressImportance`, and
`chainType` as unused, because all of them are only ever queried through a
variable, not a literal string, in at least one call site.

**How to apply:** structure the guard in layers instead of one generic
scanner:
1. **Pin** the exact, currently-audited index token set for the table (a
   `Set` literal in the guard script) and fail on any diff — additions or
   removals both require updating the pin deliberately.
2. **Denylist** the specific tokens already proven dead by name, with the
   reason recorded, so even a careless pin update that reintroduces one still
   fails with a specific, actionable message (not just "diff detected").
3. **Best-effort literal usage scan** for defense in depth, but exempt fields
   known to be dynamically dispatched by locating their *own* dispatch site
   (e.g. a `case "fieldName":` label in the planner's switch, or the string
   literal argument at a helper's call site) rather than exempting them
   blindly by name.

See `scripts/check-records-index-usage.js` (and its
`scripts/check-records-index-usage.test.mjs`, which self-modifies a copy of
the script/schema to exercise each layer) for a concrete implementation of
this pattern.
