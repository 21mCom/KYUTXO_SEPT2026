---
name: Ownership evidence identity
description: Stable identity and persistence rules for heuristic ownership review decisions.
---

Ownership-review evidence fingerprints must be derived from canonical address identifiers, supporting transaction IDs, evidence kind, and entity natural keys. Never include local record, wallet, ownership, or entity surrogate IDs.

**Why:** Backup restore and merge remap surrogate IDs. If a rejection is keyed to those IDs, unchanged evidence receives a new fingerprint after restore and is incorrectly proposed again.

**How to apply:** When adding an ownership heuristic, include every fact whose change should make the evidence stale, but encode referenced rows through portable natural identities. Back up review decisions and remap only their operational row references, not their fingerprint.