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
