---
name: Engine probe timeouts & readiness baseline trap
description: Why every renderer→engine-worker IPC probe must be bounded, the gate must short-circuit during seed, and the readiness poll must also time out.
---

# Engine probe timeouts & the readiness baseline trap

The native read-engine runs in ONE single-threaded worker. The seed `finalize` step
(build indexes → materialize UTXOs → integrity_check) is now **cooperatively async**:
its handler `await`s `setImmediate` between every sub-step (each index build, before
each materialize/verify pass), so queued `status`/`schemaVersion` polls ARE answered
in the gaps and the worker stays responsive during a rebuild. The worker message
handler is `async` and `await`s `dispatch` for this to work. BUT a single SQLite
statement still cannot be interrupted, so a heavy individual step (e.g. the owned-UTXO
anti-join, or one big index) blocks for its own duration. The probe-timeout +
short-circuit rules below remain the safety net — never assume finalize is fully
non-blocking. Any OTHER long synchronous worker job (no yields) still blocks all IPC.

## Rules
1. **Bound every worker probe.** Wrap status/schema/fingerprint calls in
   `withEngineTimeout` (shared helper in `engine-timeout.ts`, single source for both
   the read gate and the readiness poll). A timeout REJECTS → caller's catch → fall
   back to Dexie (`useEngine:false`). It must NEVER cancel/tear down the in-progress
   worker job — the rebuild keeps running; we just stop waiting on it.
2. **Short-circuit the read gate during a seed.** If `engineSeedInFlight()` is true,
   the gate returns `useEngine:false` WITHOUT touching the worker (don't even wait
   the timeout). The bounded timeout is the backstop for *other* stalls.
3. **The readiness poll must ALSO be bounded.** `subscribeEngineReadiness()` /
   `engineReadyForReads()` poll `getEngineStatus()`. The poll's **first sample
   establishes a baseline WITHOUT notifying**. If that first sample lands during
   `finalize` with an UNTIMED probe, it blocks until finalize ends and then silently
   baselines `ready=true` — the not-ready→ready transition is never fired, so pages
   that fell back to Dexie during the seed are never told to re-query and stay on the
   slow Dexie path for the whole session. Timing out keeps the baseline `false` until
   READY is genuinely observed, so the transition fires and pages switch over.

**Why:** a schema-version bump (`ENGINE_SCHEMA_VERSION`) forces a full reseed on the
first launch of an existing vault; with untimed probes every page hung on launch
instead of degrading to Dexie. No data was lost (vault lives in IndexedDB).

**How to apply:** any new code that awaits an engine worker IPC probe must wrap it in
`withEngineTimeout` and treat a timeout as a Dexie fallback. Never trust an untimed
`status()` during or right after a reseed. Packaging must rebuild the native worker
bundle (and `electron-build.sh` runs `set -euo pipefail`) so a stale worker is never
shipped against a bumped schema.
