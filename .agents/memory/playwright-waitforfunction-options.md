---
name: Playwright waitForFunction options position
description: Passing { timeout } as the 2nd arg to page.waitForFunction silently applies the 30s default
---

`page.waitForFunction(fn, arg, options)` — options is the THIRD parameter. Calling `waitForFunction(fn, { timeout: 300_000 })` treats the object as `arg` and the wait runs with the default 30s timeout.

**Why:** a browser check with a CDP-throttled long phase timed out at 30s despite an apparent 300s timeout; the failure looked like an app hang, not a harness bug.

**How to apply:** when no `arg` is needed, pass `undefined` explicitly: `waitForFunction(fn, undefined, { timeout })`. Grep new checks for 2-arg waitForFunction calls whose second arg is an options-shaped object.
