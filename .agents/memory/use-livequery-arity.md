---
name: useLiveQuery arity
description: dexie-react-hooks useLiveQuery type signature quirk in this repo
---
The installed dexie-react-hooks typings here accept only `useLiveQuery(querier, deps?)`
— passing a 3rd "default result" argument errors with "Expected 1-2 arguments".
Also, passing an explicit generic plus `result ?? []` can collapse the inferred type
to `{}` (breaking `.map`/`.length`).

**Why:** Wasted a type-check cycle assuming the newer 3-arg signature existed.

**How to apply:** Follow the existing `client/src/hooks/use-*.ts` pattern: call with a
single querier arg and treat `undefined` as the loading/empty state
(`const x = useLiveQuery(() => db.table.toArray()); const list = x ?? [];`).
