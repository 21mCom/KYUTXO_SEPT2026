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
The genuine "still locked / unreadable" signature is: an active marker present
**AND** the real field (`inputString`) is blank **or the `[encrypted]`
placeholder**. A marker on a row whose `inputString` is populated is harmless
leftover cleanup state (a separate "readable but uncleaned" bucket), not a
problem. A blank `inputString` with *no* marker is "blank/corrupt", not "locked"
— keep the three buckets distinct.

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
