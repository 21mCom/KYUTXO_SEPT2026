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

**Generalizing to other tables:** `database.ts` uses delta declarations — a
`this.version(N).stores({...})` block only redeclares a table if that
version changed it, so a table's live schema is whichever version block
mentions it with the *highest* N (not necessarily `CURRENT_SCHEMA_VERSION`,
and not the first occurrence in file order). Parse per-table, not per-file.

Applying the same 3-layer guard to other heavily-indexed tables surfaces a
4th situation the `records` guard didn't need: pre-existing dead indexes
nobody has cleaned up yet (unlike `records`, which was already cleaned by a
prior task before its guard was written). Do not silently pin dead tokens as
"verified used," and do not unilaterally bump the schema version to remove
them as a drive-by inside a "add a guard" task — that's a separate, riskier
migration. Instead add a third bucket per table: a `knownUnused` map (token →
audit reason) that Layer 3 skips without failing. This keeps the guard honest
(dead indexes are catalogued, not hidden) while still failing on any *new*
uncatalogued dead index. True `boolean` fields are a durable subclass of this
bucket: IndexedDB rejects booleans as keys, so `.where(bool).equals(true)`
always throws and the field can only ever be read in-memory — permanently
unindexable, not just currently unused.

**Before actually removing a `knownUnused` token** (the follow-up cleanup
task performing the schema-version-bump half of this pattern): re-verify
every catalogued token against current code, don't trust the audit
catalogue as-is. A single-line `.where('field')` grep misses real call
chains split across source lines (e.g. `db.table\n  .where(...)`); re-check
with a multiline-aware search (`rg -U`). Doing this caught one cross-table
false positive — a compound index the original audit had catalogued as dead
actually had real callers via a multi-line call chain — so one catalogued
token was kept instead of removed. Once confirmed dead, move the token from
`knownUnused` to `denylist` (with the reason preserved, tagged with the
schema version it was removed in) rather than deleting it — the denylist is
what stops it from silently reappearing later.
