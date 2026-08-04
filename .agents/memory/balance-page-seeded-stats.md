---
name: Balance page vs seeded cached stats
description: Why browser-check seeds of cached per-address stats vanish on the Balance page unless the formula version is pre-marked.
---

**Rule:** When seeding fake cached per-address stats (cachedBalanceSats/cachedUtxoCount/statsComputedAt) for a Balance-page browser check, also set `updateSettings('default', { balanceFormulaVersion: 2 })` before navigating.

**Why:** On first load with no/old `balanceFormulaVersion`, BalanceOverview runs a one-time full `recomputeAddressStats` pass, which rebuilds stats from real participants/transactions — wiping seeded stats to zero and rendering "No UTXO data found" with zero errors.

**How to apply:** Any check or fixture that relies on hand-written cached stats appearing in Balance groups/totals must pre-mark the formula version (and set both statsComputedAt and cachedUtxoCount to dodge the needsBackfill path).
