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
