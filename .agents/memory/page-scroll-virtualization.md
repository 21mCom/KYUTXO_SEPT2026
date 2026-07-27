---
name: Page-level scroll with tanstack virtualizer
description: Converting an inner-scroll virtualized list to whole-page scrolling (scrollMargin semantics, spacer math, verification gotchas).
---

When a virtualized list stops owning its scroll container and the page-level element scrolls instead (`getScrollElement` → page root), the virtualizer needs `scrollMargin` = the list's offset from the top of the scroll element, or the visible-row window is shifted by the height of everything above the list (only masked by overscan until filters/status cards grow).

**Semantics in this repo's @tanstack/react-virtual v3:** virtual item `start`/`end` INCLUDE scrollMargin (scroll-element coordinates); `getTotalSize()` EXCLUDES it. So table spacer rows must subtract: top spacer `items[0].start - scrollMargin`, bottom spacer `getTotalSize() - (lastItem.end - scrollMargin)`. Getting this wrong double-counts the header height as phantom list height.

**How to apply:**
- Measure margin as `listRect.top - scrollElRect.top + scrollEl.scrollTop` (NOT `offsetTop` — offsetParent is rarely the scroll container). Re-measure after every commit (content above mounts/unmounts with renders) plus a ResizeObserver on the scroll element for window/sidebar resizes; guard the setState with a ~1px threshold to avoid loops.
- Keep container padding on the scroll container only if nothing sticky needs to pin flush; shadcn `Table`'s own `overflow-auto` wrapper already neutralizes `sticky top-0` theads either way.
- Scroll-reset-on-filter-change (`scrollTo(0,0)`) now returns to the page top — desired for whole-page scroll.

**Verification gotchas (real browser):** at scroll-top the first rows may legitimately sit below the fold (title/summary/filters fill the viewport) — assert windowing (`rendered < total`), not row visibility. A single programmatic jump to `scrollHeight` lands short because dynamic row measurement shifts totals; jump twice before asserting the position stuck. jsdom suites that stub the virtualizer and pass `scrollRef={{current:null}}` keep passing — the margin effect no-ops on null.
