---
name: Origin-lot certainty propagation
description: How unknown acquisition boundaries remain unknown through compositional lot accounting.
---

An acquisition lot is a wallet custody boundary, not proof that upstream provenance is known. Its source certainty must travel with every allocation through internal moves, splits, consolidations, fees, disposals, wallet scopes, and exports. Never classify a non-sentinel lot ID as known merely because it has a stable identity.

**Why:** An unresolved inbound transaction can legitimately start a named acquisition lot. If later accounting infers certainty from that lot ID alone, one internal move silently converts unknown provenance into a deterministic claim.

**How to apply:** Any allocation aggregation or known/unknown summary must consult the acquisition lot's source-boundary metadata. Reconciliation for a current outpoint or passport must also include every ancestor hop, not only the current row's allocation sum.