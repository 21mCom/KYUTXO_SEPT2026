---
name: Browser-check state loss across a deliberate reload
description: Two things silently reset on a full page.goto/reload inside a browser check — the unlocked vault key and any addInitScript-injected shim's in-memory state — and both failure modes look like "the seeded row/feature never showed up" rather than an auth or storage bug.
---

Many browser checks seed data via an in-page dynamic import, then do one `page.goto`/reload so a `useLiveQuery` page picks it up (see `browser-seed-transactions-reload.md`). That reload is a full navigation, which resets two things a first-time reader won't expect:

1. **The in-memory vault unlock key.** A full navigation re-runs app init from scratch, so the password/unlock screen can reappear even though the vault was already unlocked earlier in the same script. Calling only `dismissMigrationOverlayIfPresent(page)` after the reload is not enough — call the same `unlockIfNeeded(page, password)` helper used after the first navigation, every time. Symptom when this is missed: a `getByTestId(...)` wait for content that should already exist times out after ~20s with no error, because the page is actually sitting on the (unasserted) login screen.

2. **Any `context.addInitScript(...)` shim's plain JS state** (e.g. a `Map` used to fake an Electron attachment store or similar in-memory "disk"). The init script re-executes fresh on every new document, including the reload — so anything seeded into a closure-local `Map` before the reload is gone by the time post-reload code tries to read it back. Symptom: seeding logs success, but the export/read step immediately after the reload fails with a "not found" error from the shim itself, easy to misread as an app bug. Fix: back that shim state with real per-origin browser storage that outlives navigation — a dedicated IndexedDB database (separate from the app's own Dexie DB) opened lazily inside the shim works well and requires no cross-process serialization.

**How to apply:** whenever a browser-check script does a deliberate `page.goto`/reload mid-run, immediately call the unlock helper (not just the overlay-dismiss helper) afterward, and audit any injected shim for state that needs to survive that navigation.
