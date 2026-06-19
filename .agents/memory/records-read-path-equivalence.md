---
name: Records engine-vs-Dexie read equivalence
description: Parity constraints when testing the Records screen native-engine read path against the Dexie path.
---

# Records read-path equivalence (engine-core vs Dexie)

The Records screen serves the same query from two interchangeable read paths and
reconciles them so the user sees identical results: page rows+order, visible
total, navigable count, and the hidden blockchain-discovered badge. When writing
equivalence tests that seed one dataset into both engine-core (better-sqlite3)
and Dexie (fake-indexeddb), these parity constraints must hold or the paths
diverge for reasons unrelated to a real bug:

- **Every fixture row must carry one of the six known importance tiers (never
  null).** The engine excludes via `addressImportance NOT IN
  ('blockchain-discovered','pending-review')` (NULL also passes), while the Dexie
  default-exclude page path merges `anyOf(USER_CURATED_TIERS)`
  (verified/manual/wallet-import/xpub-derived). They are only equal when no row
  has a null/unknown tier.
- **Pagination shapes differ but id windows must match.** Engine + record-crud
  default/type paths use keyset (`beforeId` / `beforeIdExclusive`); the substring
  path (`records-query.fetchRecordsPage`) uses offset. All emit id-descending
  rows, so compare by id arrays, not by fetch mechanism. For page 2 of a search,
  drive the engine with the keyset boundary from page 1 and the Dexie search with
  `pgOffset = PAGE_SIZE`.
- **`singleTypeFilter` only fires when there is no search.** Type-filter + search
  goes through the substring/`buildRecordsCollection` branch (type as the primary
  column-filter narrowing), not the dedicated type branch.
- **Counts source of truth:** visible total = `countRecords(opts)` (engine) /
  `countRecords()-countBlockchainDiscovered()` or `countRecordsByType…` (Dexie);
  hidden badge = all-minus-nonDiscovered (engine) / `countBlockchainDiscovered()`
  (Dexie). For substring, navigable = `page.effectiveTotal`.

**Why:** these are the exact reconciliation rules in `Records.tsx`; a faithful
equivalence test must replicate them rather than assume the two engines share a
code path.

**How to apply:** see
`client/src/lib/engine/__tests__/records-read-equivalence.test.ts` for the
working replica of both paths.
