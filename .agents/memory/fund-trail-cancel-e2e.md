---
name: FundTrail multi-hop cancel e2e
description: How to real-browser verify the FundTrail "trace stopped early" cancelled notice without flaking on the cancel-timing race.
---

Verifying the FundTrail multi-hop cancelled notice (`fund-trail-multihop-cancelled-text`) in a
real browser needs three non-obvious tricks; without them the test flakes or the subagent dies.

**1. Seed in many small self-chunking `page.evaluate` calls, never one big one.**
A single heavy seed evaluate (e.g. 24–30k txns) overruns the testing subagent's browser session
and returns `Notebook not found` / 502s from the river service. Make the seed snippet
idempotent: on first call clear+insert the owned record, then each call appends one small chunk
(~3k txns) based on current `blockchainTransactions.count()`, returning `PROGRESS`/`DONE`.
Instruct the subagent to re-run it until `DONE`. ~12k txns is plenty.

**2. Full reload + re-unlock to surface a freshly-seeded wallet group.**
The wallet-group dropdown (`fund-trail-group-select`, default dimension `walletName`) is a cached
react-query. Calling `queryClient.invalidateQueries()` from `page.evaluate` did NOT reliably make
the new group appear ("No wallet values found"). A full page reload (then re-enter the vault
password) guarantees `listGroupValues` re-reads the seeded record.

**3. Inject a test-time read-delay to win the cancel-timing race.**
Data volume alone is not slow enough — the trace finishes before the subagent can click Cancel.
The depth-1 progress event is emitted BEFORE the slow read, and `loadBlockTimes` does
`db.blockchainTransactions.where('txid').anyOf(batch).toArray()` in ~N/500 batches with no
abort-check inside. Monkeypatch (in `page.evaluate`, after reload — it is in-memory) the
`.where().anyOf().toArray()` chain on `db.blockchainTransactions` (and `transactionParticipants`)
to `await sleep(~400ms)` per batch. With ~12k txids that's a multi-second window where the
progress banner + Cancel button stay visible. This changes only read timing, not the
cancel/notice logic, and the displayed depth ("hop 1 of 4") still comes from the real engine.

**Expected result:** cancelling during the forward phase yields notice
"Trace stopped while tracing destinations — reached hop 1 of {maxDepth}. Results below are
partial and may be incomplete.", the spinner banner (`fund-trail-multihop-progress`) disappears,
and starting a new trace clears the notice.

**Gotcha:** `computeMultiHopKnown` traces sources (backward) THEN destinations (forward), so a
live-banner screenshot may show the sources sub-phase ("Tracing sources — hop 1 of 1…") even
though the cancel lands on the destinations phase. That mismatch is expected, not a bug.
