---
name: Engine auto-maintenance policy
description: How/when the live app auto-seeds & refreshes the native read-engine mirror at launch — the rules that must not be loosened.
---

# Engine auto-maintenance (launch bootstrap)

The desktop app self-maintains the native better-sqlite3 read-engine mirror on launch
(after auth + startup migrations). The decision table and the two non-obvious rules:

- EMPTY → seed. READY + fingerprint-fresh → ready. READY + `stale` → refresh. ERROR → no retry. In-flight seed → attach (shared seed lock).

**Rule 1 — refresh ONLY at launch, never per Dexie write.**
**Why:** a seed is a full rebuild of the whole vault. A sync/import fires thousands of
writes; write-triggered reseeds would thrash and never converge. Mid-session drift is
handled by the per-screen freshness gate (`evaluateEngineFreshness`), which just falls
back to Dexie until the next launch re-seeds.
**How to apply:** keep reseed triggers in the launch bootstrap only; do not subscribe a
reseed to data mutations.

**Rule 2 — at launch, rebuild a READY mirror only on freshness `reason==='stale'`, never on `error`.**
**Why:** tearing down a valid, indexed mirror because a fingerprint *probe* transiently
failed is strictly worse than keeping it — screens already re-check freshness per read and
fall back to Dexie on their own. A flaky probe must not destroy good work.
**How to apply:** branch on `decision.reason === 'stale'` to refresh; on `error`/`not-ready`
leave the existing mirror intact (settle idle), don't clear/rebuild.

**Cancelled seed must NOT claim ready.** A cancelled seed leaves the engine EMPTY
(clear() aborts it); set maintenance back to `idle`, so screens correctly use Dexie.
