---
name: FundTrail Classic multi-hop scroll verify
description: How to real-browser verify the Classic Fund Trail layout scrolls each column inside its pane (not whole-page), incl. seeding a >1-hop trail both directions.
---

To browser-verify the Classic (`fundTrailLayout==="classic"`) multi-hop layout's
per-column scrolling, you must produce a REAL engine result with many cards and
>1 hop on BOTH sides. Stubbing the engine is not possible in a real browser
(ESM live bindings can't be reassigned from page.evaluate); seed actual Dexie data.

**Seed shape (fast, ~40 txns — no chunking needed, unlike the cancel-e2e seed):**
- Grouping dimension defaults to `walletName`. Each distinct known `walletName`
  becomes its OWN hop card; all addresses with no `records` row collapse into a
  single "Unknown" bucket per hop.
- Many hop-1 cards: N distinct known wallets each in their own tx
  (input=wallet addr, output=center) for sources, and (input=center, output=wallet
  addr) for destinations. ~20 each gives a long scrolling column at 720px height.
- Deeper hops only appear by descending through an UNKNOWN intermediary: tx
  (input=unknownAddr, output=center) creates the unknown bucket, then tx
  (input=deepKnownAddr, output=unknownAddr) surfaces a hop-2 known card. Mirror for
  dest. This is the only way to satisfy ">1 source hop AND >1 dest hop".
- Name the center wallet "AAA …" so it sorts to the top of `listGroupValues`
  (the Radix group dropdown), making it easy for the test agent to pick.

**Flow:** create vault → seed via `import('/src/lib/database.ts').db` bulkAdd →
RELOAD + re-unlock (group dropdown is a cached query; reload re-reads it) →
/fund-trail → pick center group → backward=2, forward=2.

**Assert (page.evaluate measurement, not pixels):** root uses overflow-hidden so
`document.documentElement.scrollHeight - clientHeight <= 2` (no whole-page scroll);
exactly 2 inner scroll columns found (walk up from `fund-trail-hop-card-*` to the
first `overflow-y:auto/scroll` parent); each has overflowY auto + scrollHeight >
clientHeight + scrollTop moves; and scrolling a column to the bottom does NOT
reintroduce page overflow. Re-run with sidebar collapsed (`button-sidebar-toggle`).
Confirmed passing both states.

**jsdom complement, NOT a substitute:** the named break vectors
(min-h-0 / flex-1 / overflow-y-auto dropped, h-screen reintroduced) are all
structural CSS-class changes, so a class-assertion render test (walk hop-card →
nearest overflow-y scroll ancestor; expect exactly 2 columns each carrying those
classes; assert no h-screen in the trail body) catches them in CI without pixels.
Worth having as a fast tripwire, but jsdom computes NO layout — it cannot prove
the page itself doesn't scroll or that a column actually overflows-then-scrolls.
The browser recipe above stays the source of truth for real overflow and is the
deliverable when a task asks to *measure* it; pair the two, don't swap one for
the other.
