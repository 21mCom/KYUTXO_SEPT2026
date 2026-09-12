---
name: No automatic network access
description: Hard constraint governing KYUTXO's address-stats cache and recompute features.
---

**Rule:** Per-address stats (cachedBalanceSats, cachedTxCount,
cachedLastActivityTime, statsComputedAt) and any recompute routine must read
ONLY from local IndexedDB, or be computed during a user-initiated sync. Local-only
recompute (no network) is allowed and is the mechanism for manual refresh and
post-deletion correction.

**Why:** KYUTXO is offline-first and privacy-focused. Any background/automatic
network access would leak which addresses a user is watching. This is a hard
product constraint, not a perf choice.

**How to apply:** Never add a background fetch to populate stats. The "Not synced"
marker (statsComputedAt undefined) is correct and intended for never-synced
addresses — do not "fix" it by auto-fetching. Recompute (`recomputeAddressStats`
in `client/src/lib/data/address-stats.ts`) is local-only, batched, cancellable.
