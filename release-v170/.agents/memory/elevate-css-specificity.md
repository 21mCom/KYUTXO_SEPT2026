---
name: Elevate CSS vs positioning utilities
description: Why the elevate position rule is wrapped in :where(); how to add similar base rules safely.
---

The `.hover-elevate`/`.active-elevate*` base rule in `client/src/index.css` sets `position: relative; z-index: 0` and is wrapped in `:where(...)` so it has ZERO specificity.

**Why:** the original two-class selector (`.hover-elevate:not(...)`) out-specified Tailwind's single-class `.absolute`, so every Button/Badge (which bake in elevate classes) silently computed `position: relative` when given `absolute` — the SearchBar clear X rendered outside the input, badges/carousel arrows lost corner positioning.

**How to apply:** any base rule attached to utility classes that sets properties Tailwind utilities also set must stay at 0 specificity (`:where()`), or utilities silently lose. The elevate `::after` overlay only needs *some* positioning context — `absolute`/`fixed` are fine, only `static` breaks it. Geometry regressions of this class are invisible to jsdom; verify in a real browser (`scripts/check-searchbar-clear-browser.mjs`).
