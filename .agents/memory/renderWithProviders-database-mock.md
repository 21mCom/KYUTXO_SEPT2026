---
name: renderWithProviders deep-import vs database mock
description: Why fully mocking @/lib/database breaks tests that use the shared provider harness, and the fix.
---
The shared harness `renderWithProviders`/`TestProviders` (`client/src/test/testProviders.tsx`) wraps trees in `RecordPreviewProvider`, which imports `RecordDetailPanel` → `use-node-settings`/`transaction-sync`. Those modules read module-level constants from `@/lib/database` (e.g. `DEFAULT_TRUSTED_LOCAL_HOSTS`, `DEFAULT_SYNC_PROTECTION`, all re-exported from `db-types`).

**Symptom:** A test that does a wholesale `vi.mock("@/lib/database", () => ({ db: {...} }))` fails at *collection* time ("No X export is defined on the mock" / "no tests"), not at assertion time, because the harness's deep imports need those constants.

**Fix:** partial-mock with importOriginal so all real constants survive while only `db` is overridden:
```ts
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return { ...actual, db: { /* stubs */ } };
});
```
**Why:** the harness intentionally pulls the full provider stack so future UI tweaks can't crash the tree; the cost is its import graph is large. Adding constants one-by-one to a wholesale mock is whack-a-mole — prefer importOriginal.

The same rule applies to `@/lib/repository`, with one extra constraint: the repository is a class instance, so spreading it drops prototype methods such as `list`. When a provider-harness test must intercept one repository method, return a `Proxy` around the real instance, override only that property, and bind all other function properties to the real target.

**How to apply:** use this for focused page tests that need to stub one repository query while keeping `RecordPreviewProvider` and other shared providers operational.
