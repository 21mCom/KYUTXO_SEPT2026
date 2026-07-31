---
name: CRUD guard lint covers test files
description: check-crud-guards statically scans .test.ts(x) too — test setup/teardown must route through CRUD helpers or validation fails.
---

**Rule:** `scripts/check-crud-guards.js` scans ALL of `client/src`, including test files. Direct `db.<guardedTable>` reads/writes anywhere — even `beforeEach` clears or assertion reads — fail the gate. Use the table's CRUD module for seeds, clears, and reads in tests; add a helper to the CRUD module if one is missing.

**Why:** New-table tests that clear via `db.table.clear()` fail validation even though runtime behavior is fine; unguarded tables (e.g. dustFlags) make it look like direct test access is allowed when it isn't.

**How to apply:** When adding a table to `GUARDED_TABLES`, write its tests using only that CRUD module's functions (`createRecord`, `clearAllRecords`, `clearParticipants`, the table's own clear/list).

**Comments count too:** the guard is textual — even a code comment containing `db.<guardedTable>` in a test file fails check-crud-guards. Reword comments to describe the table instead of quoting the expression.
