---
name: Browser-seeding the privacy audit for real-layout checks
description: How to drive a real-browser (Playwright/runTest) privacy-audit render to test CSS layout (overflow/wrap) that jsdom can't measure.
---

For overflow/wrap checks (scrollWidth vs clientWidth) you MUST use a real browser
(runTest), because jsdom returns 0 for all layout. To make a genuine privacy
finding + Source-Citation row render in the running dev app:

- Seed via Vite dynamic imports of the live module singletons:
  `import('/src/lib/data/record-crud.ts')`, `transaction-crud.ts`,
  `privacy-entity-list.ts`. Same URL the app imported ⇒ same singleton, so
  `setActiveEntityList(...)` and Dexie writes affect the running app.
- Minimum to produce one ENTITY_* finding with a citation: add one
  `type:"address"` record (the OWNED addr), a transaction, an input participant
  (OWNED) and an output participant (ENTITY addr), then
  `setActiveEntityList([{address: ENTITY, name, category, sourceNote: "...<long url>"}])`.
  Fake/checksum-invalid bech32 strings are fine — `setActiveEntityList` does NOT
  validate (only the *import* path in entity-list-store does), and the audit
  matches addresses by string equality.

**Why (the trap that cost two runs):** the active entity list is *in-memory only*
(`_activeMap` in privacy-entity-list.ts). Any full page reload/`goto` resets it to
the bundled list, while Dexie data persists — so you'll see "Addresses:1, Txs:1"
but **no finding**. Never navigate/reload between `setActiveEntityList` and
clicking Generate.

**How to apply:** land on `/reports` first, then run ONE combined async snippet
that seeds, clicks `[data-testid="tab-privacy-report"]` (the panel is in an
unmounted Radix tab until then), clicks `button-generate-privacy-report`, polls
for `table-privacy-citations-*`, and measures. Collapsing everything into one
page.evaluate keeps the runTest subagent from timing out (multi-step interactive
plans here hit the 10-min wall).

## Legacy-migration overlay races clicks
After any unlock/reload in a real-browser check, the `legacy-migration-overlay` (z-9999, intercepts all pointer events) can appear — as transient progress or a "Complete" card with `button-dismiss-migration`. It is timing-dependent (passed locally, failed under validation load). Always wait it out / dismiss it right after unlock before clicking anything.

## Reload returns to the lock screen (and the unlock check races React mount)
A full `page.reload()` locks the vault again (key is session-only), so every reload needs a re-unlock. But at `waitUntil:'load'` React hasn't mounted yet — a plain `input-password.isVisible()` returns false and skips the unlock. Race-wait for EITHER `input-password` OR the target page's own testid, then unlock only if the lock screen actually showed.
