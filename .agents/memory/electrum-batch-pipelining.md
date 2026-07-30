---
name: Electrum batch-history pipelining
description: The batch-history IPC handler pipelines requests on the multiplexed socket with a bounded in-flight window; keep the window at the renderer's Electrum concurrency budget.
---

**Rule:** `electrum-batch-get-history` in `electron/electrum-client.cjs` pipelines its per-address history requests over the single multiplexed pooled socket (responses are id-matched, so overlap is safe) with a bounded in-flight window of 8 — deliberately the same as the renderer's `ELECTRUM_CONCURRENCY` in AddressChecker.

**Why:** Sequential batches made the batch phase dominate a 5,000-address run (~4.8 of ~7.1 min). Pipelining at window 8 cut it to ~83s (0 failures, live electrum.blockstream.info bench, 2026-07-30). A larger window was rejected because public servers throttled us after a few thousand rapid requests during earlier benchmarking; 8 is the concurrency the balance phase already used successfully. Pipelining reuses ONE socket, so it adds zero new handshakes — gentler than opening parallel connections.

**How to apply:** Don't raise the in-flight window or overlap multiple batch IPC calls (renderer stays sequential-batches) without re-benching against a live public server via `scripts/bench-address-checker-live.mjs` (PHASE/SLICE chunks fit the 5-min shell limit; configureWorkflow silently failed to persist an extra bench workflow when many workflows already exist). Watch the pooledRequest timeout path: one slow request destroys the shared socket and now cascades to up to 8 in-flight requests.
