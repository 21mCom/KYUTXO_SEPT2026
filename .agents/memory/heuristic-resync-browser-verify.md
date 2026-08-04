---
name: Browser-verifying Balance heuristic per-address Re-sync
description: How to e2e-test the Balance page heuristic-banner per-address/bulk Re-sync against the real provider, and why real on-chain addresses are required.
---

To make the heuristic banner appear and have a single Re-sync actually PROMOTE
an address (drop it from the list + decrement the count), you cannot use fake
addresses: promotion only happens when the real provider sync adds an INPUT
participant carrying prevout (prevTxid/prevVout) for that address. So seed with
REAL mainnet addresses that have a genuine on-chain SPEND (spent_txo_count>=1),
configure a real provider (putNodeSettings providerType 'mempool-space'), and let
the actual syncSingleAddress path run (network is reachable in this env).

Make an address "heuristic": give it a record + one input participant with NO
prevTxid/prevVout. `buildHasPrevoutByAddress` OR's per address, so after re-sync
the new real input (with prevout) flips it to non-heuristic even though the
seeded no-prevout row remains.

Find suitable real addresses: walk a recent block's tx vins, take prevout
scriptpubkey_address, keep ones with small chain_stats.tx_count and spent>=1.
For a "live counter ticked" assertion, require tx_count >= ~12: tiny histories
(3-4 txs) fetch inside a single poll tick, yielding only one counter sample.
Use addresses differing in their full string (row/button testids embed the full
address).

In-flight lockout wiring: "Re-sync all" (button-resync-heuristic) is disabled
while `resyncingHeuristicAddresses.size > 0` (a single run); per-address buttons
are disabled while `resyncingHeuristic` (the bulk run, which swaps the bulk
button for button-cancel-resync-heuristic Stop). The in-flight assertion is
timing-racy against network latency — assert it immediately after the click and
treat a too-fast completion as a note, not a failure.

Seed via Vite singleton dynamic imports (same-origin = same singletons), then
navigate to /balance AFTER seeding so the mount-time count read sees the data
(the page's count effect re-reads on dbSignal, not on dynamic-import writes).
Fresh Playwright context = empty vault = "Create Vault" screen first
(input-password / input-confirm-password / button-submit).

## Live tx-counter assertion
The per-address "X/Y transactions fetched" counter reuses SyncProgress
transactionsNew/transactionsFound; later phases (prevout-resolve) overwrite
them with a DIFFERENT total (e.g. "4/4" then "3/3"). When asserting the
counter ticks, install a MutationObserver before clicking and scope the
monotonic check to the leading run of samples sharing the first observed
total. Pick a real address with 3-60 txs (block-vin walk) so the counter has
several distinct values but the fetch stays fast.

**Known flake (2026-07):** the live tx-counter assertion (>=2 distinct samples) fails deterministically when the picked real address has few txs (e.g. 4) — the fetch completes within one render so only one "4/4" sample is captured. Unrelated tasks blocked on this used an audited validation skip; a real fix is to pick an address with more txs or throttle the provider fetch during the check.

## Virtualized heuristic list at scale (2026-08)
The detail list only reads input-role participants, so thousands of heuristic
rows can be seeded as display-only participants (bulkAddParticipants, fake
bc1q… strings, no records/tx rows) — only an address you'll actually Re-sync
needs to be a VALID address with a record (syncSingleAddress validates format
and requires a record). Mock the provider deterministically with
context.route('https://mempool.space/**') (tip/height, /address info, /txs →
[]) and prove per-row targeting from the intercepted /address/<addr> URLs —
don't assert the "exact matching" toast (wording under change, and a 0-tx mock
sync never promotes). Virtualizer rows are measured lazily, so a precomputed
scrollHeight bottom undershoots; converge with a loop re-setting
scrollTop=scrollHeight until stable. List order = participant insertion order,
so seed the target address last to force real scrolling.
