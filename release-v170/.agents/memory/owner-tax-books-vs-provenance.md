---
name: Owner tax books vs physical provenance
description: Boundary between physical Coin Origins recipes and policy-driven per-owner cost-basis books.
---

Owner cost-basis matching is a policy-driven accounting projection and must remain separate from the physical Coin Origins recipe. Only affirmatively controlled addresses belong in owner books; sync-discovered counterparties and Pending Review rows do not.

**Why:** Physical provenance answers where sats came from, while tax books answer whose eligible lots a disposal closes under dated policy. Combining them causes policy edits to rewrite provenance and can misclassify ordinary external payments as owner transfers.

**How to apply:** Preserve physical lot identity independently. Build owner-book inputs from normalized affirmative ownership (with conservative legacy handling), keep blank controlled ownership in Unassigned, and never infer ownership from discovery-tier address rows.