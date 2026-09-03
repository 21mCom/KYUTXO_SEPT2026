---
name: Coin Origins scope assertions
description: Non-obvious distinctions between Coin Origins summary cards, holding rows, and export provenance.
---

Coin Origins checks must treat acquisition lots and rendered holdings as separate counts. A mixed current output can add a synthetic `unknown` holding in addition to its acquisition lots, and that synthetic CSV allocation intentionally has blank origin transaction, vout, and acquisition date fields.

**Why:** Assuming one holding row per acquisition lot made a correct whole-vault export appear stale, and requiring provenance fields on the synthetic unresolved allocation rejected the canonical CSV.

**How to apply:** Compare CSV allocations grouped by lot ID with rendered holding rows and compare their summed satoshis with the summary cards. Assert acquisition-lot cards independently; allow blank provenance only for the synthetic unresolved holding.