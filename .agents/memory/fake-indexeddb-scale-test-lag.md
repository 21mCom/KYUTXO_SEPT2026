---
name: fake-indexeddb scale-test event-loop lag
description: Event-loop-lag assertions in vitest scale tests are noisy because fake-indexeddb structured-clones synchronously; guard responsiveness structurally instead.
---

**Rule:** In vitest scale tests (fake-indexeddb), don't assert tight event-loop-lag thresholds. fake-indexeddb structured-clones every fetched row synchronously on the JS thread, while real browsers clone off the main thread — a "max event-loop gap" measurement reflects the harness, not the app.

**Why:** A large-vault test asserting a tight max-gap threshold failed even though the implementation yielded correctly between batches; the measured gap was the batch fetch's clone cost, not main-thread JS work.

**How to apply:** Guard responsiveness structurally: inject a yield callback spy and assert it's called once per batch, and assert output chunks/parts stay size-bounded (so no giant join/copy can exist by construction). Treat any lag assertion as a generous smoke bound only, with a comment explaining the fake-indexeddb clone noise.
