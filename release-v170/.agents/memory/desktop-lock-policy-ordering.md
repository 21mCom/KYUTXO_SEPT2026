---
name: Desktop lock policy ordering
description: Why persisted desktop lock policy synchronization and user saves must be serialized.
---

Startup policy synchronization and user-initiated policy saves must pass through the same single-flight queue. The startup path must read the stored policy only after it reaches the head of that queue.

**Why:** An unlock-triggered sync can otherwise read policy A, overlap a save of policy B, and apply A after B. IndexedDB then says B while Electron enforces stale A until the next unlock or restart.

**How to apply:** Any future path that reads, persists, or applies the desktop lifecycle-lock policy must join the existing coordinator. Keep persistence before main-process application so a storage failure cannot weaken the active policy.