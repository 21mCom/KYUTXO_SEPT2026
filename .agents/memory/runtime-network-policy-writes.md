---
name: Runtime network policy writes
description: Concurrency rule for keeping persisted node settings and fail-closed runtime network policy aligned.
---

Serialize policy-related node-settings writes through one shared queue. Apply optimistic partial updates to the current runtime policy, not to a hook render snapshot; replacement operations must transform the current runtime value.

**Why:** A delayed callback can retain an older render snapshot. Rebuilding runtime policy from it can briefly restore network access after a newer Forget/offline action has cleared the privacy choice, even when persisted partial updates are safe.

**How to apply:** Any new background or UI writer that can touch network policy or race with one must join the central settings-write serialization. Re-read persisted settings inside its queued operation, while preserving immediate fail-closed runtime changes.