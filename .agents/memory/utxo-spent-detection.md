---
name: UTXO spent detection is outpoint-first
description: Why spent-output detection must use input outpoints before amount-matching, and the Electrum blank-address participant-load trap.
---

**Rule:** Any unspent/spent computation must treat an input carrying `prevTxid/prevVout` as an authoritative spend of exactly that output, and use FIFO `address:amount` matching ONLY for inputs missing outpoints. Both the UTXOs page (Dexie path) and the engine heuristic CTE implement this; keep them in lockstep (the engine test file holds a `referenceHeuristic` replica of the page algorithm).

**Why:** Electrum-synced transactions store inputs with outpoints but NO prevout address/amount (blank address, 0 amount). Pure amount-matching never subtracts those spends, so totals inflate to "total received".

**How to apply:**
- Loading participants by owned ADDRESS misses Electrum inputs (blank address). Also fetch spend inputs via the Dexie `[prevTxid+prevVout]` compound index against owned output outpoints (`getSpendInputsByOutpoints`), or the spends silently vanish before the computation even runs.
- The materialized `heuristicOwnedUtxos` engine table bakes in the algorithm — any change to spent-detection semantics needs an `ENGINE_SCHEMA_VERSION` bump or stale mirrors keep serving wrong totals.
- Low outpoint coverage (legacy pre-migration rows) should surface a re-sync warning in every mode, not just Exact.
