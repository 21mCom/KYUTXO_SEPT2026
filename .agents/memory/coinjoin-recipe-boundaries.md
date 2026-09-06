---
name: CoinJoin recipe boundaries
description: Conservative rule for terminating deterministic coin-origin attribution at a collaborative transaction.
---

Equal-valued outputs alone must never classify a transaction as CoinJoin. Require a useful anonymity set and evidence that both controlled and unresolved inputs participate before replacing an owned output recipe with an unknown boundary.

**Why:** Ordinary payments can equal their change, and two equal payments are also common. Treating either as CoinJoin destroys otherwise exact provenance.

**How to apply:** Keep the detector deliberately conservative, add a negative ordinary-payment fixture whenever it changes, and preserve pre-mix transaction history when attribution is terminated.