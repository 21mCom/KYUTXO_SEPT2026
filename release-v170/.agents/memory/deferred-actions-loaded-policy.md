---
name: Deferred actions need loaded policy
description: Why queued cross-page network actions must not run against unresolved node-settings defaults.
---

Cross-page queued network actions must wait until the persisted node-settings query resolves before deciding whether first-sync approval is required.

**Why:** On a cold client-side navigation, the settings hook initially exposes a fail-closed placeholder. Treating that placeholder as the user's persisted choice can consume the queue and start the provider boundary before the required disclosure appears.

**How to apply:** Any mount effect that automatically consumes a queued network action should gate queue consumption on the settings hook's loading state, then evaluate approval and network policy from the resolved snapshot.