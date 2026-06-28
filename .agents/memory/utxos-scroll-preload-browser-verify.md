---
name: UTXOs note-icon scroll verification
description: Durable lessons for proving the orange note (FileText) indicator appears on scrolled-in UTXOs rows via the no-hover preload pipeline.
---

The orange note icon (`svg.lucide-file-text.text-orange-500`) on AddressLink/TxidLink lights up two independent ways: a HOVER/focus tooltip resolve, and the scroll-driven `batchPreloadIdentifiers` pipeline. A test that only fires `fireEvent.focus(link)` proves the hover path, NOT the scroll path — they are separate code paths and must be covered separately.

**Why:** users rely on icons appearing as rows scroll into view without any interaction; a regression in the page-level visible-range preload effect would be invisible to a focus-based test.

**How to assert the scroll path in jsdom (committed test, no real browser needed):**
- jsdom has no layout, so a real `useVirtualizer` yields zero rows — stub `@tanstack/react-virtual` and own the visible window, then a rerender with a new window IS the "scroll" (rows enter/leave the DOM like the real virtualizer).
- Keep the real metadata-hover cache + real AddressLink/TxidLink; stub ONLY the DB seam `getRecordsByInputStrings` (the single query `batchPreloadIdentifiers` fans out to) to return a record whose `inputString === id` and whose label≠"Unlabeled" (so `hasHoverMetadata` is true).
- Fire NO focus/pointer events; assert the icon appears purely after the window change.
- The returned record is cached by `inputString.toLowerCase()`; AddressLink subscribes by the row's address/txid — they must match.

**Cross-cutting gotchas (apply to both jsdom and real-browser checks):**
- Link/row testids are `…-${identifier.slice(0,8)}`, so seeded addresses AND txids must differ in their FIRST 8 chars or many rows collide on one testid (same family as the force-graph slice(0,8) collision).
- Seeded `Record` rows need `tags:[]`/`categories:[]` — RecordTable does `record.tags.slice(...)` unguarded and crashes on undefined.

**Real-browser confirmation (testing skill runTest), additional gotchas:**
- Navigate by clicking the sidebar link, NEVER reload/goto — vault auth is in-memory React state and a reload returns to the lock screen (Dexie data persists regardless).
- Don't assume seed index order == visual order (the list has a default sort and may not start at the top): snapshot the rendered row testids at scroll-top, then scroll to bottom and assert a row absent from the top snapshot now renders WITH the icon. Sort-agnostic.
- Native SQLite engine is unavailable in a browser → `evaluateEngineFreshness` returns `unavailable` → Dexie read path.
