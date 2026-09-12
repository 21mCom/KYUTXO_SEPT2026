---
name: Vitest + fake-indexeddb pattern
description: How to unit-test KYUTXO's Dexie CRUD/query modules against a real (faked) IndexedDB.
---

To test code that imports the singleton `db` from `@/lib/database`:

1. `import "fake-indexeddb/auto";` at the top.
2. Build a `TestDb extends Dexie` mirroring the production schema for just the
   tables under test.
3. `vi.mock("@/lib/database", async () => ({ ...(await vi.importActual(...)), db: testDb }))`.
   The `@/` alias unifies relative and aliased imports so CRUD modules that do
   `import { db } from '../database'` hit the same mocked binding.
4. Import the modules under test AFTER the mock (top-level `await import(...)`).

**Gotcha:** you cannot put `type X` inside dynamic-import destructuring
(`const { fn, type X } = await import(...)` is a parse error under oxc). Import
types with a separate top-level `import type { X } from "./mod"`.

Precedent file: `client/src/lib/data/record-crud.keyset.test.ts`.
`tsc` is NOT a registered validation here (there are many pre-existing tsc
errors); tests run via `vitest run`. Registered validations are `crud-guards`
and `lockfile-urls`.
