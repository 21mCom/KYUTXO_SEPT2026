---
name: Browser-seeding the Transactions page (live AddressLink icon checks)
description: How to make seeded transactions/records show up on the real Transactions page in a runTest browser check, and why a one-time reload is needed.
---

When verifying live AddressLink behavior (e.g. the orange `lucide-file-text`
note icon appearing after `createRecord`) on the real Transactions page via a
`runTest` browser check, two non-obvious things bite:

1. **The default tx list/search only scans USER-CURATED transactions.** An
   unlabeled seeded transaction is invisible to both the default view AND the
   search box. To make a seeded tx surface, give its INPUT address an owned
   record (any USER_CURATED tier — `createRecord` with no `addressImportance`
   derives `manual`, which qualifies) AND set that input participant's
   `recordId` to the new record id. The OUTPUT address can stay record-less —
   that's the counterparty link you actually test.

2. **The page's `useLiveQuery` does NOT react to writes issued from
   dynamically-imported module singletons at runtime.** Even though
   `await import('/src/lib/data/...')` returns the same singletons (function
   calls + the metadata-hover cache work), the page's curated-records liveQuery
   does not re-fire for those writes, so a freshly-seeded tx never appears
   live. Confirmed by: data-layer queries return the row, but the card never
   renders.

**Working recipe:** seed (input record + tx + participants) → **reload the
page once** (navigate to /transactions again) so the page picks the curated tx
up on MOUNT → then expand and render the target link → THEN do the live
`createRecord(output)` with NO further reload. The one reload is legitimate
test setup because it happens BEFORE the target link is rendered; the actual
live-icon assertion (link rendered without icon → createRecord → icon appears)
runs with no reload/hover in between. IndexedDB persists across the reload.

**Why:** fighting the runtime reactivity wasted several runs; reloading once is
the reliable, app-honest path and doesn't weaken the "no reload at creation"
guarantee being validated.

**How to apply:** stash identifiers in `localStorage` in the seed snippet so
they survive the reload; collapse each phase into ONE `page.evaluate` snippet
(seed; then combo: poll-card → expand → assert no-icon → createRecord → poll
for icon) to minimize fragile round-trips — the heavy Transactions page tends
to drop the Playwright notebook ("Notebook not found") under many small
interactions. Note a fresh browser context starts with an EMPTY vault and may
show the lock screen after reload (unlock again).

Identifiers: card testid = `card-transaction-${txid.slice(0,8)}`; link testid =
`link-address-${address.slice(0,8)}` (addresses must differ in first 8 chars);
note-icon selector = `[data-testid="<linkId>"] svg.lucide-file-text`; expand
via `button-expand-collapse-all`.
