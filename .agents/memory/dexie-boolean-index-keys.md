---
name: Dexie boolean index keys
description: Booleans are not valid IndexedDB keys; where(field).equals(true) throws DataError at query time and UIs show stale values.
---

Booleans are NOT valid IndexedDB keys. Any Dexie `where('boolField').equals(true)` (even cast via `as unknown as IndexableType`) throws `DataError` at query time — often swallowed upstream, so the UI silently keeps the previous value instead of erroring.

**Why:** The OP_RETURN all-tiers count on the Transactions Dexie fallback used an indexed equals(true) on `hasOpReturn` (stored as boolean) and just kept the stale prior total; only an engine-vs-Dexie parity browser check exposed it.

Second failure mode: `where('boolField').equals(1)` does NOT throw — it silently matches ZERO rows (boolean values never equal number keys), e.g. the custody-segment origin scan found no origins for its whole life.

`scripts/check-boolean-where.js` (validation-gated) auto-derives indexed boolean fields (db-types booleans ∩ schema index tokens, minus a homonym allowlist for same-named string columns) and fails on any non-test `.where('<boolField>')`.

**How to apply:** For boolean-flagged rows, use `.filter(row => row.flag === true)` scans (count/primaryKeys), or store 0/1 if an index is truly needed. When adding parity checks, a total that "doesn't change" after toggling a filter may be a swallowed DataError, not a timing issue.
