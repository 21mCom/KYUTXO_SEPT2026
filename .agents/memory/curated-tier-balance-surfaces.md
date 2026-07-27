---
name: Curated-tier balance surfaces
description: Any balance/ownership aggregation over cached address stats must allowlist user-curated importance tiers; discovered counterparty rows look like owned funds.
---

**Rule:** Every surface that aggregates cached per-address stats (`cachedBalanceSats`, `cachedUtxoCount`) into "the user's funds" must filter to user-curated importance tiers (`isUserCuratedImportance` in `db-types`; missing tier = legacy = curated). Non-curated = `blockchain-discovered`, `pending-review`.

**Why:** Sync auto-creates records for counterparty addresses (`blockchain-discovered`) that INHERIT the parent's `walletName`/`seedName` and get stats stamped by the same recompute pass. Their local history is one-sided (only txs touching user addresses are stored), so their "balance" equals sats-seen-received — the user's own outgoing payments show up as someone else's balance inside the user's own wallet groups. This shipped as a real bug on the Balance page (totals inflated, UTXO counts "not matching reality").

**How to apply:**
- New aggregation/readout of cached stats → tier-filter by default; if "include discovered" is a legitimate view, make it an explicit opt-in toggle with a warning badge, and route it through the Dexie path (engine mirror serves only the curated view).
- SQL predicates must be **allowlist** (`IN (curated…)` or NULL), never denylist (`NOT IN (discovered…)`) — otherwise an unknown/future tier diverges between the Dexie helper (allowlist) and engine SQL.
- Tier-skip must run BEFORE any needs-backfill probing, and the engine's stale-count query needs the same predicate, or discovered-only stale rows force the page off the engine fast path.
- `recomputeAllAddressStats` intentionally stamps ALL records (per-record caches are used elsewhere) — filter at read/aggregation time, not at stamp time.

**Import gotcha:** page code should import pure helpers/consts from `@/lib/db-types`, NOT `@/lib/database` — the latter instantiates Dexie at module load and drags IndexedDB errors into every jsdom test that doesn't mock it.
