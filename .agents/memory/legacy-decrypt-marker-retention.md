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
**AND** the real field (`inputString`) is blank. A marker on a row whose
`inputString` is populated is harmless leftover cleanup state (a separate
"readable but uncleaned" bucket), not a problem. A blank `inputString` with *no*
marker is "blank/corrupt", not "locked" — keep the three buckets distinct.
