---
name: Mocking window.location.reload in jsdom
description: How to capture window.location.reload() calls in vitest/jsdom component tests
---

In jsdom, `window.location.reload` is a **non-configurable data property**, so:

- `Object.defineProperty(window.location, "reload", {...})` throws "Cannot redefine property: reload".
- A `Proxy` wrapping the real Location also fails: the `get` trap **must** return the
  actual value for a non-configurable data property, so it can't substitute a spy.

**Rule:** replace `window.location` *wholesale* with a plain object that copies the
fields you need (href/origin/pathname/etc.) and swaps in `reload: vi.fn()`:

```js
const loc = window.location;
Object.defineProperty(window, "location", {
  configurable: true, writable: true,
  value: { href: loc.href, origin: loc.origin, pathname: loc.pathname, /* ...*/, reload: vi.fn() },
});
```

**Why:** any code path that calls `window.location.reload()` (e.g. the post-restore
reset-to-empty flow in SettingsPage) otherwise throws "Not implemented: navigation"
and pollutes the run, and you can't assert the reload happened.

**How to apply:** set it in `beforeEach`. vitest isolates per test file, so restoring
the original isn't strictly required, but reset it if multiple tests in one file
depend on the real location.
