---
name: Windowed scratch-store list pending-window race
description: Virtualized lists reading IndexedDB windows can stick on "Loading…" forever if effect cleanup leaves cancelled loads in the pending set.
---

The scratch-store windowed-list pattern (rows cached by absolute index, 100-row windows fetched on scroll, pending-set dedup) has a race: when the visible range changes while a window load is in flight, the effect cleanup marks the load cancelled, but the window stays in `pendingRef` until the loader's `finally` — so the effect's next run skips that window, the cancelled loader never bumps the cache version, and fetched rows never render (stuck "Loading…").

**Why:** hit for real in the Dormant Coins remount test — summary rendered but rows never appeared; same latent bug exists in any copy of the pattern.

**How to apply:** in the effect cleanup, delete the windows from the pending set IMMEDIATELY (not just in the loader's `finally`), and have the loader check its cancelled flag per window before each fetch. Reference: `useWindowedRows` in `client/src/pages/dormant-coins/dormant-results-list.tsx`. `StaleAddressList` in DatabaseDoctor still has the old pattern.
