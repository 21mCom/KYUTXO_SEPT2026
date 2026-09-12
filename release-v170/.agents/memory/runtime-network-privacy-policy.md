---
name: Runtime network privacy policy
description: Non-obvious enforcement and state-ordering rules for the global network kill switch.
---

Every blockchain-provider method must recheck the current runtime network policy; checking only when constructing a provider leaves long-lived provider instances able to bypass a later offline switch. Address-bearing methods additionally require the persisted first-sync disclosure.

**Why:** An optimistic offline update can be silently undone if an unrelated React render republishes the previous IndexedDB live-query snapshot before the write completes. That creates a real privacy race even though both the UI and database eventually show Offline.

**How to apply:** Publish optimistic policy before persistence, and only let a genuinely new persisted snapshot replace it. Preserve onboarding, offline, and first-sync policy fields when resetting connection defaults. Add new network transports behind the guarded provider boundary.