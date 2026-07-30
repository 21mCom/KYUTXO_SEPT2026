---
name: Legacy 1.1.24-vault upgrade journey
description: How the old encrypted-at-rest vault upgrade path works end-to-end, its progress surfaces, and how to regression-test it at scale.
---

# Legacy (encrypted-at-rest era) vault upgrade journey

A vault created by the 1.1.24-era app is Dexie schema v25 with field-level
encryption at rest (`inputString`/`label` = `'[encrypted]'`, real values in
`encryptedPayload`). Opening it in the current app runs three phases in order:

1. **Schema upgrade chain (pre-unlock, v26→current)** — v27 walks every row of
   16 tables via `toCollection().modify()` moving `encryptedPayload` →
   `_legacyEncryptedPayload`; v29 cleans placeholder vocab/fields; v30 builds
   `inputStringLower`. Surfaced by the `db-upgrade-overlay` (App.tsx) fed by
   `db-upgrade-progress.ts` reporters wired inside `database.ts` upgrade fns.
   AuthContext detects a pending upgrade pre-open via `indexedDB.databases()`
   (raw version < `CURRENT_SCHEMA_VERSION * 10` — Dexie stores verno×10) and
   explicitly `await db.open()`s so progress streams before login.
2. **Decrypt migration (post-unlock, one-time)** — restores plaintext per
   table with live progress, then a **verify phase** (`phase: 'verify'`,
   "Verifying Migrated Data" heading) re-scans for unrecovered rows via
   `countUnrecoveredLegacyRows` (emits `rowsScanned` per chunk).
   `_legacyEncryptedPayload` is deliberately KEPT after success (strip is a
   separate step) — never assert marker-free as "restored".
3. **Startup repairs** — attachment-path + inputStringLower repairs surface
   via `migrationPhase` string in AuthContext ("Preparing your vault…" screen).

**Why:** users with grown vaults saw only static spinners for minutes and
force-quit, aborting the upgrade transaction — the "desktop hangs" report.

**How to apply / test:** `client/src/lib/legacy-vault-fixture.ts` builds a
faithful v25 vault (own raw Dexie handles → passes CRUD guards; exact V25_STORES
from the 1.1.24 tag; WebCrypto payloads; `writeVaultSettings` makes login work).
Node-level: `legacy-migration.test.ts` runs the REAL upgrade chain over it
(needs 60s timeout; >512 rows so throttled row-counters fire).
Browser-level: `scripts/check-legacy-upgrade-scale-browser.mjs` seeds via
`page.goto('/manifest.json')` (static file — app never boots, so the DB stays
at v25) then drives overlay → login → migration → hang sweep with a longtask
PerformanceObserver (fail >4s). Env knobs `KYUTXO_SCALE_*` scale it up.
The seed MUST navigate to a real static asset; any SPA route would open the
DB at the current version first and the fixture guard throws.
