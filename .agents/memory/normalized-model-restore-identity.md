---
name: Normalized model restore identity
description: Durable identity and compatibility rules for normalized rows projected from legacy vault metadata.
---

Portable natural keys must be derived from stable textual identity, never local auto-increment IDs. During restore, remap foreign keys first and recompute any key that depends on a parent identity.

**Why:** Backup source and destination assign different surrogate IDs. Embedding those IDs in natural keys causes duplicate wallets/entities after restore or migration reruns.

**How to apply:** For full and merge restores, match parents by stable natural key, remap references, then derive child keys from the remapped parent’s stable key.

Merging an old backup that has only legacy fields must project normalized rows that are absent for newly imported records while preserving every pre-existing normalized row exactly.

**Why:** A completed migration checkpoint otherwise skips new legacy rows; blindly rerunning projection can overwrite later user choices.

**How to apply:** Use missing-only projection or snapshot/restore existing normalized rows, and include all projected inserts/enrichments in cancellation undo.

Any restore outcome described as verified-empty must use the complete shared portable-vault clearing boundary rather than a manual table list.

**Why:** A drifting cleanup list can leave sensitive inline rows behind while the UI falsely claims the vault is empty.

**How to apply:** Reuse the same clear helper for initial replace and post-clear cancellation/failure cleanup; cleanup failure must produce an unknown-state hard error.