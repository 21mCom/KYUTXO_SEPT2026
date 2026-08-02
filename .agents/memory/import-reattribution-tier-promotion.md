---
name: Import re-attribution needs tier promotion too
description: Re-attributing an address to a new wallet on explicit import is invisible unless discovery-tier rows are also promoted to a curated tier.
---

**Rule:** When an explicit import (Bulk Import or wallet-file import) re-stamps `walletName` onto an existing record, discovery-tier rows (`blockchain-discovered`/`pending-review`) must ALSO be promoted to a curated tier in the same merge — otherwise every curated surface (Wallet Overview, Balance) still filters the row out and the user sees "nothing moved".

**Why:** Wallet Overview/Balance allowlist user-curated tiers (see curated-tier-balance-surfaces). A wallet-file merge that only moved `walletName` left rows at `blockchain-discovered`, so the target wallet's totals stayed stuck even after a "successful" re-import — caught only by the real-browser check, not by unit tests of the merge function's walletName field alone.

**How to apply:**
- `mergeRecordData` gates promotion: `incomingImportance` applies only to input (user-controlled) addresses whose existing tier is NOT already curated — never re-label `xpub-derived` (vault summaries key off it) or upgrade third-party outputs.
- `executeImport` passes `incomingImportance: 'wallet-import'`; the Bulk Import page upgrades to `xpub-derived` in its own merge branch.
- Verify end-to-end by counting the surface rows (Wallet Overview badges) after import + Refresh, not just by inspecting stored fields.
