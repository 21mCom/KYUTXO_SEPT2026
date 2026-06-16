---
name: Scale-testing guards
description: How KYUTXO proves Dexie/IndexedDB reads stay bounded at scale, and the non-obvious Dexie 4.x instrumentation gotcha.
---

KYUTXO repeatedly "fixed" scale on a tiny dev DB and then froze on the real
vault (~100k records / ~10M tx / ~20M participants). The durable fix is a
*provable* foundation, not a one-off patch. Two complementary guards exist:

## Runtime guard (behavioural)
`scale-guards.runtime.test.ts` wraps Dexie's `toArray` to count rows
materialized into JS, then asserts paginated/indexed/count helpers pull O(page)
not O(N), with a `getAllTransactions` negative control that deliberately loads
everything (proves the instrument can tell bounded from unbounded).

**Gotcha (Dexie 4.x):** `Table`/`Collection` are NOT statically importable
classes to patch. Get the prototypes from *instances*:
`Object.getPrototypeOf(db.someTable)` and
`Object.getPrototypeOf(db.someTable.toCollection())`, then override `.toArray`.
Patch AFTER seeding so bulk inserts don't pollute the counter; restore in
afterAll. Scope is limited to `toArray` — it will NOT catch other expensive
paths (`primaryKeys()`, `each()`, `sortBy()`, cursor scans that return a small
final array). Add those if a helper uses them.

## Static guard (ratchet)
`scale-guards.static.test.ts` greps client source for unbounded patterns
(`getAll*()` call-sites + `db.<bigTable>.toArray()/.toCollection()`) outside the
CRUD definition modules and fails if the count exceeds a BASELINE.
**Why:** stops new full-table loads creeping back in.
**How to apply:** the count may only go DOWN — after removing an offender, lower
BASELINE to lock the win. Limitation: it's count-based, so removing one offender
while adding another can mask a regression; it's a foundation, not a full
analyzer.

## Migration-path harness (one-time upgraders)
`legacy-migration.test.ts` proves the genuine Dexie schema upgraders run on an
old vault. Dexie `.upgrade()` callbacks fire ONCE when the on-disk version is
older than the declared version, so you cannot test them against an
already-current DB or by mocking `@/lib/database`.
**How to apply:** seed a raw `new Dexie(name)` declaring ONLY the OLD
`.version(N).stores({...})` (e.g. v29 records schema lacking `inputStringLower`),
bulkAdd legacy rows, close it; then open `new KYUTXODatabase()` (same DB name) so
the real chain upgrades N->current. Assert both the data backfill AND that the
newly-added index is usable (`.where(idx).equals(...)`), not just the field.
Reuse `buildLegacyRecordRows`/`buildLegacyAttachmentRows` from `testSeedData.ts`
so seed shape == runtime-fixture shape. Runtime repair passes (on every unlock)
are a SEPARATE mechanism from these one-time upgraders.

## Generator constraint
The large-scale generator (`largeScaleSeed.ts`) must write ONLY through CRUD
modules (records/tx/participant/attachment CRUD) to satisfy `crud-guards`. The
ONE allow-listed exception is `testSeedData.ts`, which direct-writes the legacy
pre-migration shape (records WITHOUT `inputStringLower`; attachments at a
single-segment root path) precisely because the CRUD layer always normalises and
therefore can't reproduce the old shape. Batch-size inputs are clamped to >=1 or
the `s += batch` loops hang forever.
