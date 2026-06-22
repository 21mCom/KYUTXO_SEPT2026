---
name: legacy-decrypt marker retention
description: Why a leftover encrypted-payload marker does NOT mean a row is still locked, and how to actually detect unrecovered rows.
---

# Legacy decrypt keeps its markers on purpose

After the login-time legacy-decrypt restores a row's plaintext fields, it
**intentionally KEEPS** the marker keys `_legacyEncryptedPayload`, `isEncrypted`,
`encryptedPayload` on the row. They are the only recoverable copy of the original
values and are removed *only later* by the separate, user-initiated strip/cleanup
step (StripMarkersPanel).

**Why:** deleting markers at decrypt time turned any partial/failed migration into
permanent data loss. Retaining them makes recovery re-runnable.

**How to apply:** any health-check / diagnostic / "is this row still locked?"
logic must NOT treat marker-presence alone as "locked" — a fully readable,
recovered row legitimately still carries the markers. Check ALL three markers,
not just `_legacyEncryptedPayload`: an *active* marker = non-empty
`_legacyEncryptedPayload` OR non-empty `encryptedPayload` OR `isEncrypted === true`.
A marker on a fully-readable row is harmless leftover cleanup state (a "readable
but uncleaned" bucket), not a problem.

# "Locked" is PER-FIELD, never sentinel-only

`isRowUnrecovered(row, sensitiveFields)` is the single source of truth and is
**per-field**: a row is locked when the *sentinel* (`sensitiveFields[0]`) is blank
**or** `[encrypted]`, **OR ANY other** sensitive field equals the `[encrypted]`
placeholder. The literal `[encrypted]` is the only cross-field "still locked"
signal; a *blank* value only signals locked for the sentinel, because non-sentinel
fields can be legitimately empty.

**Why:** an older recovery pass restored only each row's first sensitive field, so
every other field kept the literal `[encrypted]`. A sentinel-only check
(`inputString` blank/placeholder) treated those half-restored rows as done — the
recovery filter skipped them, the locked-count reported 0, and (worst) the marker
strip would delete the payload that was the *only* copy able to restore them.

**How to apply:** reuse this one broadened check EVERYWHERE the old one-field test
lived — recovery filter, locked-count scan, fast early-exit probe, AND the
strip-safety check. Strip must refuse any row that still has ANY `[encrypted]`
field. A blank sentinel with *no* marker is "blank/corrupt", not "locked".

# Recoverable vs unrecoverable split (honest reporting)

Among locked rows, those still carrying `_legacyEncryptedPayload` are
**recoverable** (re-running restore repairs them — this gates "is recovery
complete?"); those whose payload is **missing** are **unrecoverable** (the
original values are genuinely gone). Report unrecoverable rows honestly instead of
silently treating them as fine, and do NOT enumerate them in the locked-records
list (retry cannot help them). The completion gate stays on
`totalUnrecovered===0` only; it must NOT block on unrecoverable rows.

# Dual restore strategy (full vs surgical)

When restoring a locked row, branch on whether the sentinel is still locked:
fully-locked row (sentinel blank/`[encrypted]`) → restore EVERY payload field
(skip `id` + marker keys) — covers fields outside any historical whitelist;
partially-recovered row (sentinel already plaintext) → refill ONLY the fields
currently equal to `[encrypted]`, so user edits and legitimately-empty optionals
are never rolled back.

# Never claim decrypt success on decrypt counts alone (verify-then-flag)

`legacyDecryptComplete=true` must be gated on an **independent post-decrypt
re-scan** for still-unrecovered rows, NOT on `totalFailed===0 &&
tableErrors.length===0`.

**Why:** a malformed/garbage payload can decrypt without throwing yet write a
blank/placeholder sentinel — so the decrypt loop reports zero failures while the
row is still locked. Flagging complete on counts alone re-creates the exact
"login short-circuits, data stays locked forever" bug this whole feature exists
to fix. The manual recovery panel adds a `verifying` phase
(`countUnrecoveredLegacyRows`) and only sets the flag when
`scan.totalUnrecovered===0`.

# Re-running decrypt must skip already-recovered rows (idempotency)

Because markers are kept after recovery (see above), a naive re-run of
`decryptLegacyRecords` will re-decrypt EVERY marker row and overwrite any user
edits made since the first migration. Filter the batch to **unrecovered rows
only** (`isRowUnrecovered`: marker present AND sentinel blank/placeholder) before
decrypting. First migration is unaffected (all target rows are unrecovered).

# Engine-mirror reseed is best-effort, never fatal to a restore

After restoring plaintext, refreshing the native read-engine mirror (`seedAll`)
must be in its **own try/catch**. Dexie/IndexedDB is canonical; the engine is a
read replica. A mirror-refresh failure must surface as a non-fatal warning, never
turn a successful IndexedDB restore into a reported failure.
