---
name: Deferred route failure correlation
description: Constraints for retaining the committed page while a newly selected lazy route downloads or fails.
---

Keep the committed route rendered through deferred navigation, and associate every lazy-import rejection with the path that started it. Only the currently pending path may publish a failure or restore the committed URL. A stale download from an abandoned route must be ignored.

**Why:** React may abandon a deferred render before an error boundary commits, so boundary lifecycle reporting is too late. A shared mutable failure callback also lets an older download cancel a newer navigation.

**How to apply:** Report failures directly from the import promise, compare the captured path with a live pending-path reference, and use a fresh lazy identity for retries. Cover loading, failure, retry success, and A→B stale rejection.