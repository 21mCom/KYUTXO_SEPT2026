---
name: Fund Trail layout selector persistence (browser test)
description: How to e2e-verify the Fund Trail "Layout" select persists across reload, and why the selector is hidden until you re-enter multi-hop mode.
---

The Fund Trail "Layout" Select (`data-testid="fund-trail-layout-select"`) is
rendered ONLY when multi-hop mode is active (`backwardHops > 1 || forwardHops > 1`).
Those hop depths are LOCAL React state that default to 1 and RESET on every page
reload.

**Implication for any reload/persistence browser test:** after reloading you must
re-enter multi-hop mode (set Sources depth = 2 via `fund-trail-backward-hops`, or
Destinations depth via `fund-trail-forward-hops`) before the Layout selector
reappears — otherwise it stays hidden and the assertion can't run. The selected
layout itself persists because `updateFundTrailLayout` writes
`settings.fundTrailLayout` to IndexedDB (Dexie) and `useSettings()` reads it back on
mount; default is `classic` ("Classic columns").

**Why:** confirmed end-to-end (depth=2 → pick "Sankey flow" → reload → selector
hidden until depth set back to 2 → shows "Sankey flow"). No fund-trail DATA is
needed for the selector to appear — it shows purely from multi-hop mode being on.

Layout option labels: classic="Classic columns", horizontal="Horizontal hop
timeline", vertical="Vertical timeline scroll", breakout="Full-screen breakout",
sankey="Sankey flow". A fresh browser context starts with an empty vault and may
flash the lock screen on reload (unlock again; empty vault = no password).
