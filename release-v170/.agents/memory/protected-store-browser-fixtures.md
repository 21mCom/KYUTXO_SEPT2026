---
name: Protected-store browser fixtures
description: Reliable fixture and navigation rules for packaged browser checks that use the encrypted repository.
---

Packaged checks must treat a successful protected-repository `find` with a `null` result as a missing row. When seeding a natural-keyed row, always include its explicit natural ID; otherwise `save` can create a generated-key row that the app will never read.

**Why:** The bridge envelope distinguishes operation success from row existence. A missing settings row returned successfully as `null`, and saving the spread result without its natural ID produced an unrelated row while every IPC call still reported success.

**How to apply:** Use the protected repository rather than IndexedDB in packaged checks, validate both the envelope and row presence, and include the exact natural ID for seeded singleton rows. If fixture setup reloads the renderer, lock the protected store first so the next renderer performs a normal unlock. After onboarding, wait for its intended final route because optimistic dismissal can occur before its async navigation completes. On Windows, prove owned CDP shutdown and use bounded `rmSync` retries because executable handles can outlive process-tree termination briefly; still fail if the retries are exhausted.