---
name: Browser-check shared unlock helper
description: Where the shared LoginScreen/migration-overlay unlock helpers live and how the anti-duplication guard is scoped.
---

`scripts/browser-check-utils.mjs` exports `unlockIfNeeded`, `dismissMigrationOverlayIfPresent`,
and `waitForLoginScreenVisible` — the single place any real-Chromium `scripts/check-*.mjs` script
should touch the LoginScreen (`input-password`, `input-confirm-password`, `button-submit`) or
LegacyMigrationOverlay (`legacy-migration-overlay`, `button-dismiss-migration`) testids.

**Why:** ~114 check scripts used to hand-roll this fill/submit/wait/dismiss sequence inline. A
testid rename in either component would silently break every copy (opaque 30s timeout at unlock,
no hint of the real cause).

**How to apply:** `scripts/check-browser-check-unlock-guard.js` fails the build if any
`scripts/check-*.js(mjs)` file (other than `browser-check-utils.mjs` itself) contains a string
literal for one of those 4 testids. `button-submit` is deliberately NOT part of the guarded set —
it's reused by unrelated forms (e.g. `client/src/pages/Evidence.tsx`), so it can't be linted as an
unlock-only signal; `input-password`/`input-confirm-password`/the 2 overlay testids are unique
enough to lint safely. One file, `scripts/check-wrong-password-packaged.mjs`, is allowlisted in the
guard because it deliberately exercises LoginScreen's own internals (wrong-password rejection,
stuck-fill detection) rather than just getting past it. The shared `dismissMigrationOverlayIfPresent`
throws if the overlay never clears (fail loud), unlike most of the old inline copies which silently
timed out.

**Migration pitfalls confirmed by a full end-to-end run of all check-*-browser*.mjs scripts:**
- `isVisible()` (instant, no wait) and `waitForLoginScreenVisible(page, { timeoutMs: 1 })` are NOT
  equivalent. A 1ms `waitFor` almost always times out even when the element is already visible
  (CDP round-trip overhead exceeds 1ms), so any script polling "is the login screen showing right
  now, without blocking" must use a dedicated instant check (`isLoginScreenVisible(page)`, added
  alongside the other helpers), never a `waitFor` with a near-zero timeout.
- Files whose old local `unlockIfNeeded(page)` had closure access to a module-level `SETUP_PASSWORD`
  often have MULTIPLE call sites (one per page reload/re-lock point). Migrating only the first
  call site to `unlockIfNeeded(page, SETUP_PASSWORD, ...)` and leaving later ones as bare
  `unlockIfNeeded(page)` compiles fine (no TS/syntax error) but throws at runtime
  (`locator.fill: value: expected string, got undefined`) the moment that later re-lock actually
  needs to fill the password. After any such migration, grep the whole repo for
  `unlockIfNeeded(page)` with no second argument — every hit is a bug.
