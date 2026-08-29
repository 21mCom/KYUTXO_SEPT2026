---
name: Filter chips / Clear-All browser-check gotchas
description: Sidebar nav collapsibility and debounce timing pitfalls hit when writing a real-browser check for filter-chip/clear-all controls.
---

The sidebar (`client/src/components/AppSidebar.tsx`) groups nav links under per-section `Collapsible`s; only a few groups (`defaultOpen: true`, e.g. "Overview"/"Data") render their links without a click. A browser check that does `page.getByTestId('link-<page>').click()` straight away will time out for pages in a collapsed group (e.g. "Analysis" holds Address Reuse, "Documents" holds Evidence). Fix: check `link.isVisible()` first, and only if false click the group header `group-${groupId}` (never click unconditionally — it toggles an already-open section closed).

A page whose `hasActiveFilters` is derived from a **debounced** search term (e.g. Evidence, 300ms) can still show its "Clear all filters" button/chip for up to one debounce window after you click Clear and the raw state is already reset — the debounced value hasn't caught up yet. Assert via `locator.waitFor({ state: 'hidden' })` after the click, not an immediate synchronous count check, or the assertion flakes as a false failure.
