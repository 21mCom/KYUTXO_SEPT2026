---
name: Fund Trail layout variants
description: Rules for the alternate /fund-trail multi-hop layouts (horizontal/vertical/breakout/sankey) graduated from canvas mockups onto live engine data.
---

The /fund-trail page can render multi-hop results in several interchangeable
layouts. Option 1 is the original `MultiHopTrailLayout` (keep untouched); the
others are pure presentational components fed by ONE adapter.

**Rules (all enforced by the original architect review; breaking them is a
correctness regression, not a style nit):**

- Caps are **hop-level** (per `depth` + `direction`, from the engine's
  `caps[]` / `capForHop`), never per-node. Do NOT render "this node is capped"
  anywhere — not even inside a selected-node detail panel. Surface caps via the
  hop-level `HopCapNotice` (overlay/banner) or `ColumnCapBanner` (per-column).
  **Why:** the engine caps transactions per hop, so attributing a cap to one
  node (or implying a specific capped parent) is a lie about the data.

- Variants are **pure functions of `buildFundTrailViewData(result, centerLabel,
  dimension)`** (`view-data.ts`). No DB access, no writes (CRUD-guard safe), and
  **no live DOM measurement** — all SVG geometry is derived from deterministic
  computed coordinates.

- No `behind`/fabricated parent pointers for deep hops. hop-1 connects precisely
  to the center; deeper hops connect to an **aggregate previous-depth rail/band**.

- Stacked / Sankey layouts must scale from the **densest stacked column sum**
  (sum of node sats in the busiest depth, plus a reserve for inter-node gaps),
  NOT the max single flow / center total. **Why:** within a depth the bars stack,
  so a crowded column is the binding constraint — scaling off one big flow lets
  crowded columns overflow and clip out of a fixed-height viewBox.

- Generalized to up to `MAX_HOP_DEPTH` (5) hops per side; never hardcode 2 hops
  or any sample label/amount/txid (those came from the mockups).

- Page body must avoid `h-screen`/`min-h-screen`; use `h-full` + `min-h-0` +
  `flex-1` + local `overflow-auto` so it lives inside the app shell.

**Testing the variants:** the four alternate variants share the adapter's
synthesized node ids, so assert presence by id (not label text — labels repeat).
Two non-obvious gotchas worth remembering: (1) cap surfacing is NOT uniform —
the horizontal column layout shows a per-column banner while the other three use
an overlay notice, so any cap assertion must accept either testid. (2) Classic
is rendered directly by `FundTrail.tsx` (not via the variant component), so the
ONLY place all five layouts share one selector + one engine result is a
page-level test that drives the real Layout selector; component tests can cover
the four variants but never Classic.
