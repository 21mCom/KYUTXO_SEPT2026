---
name: CRUD guard lint covers test files
description: check-crud-guards statically scans .test.ts(x) too — test setup/teardown must route through CRUD helpers or validation fails.
---

**Rule:** `scripts/check-crud-guards.js` scans ALL of `client/src`, including test files. Direct `db.<guardedTable>` reads/writes anywhere — even `beforeEach` clears or assertion reads — fail the gate. Use the table's CRUD module for seeds, clears, and reads in tests; add a helper to the CRUD module if one is missing.

**Why:** New-table tests that clear via `db.table.clear()` fail validation even though runtime behavior is fine; unguarded tables (e.g. dustFlags) make it look like direct test access is allowed when it isn't.

**How to apply:** When adding a table to `GUARDED_TABLES`, write its tests using only that CRUD module's functions (`createRecord`, `clearAllRecords`, `clearParticipants`, the table's own clear/list).

**Comments count too:** the guard is textual — even a code comment containing `db.<guardedTable>` in a test file fails check-crud-guards. Reword comments to describe the table instead of quoting the expression.

**Publish gate:** the deployment build (`npm run build`) runs check-crud-guards first, so a merged test file with direct guarded-table writes fails PUBLISHING, not just dev validation. Scale/equivalence tests that must seed the raw Dexie surface (100k-row export benchmarks, etc.) belong in ALWAYS_ALLOWED_FILES in scripts/check-crud-guards.js — precedent: bip329-export.test.ts and its CSV twin. Rewriting such seeds through bulkCreateRecords changes semantics (canonicalization, vocab sync) and slows the bench, so allowlist instead.
