---
name: Record identifier canonicalization
description: records.inputString is stored canonical (trimmed; bech32/txid lowercased; base58 untouched) — all exact-match lookups must canonicalize their key; normalization collisions are reported, never merged.
---

# Record identifier canonicalization

Record identity (`records.inputString`) is stored in canonical form: trimmed;
bech32/bech32m (bc1…/tb1…/bcrt1…) and 64-hex txids lowercased; base58 addresses
verbatim after trim (case is meaningful there). `inputStringLower` is always
`canonical.toLowerCase()`.

**Why:** subsystems used to disagree on "the same record" — the UI duplicate
check trimmed/lowercased while sync, wallet-import merge, provenance, and
fund-trail exact-matched the raw stored string — so a padded or uppercase
manual record was invisible to sync, which then created a duplicate
"blockchain-discovered" record for the same address.

**How to apply:**
- Any NEW exact-match lookup on `inputString` must canonicalize its key with
  `canonicalizeRecordIdentifier` (client/src/lib/bitcoin.ts) — raw equality
  silently misses canonically stored rows. Base58 must NEVER be case-folded.
- Never write `inputString` outside the record CRUD layer (it canonicalizes at
  the boundary). Backup restores are verbatim by design, so the startup
  `repairCanonicalInputStrings` pass (own once-only vault flag, re-armed with
  the search-visibility repair after restores) re-normalizes; it bumps
  updatedAt so the engine-mirror freshness fingerprint observes the change.
- Rows whose canonical key collides with another record are SKIPPED by the
  repair and counted in Database Doctor. The product rule is report-never-merge;
  do not add auto-merge without explicit task scope.
- Tests that need non-canonical seed rows can't go through the CRUD layer (it
  canonicalizes) — write the table directly and allow-list the test file in
  scripts/check-crud-guards.js.
