---
name: Privacy Audit proximity hop dedup
description: Why an isolated farther-hop (3/4) proximity finding is impossible through runPrivacyAudit, and where to test those tiers instead.
---

# Privacy Audit proximity: closest-hop dedup makes far-hop end-to-end findings impossible

`detectEntityProximity`'s BFS de-duplicates each entity address to the CLOSEST
owned hop, and `runPrivacyAudit` only loads a transaction if it touches an owned
address. Together these mean a clean, isolated hop-3 or hop-4 proximity finding
**cannot** be produced end-to-end through `runPrivacyAudit`: to load the middle
edges of a long chain you must make the intermediates owned, but then one of
those owned addresses reaches the same entity at a shorter hop and the dedup
collapses the farther-hop finding. A fixture chain
`OWNED → MID_A → MID_B → BRIDGE → ENTITY` (all owned) only ever surfaces the
hop-2 (HIGH) proximity finding plus the hop-1 direct `ENTITY_*` contact.

**Why:** the dedup is intentional (avoids reporting the same entity once per
owned hop). Severity map is `{2:HIGH, 3:MEDIUM, 4:LOW}`, `MAX_PROXIMITY_HOPS=4`.

**How to apply:**
- Test the hop-3 / hop-4 → MEDIUM/LOW *severity mapping* at the engine level:
  call `detectEntityProximity(ctx)` directly with a hand-built `AuditContext`
  whose intermediates are NOT owned (see `privacy-audit.proximity.test.ts`).
- For end-to-end (`runPrivacyAudit`) proximity tests, only assert what survives:
  the closest-hop finding, and/or the dedup contract itself (entity reported
  once, no farther-hop duplicate).
- `renderSourceNote` splits a note into text + anchor child nodes — assert via
  `cell.textContent` / `querySelector("a")`, never `getByText(fullNote)`.

# Partly-broken persisted entity snapshot keeps the valid subset

`loadEntitySnapshotFromStorage` (entity-list-store.ts) does NOT reject a whole
snapshot when some entries are invalid: if at least one entry validates, it
applies the valid subset (re-merged under the persisted `mode`), returns
`source: 'imported'` with a `partialWarning {validCount, skippedCount}`, and only
falls back to the bundled list when ZERO entries survive validation.
