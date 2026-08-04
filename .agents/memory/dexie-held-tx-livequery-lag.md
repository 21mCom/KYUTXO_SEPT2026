---
name: Deterministic liveQuery-lag via held Dexie transaction
description: How to deterministically simulate a stale useLiveQuery list vs the DB in real-browser checks (duplicate-vocabulary bug class).
---

**Rule:** To make a real-browser check where a page's `useLiveQuery` list must lag the DB (e.g. duplicate-tolerant ensure* vocabulary paths), don't race timers. Open a `db.transaction('rw', table, ...)` in `page.evaluate` that inserts the row and then holds the transaction open with `Dexie.waitFor(promise)` (get Dexie via `db.constructor`; bare `import('dexie')` fails in page.evaluate). While uncommitted: mutation events haven't fired so the hook list is guaranteed stale, and any other reader (the duplicate probe) queues behind the rw transaction. Drive the UI, click the action, then release — commit lands first, the queued read sees the duplicate.

**Why:** Sequencing "seed then synchronously click" fails: cmdk `CommandItem.onSelect` fires asynchronously, so a same-task dispatchEvent click on the submit button uses stale React state; and liveQuery refresh vs UI clicks is otherwise a coin-flip race.

**How to apply:** Any browser check needing "DB has row X but the component's snapshot list doesn't" — expose release via a `window.__release` resolver, `.catch(()=>{})` the held tx promise, and release only after the action's read has queued. Also: cmdk/MultiSelectCombobox blocks adding case-variants of existing options, so case tricks can't create UI-side duplicates.
