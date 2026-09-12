---
name: Dexie .or() requires an index
description: Dexie WhereClause .or('field') throws SchemaError when field is unindexed; catch-and-empty fallbacks hide it as a console-only error.
---

Dexie's `.where(a).equals(x).or(b).equals(y)` requires **both** `a` and `b` to be indexed in the table's `stores()` declaration. An unindexed `.or()` field throws a SchemaError at query time — not at schema definition — so it only surfaces when the code path runs.

**Why:** the attachments table indexed only `recordId`, so every detail-panel open threw and a catch block silently set an empty attachment list (console-only DexieError).

**How to apply:** when adding an `.or()`/`.where()` field to a query, check the table's index list in the Dexie version declarations first; add a new delta schema version if missing. Also treat any `catch { setX([]) }` fallback as a smell — surface the failure to the user.
