---
name: Pooled-run cancel tokens
description: Cancellation contract for concurrent worker-pool runs over shared React row state
---
Rule: any concurrent run over shared row state must pair its cancel flag with a monotonic run token. Bump the token on cancel, reset, AND whenever a new run (of this or an owning feature, e.g. a fresh check that replaces the rows) starts — a later run clearing the cancel flag must not revive stale workers.
**Why:** code review rejected a flag-only design twice: cancel→restart resets the flag while old workers are in flight, letting them write done/error rows or flip the running state off mid-newer-run.
**How to apply:** gate every worker setRows/patch flush and the finally-block finalizers on token ownership; stale workers no-op entirely. Since a stale run's finally can't revert rows, the Cancel handler itself must revert loading→idle immediately.
