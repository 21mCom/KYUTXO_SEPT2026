---
name: Edge-cap (not node-cap) refusal seed geometry
description: How to build a dataset under the address cap but over the 1M-pair edge cap so the edge guard fires first.
---

The node-count guard runs before the edge-count guard, so exercising the edge refusal needs ≤ node-cap unique addresses whose transactions still expand to > edge-cap unique pairs.

**How:** Use affine-plane lines over Z_p × Z_p (p=53 → 2,809 pool points). Each tx = one line of p addresses (+1 owned input for the "My Addresses Only" filter). Distinct lines share ≤1 point, so per-tx C(p,2) pair sets are fully disjoint — edge counts are exact, no random-collision math. 730 lines → 1,005,940 unique pairs > 1M with only 2,810 nodes; the ~1M-key edge map builds in ~2s in Chromium.

**Why:** Random address pools of the same size collide heavily (~20%+ duplicate pairs), making the seed size unpredictable and slower.
