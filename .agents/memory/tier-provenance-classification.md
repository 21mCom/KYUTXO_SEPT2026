---
name: Tier provenance classification
description: How to classify record importance tiers from provenance (source markers, syncDepth) for insert hardening and repairs — and why blanket normalization is forbidden
---

**Rule:** Never blanket-normalize invalid/missing `addressImportance` tiers to `'manual'`. Derive from provenance: sync provenance (syncDepth > 0, or source EXACTLY `'blockchain-sync'`) → hidden discovery tier; import source markers → `wallet-import` / `xpub-derived`; else `manual`.

**Why:** Curated-tier balance surfaces allowlist user tiers. Blanket `'manual'` (what the old v29 migration did — do not copy it) leaks sync-discovered counterparty rows into "owned" totals. Conversely a user-imported row must not be classified back to a hidden tier just because sync also touched it.

**Key facts:**
- Import flows write marker-prefixed source strings via `generateSourceName()`: `walletImport-<Display Name>_<date>_<time>` (desktop), `mobileImport-…` (mobile), `bip329Import_…` (BIP-329 labels), `descriptorImport-…` (descriptor → derived addresses, i.e. xpub-derived). Sources are NOT bare display names.
- Merges JOIN sources with `"; "` (merge-utils mergedSource), so markers can appear mid-string — match with substring `.includes()`, never a single `startsWith` prefix.
- Precedence: valid provided tier > syncDepth>0 > source exactly `'blockchain-sync'` > wallet-import markers > derived markers/xpub/derivationPath > manual.
- ALL insert paths (createRecord AND bulkCreateRecords — which full restore and v3 merge restore both use via backup/restore.ts handleBatch) route through buildFullRecord → deriveAddressImportance, so hardening the classifier covers restore reintroduction of invalid tiers.
- Repairs that mutate rows must bump `updatedAt`, or the engine mirror freshness fingerprint (count+maxId+maxUpdatedAt) cannot see the change and keeps serving the stale mirror.

**How to apply:** Any new import surface must add its source marker to the classifier marker lists in record-crud. Tier repair and insert hardening intentionally share deriveAddressImportance — fix classification in one place only.
