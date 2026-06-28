---
name: AddressLink note icon is cache-driven, refreshes only on re-resolve
description: How the orange FileText indicator on AddressLink/TxidLink actually updates, and how to test the 5-minute TTL refresh at the component level.
---

# AddressLink note icon: cache-driven + TTL refresh

The orange FileText indicator on AddressLink/TxidLink is driven SOLELY by the
metadata-hover cache via the `tooltipRecord` state (seeded from `getCachedRecord`
+ kept in sync by a lifetime `subscribeCacheEntry`). A `recordId` prop does NOT
drive the icon — it only affects click navigation and (on the Transactions page)
the separate linked-record Badge. So even where a page passes `recordId`, the
icon still comes from the cache subscription.

**The component never auto-refreshes after the TTL on its own.** `CACHE_TTL_MS`
(5 min) only makes `getCachedRecord` DROP an expired entry on the next read; it
does not notify anyone. The icon updates only when a *later* re-resolve fires
`notifySubscribers` — i.e. a hover (`handleTooltipOpen` -> `resolveIdentifier`)
or a page's visible-range `batchPreloadIdentifiers` (scroll). Within the TTL a
re-preload is a cache hit and is intentionally skipped, so a stale icon is kept
until the window elapses. **Why:** this is the whole point of the TTL — it's the
safety net for changes that bypassed `invalidateCachedRecord` (imports, other
tabs).

**How to test the TTL refresh at the component level (jsdom, deterministic):**
render the real AddressLink under a bare `TooltipProvider` (mock
RecordPreviewContext/settings/clipboard/toast), mock ONLY the DB seam
`getRecordsByInputStrings`, use `vi.useFakeTimers()` + `vi.setSystemTime(...)` to
cross `5*60*1000`, swap the mock's return shape (with vs without
`hasHoverMetadata` content) WITHOUT calling `invalidateCachedRecord`, then fire
`batchPreloadIdentifiers([addr])` again and assert `svg.lucide-file-text`
appears/disappears. Avoid `waitFor` under fake timers (it polls fake-able timers
and hangs) — flush microtasks inside `act` instead. Allow-list the file in
`scripts/check-test-providers.js`. See `ttl-refresh-indicator.test.tsx` /
`preload-indicator.test.tsx`.
