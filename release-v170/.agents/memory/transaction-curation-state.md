---
name: Transaction curation state
description: Durable queue state and scaling rules for transaction review.
---

Keep transaction curation state on the txid-unique blockchain transaction row, not in a parallel queue table. Classify ownership and metadata in fixed-size batches, and page the inbox through a compound state-plus-id keyset.

**Why:** Embedded state automatically follows transaction de-duplication and streamed backup/restore. Vault-wide txid/outpoint sets and growing-prefix inbox queries fail at large-vault scale.

**How to apply:** New discovery paths must queue only owned transactions after participants exist; explicit actions change state without deleting rows; migrations and inbox reads must remain batch/keyset bounded.