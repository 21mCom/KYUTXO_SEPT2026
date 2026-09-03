---
name: Derived-index rebuild coordination
description: Concurrency rule for safely certifying local derived indexes as ready.
---

Local derived indexes must not certify readiness from a source-table fingerprint alone. Start a rebuild by atomically checking that no source/index mutation is pending and capturing a monotonic generation; mark ready only if that generation is unchanged and no mutation is pending.

**Why:** A fingerprint can describe the newest source rows while stale postings survive from a rebuild batch that raced a write. Separate read/write state operations can also overwrite mutation counters.

**How to apply:** Use one state transaction for the pending barrier and generation capture, increment generation when each source mutation begins, preserve rebuilding state through mutation completion, and retry the entire rebuild when final compare-and-set validation fails.