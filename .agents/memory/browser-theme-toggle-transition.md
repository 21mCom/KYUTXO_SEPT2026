---
name: Theme-toggle computed styles in browser checks
description: Reading getComputedStyle right after toggling .dark returns mid-transition values on elements with transition-colors
---
Rule: in real-browser checks, after toggling `document.documentElement.classList` for theme, wait out CSS transitions (e.g. 600ms) before reading `getComputedStyle(...).backgroundColor` on elements with `transition-colors` (all shadcn TableRows have it).

**Why:** the immediate read returns the transition's START value (old theme color), making a correct dark: variant look like it "didn't apply". Matched-rule dumps show the right rule while computed style disagrees — that mismatch is the tell.

**How to apply:** toggle + `setTimeout` wait + read inside one `page.evaluate`; or strip transitions with an injected `* { transition: none !important }` style.
