---
name: CRUD guard layer (typed data access)
description: How the guarded-table CRUD layer works and the typing pitfall when migrating direct Dexie reads to typed helpers.
---

# Guarded-table CRUD layer

Write AND read access to guarded Dexie tables must go through dedicated CRUD modules in `client/src/lib/data/` (re-exported via `dataFacade.ts`). `scripts/check-crud-guards.js` flags BOTH direct reads and writes of `db.<table>` outside the CRUD layer; it runs as a workflow/validation step (`crud-guards`) and a pre-commit hook. Migrations in `database.ts` using `tx.table(...)` are exempt. Non-guarded tables (tags, categories, owners, walletNames, seedNames, walletSoftware) may still be read via `db.X` directly.

## Typing pitfall when migrating direct Dexie reads → typed helpers
**Rule:** Dexie's `.where().anyOf()/.between()/.equals()` accept loose types, so direct callers often passed arrays inferred as `string[]` or `DbRecord['addressImportance'][]` (= `AddressImportance | undefined` when the field is optional). The typed helpers take strict params (e.g. `AddressImportance[]`), so migration surfaces new TS errors.

**How to apply:** When swapping a direct `db.records.where('[type+addressImportance]').anyOf(tiers...)` for a typed helper, ensure the local tier constant is annotated `AddressImportance[]` (not bare array literal → `string[]`, not `DbRecord['addressImportance'][]` → includes `undefined`). Import the `AddressImportance` type where needed.

**Note:** `hasOpReturn` boolean index queries need `.equals(true as unknown as IndexableType)` (import `type { IndexableType } from 'dexie'`) — boolean isn't a valid `IndexableType`, and `IDBValidKey` is the wrong cast.
