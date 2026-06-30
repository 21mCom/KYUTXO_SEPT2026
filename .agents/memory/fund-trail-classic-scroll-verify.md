---
name: FundTrail Classic multi-hop scroll verify
description: How to real-browser verify the Classic Fund Trail layout (inline + full-screen) scrolls inside its pane (not whole-page), incl. seeding a >1-hop trail both directions and checking all five full-screen layouts.
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

## Full-screen overlay (all five layouts) — measured no-whole-page-scroll

The page has a SEPARATE full-screen branch (`isFullScreen` overlay, testid
`fund-trail-fullscreen`, `FundTrail.tsx` ~line 1682) that re-wraps the same
layouts in DIFFERENT containers than the inline `fund-trail-body`. The jsdom
guard `FundTrail.fullScreenScroll.test.tsx` only checks CSS *class structure*; it
cannot MEASURE pixels, so a class-preserving overflow regression (intrinsic-height
child, min-width blowout, flex edge case) would pass it yet still scroll the whole
page. This recipe is the pixel-truth complement and is the deliverable when a task
asks to *measure* full-screen overflow.

**Seed (one fast `page.evaluate`, ~96 txns — no chunking needed):** same shape as
the inline recipe above. Center wallet `walletName: "AAA Treasury"` (sorts to top
of the group dropdown). ~24 known src wallets (input=src,output=center) + ~24 known
dst wallets (input=center,output=dst) for long hop-1 columns, plus a backward
unknown intermediary (`input=unkBack,output=center`) feeding ~6 `Deep Src N`
(`input=deepSrc,output=unkBack`) and a forward unknown intermediary
(`input=center,output=unkFwd`) feeding ~6 `Deep Dst N` to satisfy >1 hop BOTH
sides. Tables cleared + bulkAdded directly via `import('/src/lib/database.ts').db`:
`records {type:'address',inputString,inputStringLower,walletName,createdAt}`,
`blockchainTransactions {txid,blockTime,blockHeight}`,
`transactionParticipants {txid,address,role:'input'|'output',amount,vout}`.
Dexie schemas only declare indexes, so extra/missing non-index fields are fine and
direct bulkAdd bypasses address-validation (arbitrary `bc1q…`-ish strings work).

**Flow:** new context (fresh IndexedDB → "Create a password") → create vault
(`input-password`+`input-confirm-password`+`button-submit`) → seed → RELOAD +
re-unlock (group dropdown is a cached react-query; reload re-reads `listGroupValues`)
→ /fund-trail → pick "AAA Treasury" (`fund-trail-group-select`) → backward=2,
forward=2 → click `fund-trail-expand` → wait for `fund-trail-fullscreen`.

**Switch layouts WITHOUT leaving full-screen:** the overlay binds window keydown
1–5 (1 Classic, 2 Horizontal, 3 Vertical, 4 Breakout, 5 Sankey) — press the digit
key (focus must NOT be in an input), or use `fund-trail-fullscreen-layout-select`.

**Assert per layout (`page.evaluate`, real measurement):** with the overlay as the
root, `document.documentElement.scrollHeight - clientHeight <= 2` AND
`document.body.scrollHeight - clientHeight <= 2` (no whole-page scroll);
`querySelectorAll('[class*=h-screen]').length === 0` inside the overlay; Classic has
`fund-trail-hop-card-*` > 0, the four variants have `ft-node-*` > 0 (Sankey reports
ft-nodes but 0 hop-cards — expected). Stress check: scroll an inner pane to the
bottom, re-measure, page delta must STILL be <= 2. Confirmed passing all five at
1280×720 (every doc/body delta = 0).
