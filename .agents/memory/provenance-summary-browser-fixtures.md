---
name: Provenance summary browser fixtures
description: How to preserve classification coverage while testing filtered UTXO provenance summaries.
---

Use an active date filter when a UTXO Provenance browser check must exercise live summary changes across history, partial-spend, and wallet-reorg classifications. A wallet filter changes the owned-address universe used by provenance tracing, so cross-wallet hops can legitimately lose classifications under that scope.

**Why:** A fixture that showed partial-spend and wallet-reorg classifications in the all-wallet view produced only history counts after narrowing to one wallet. The live dust behavior was correct; the test scope changed the classification semantics.

**How to apply:** Keep all wallet records in the trace and activate a date range for the required “filtered view” coverage. Choose flagged outputs whose combined removal changes every summary metric the regression check intends to protect.