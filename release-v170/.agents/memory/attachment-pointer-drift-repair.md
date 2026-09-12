---
name: Attachment pointer drift repair
description: How to safely re-link attachment DB rows whose objectStoragePath drifted after the privacy migration
---

After the privacy migration (files moved to `attachments/<sha256(identifier)>/<32hex opaque><ext>`),
some DB `objectStoragePath` pointers drift and the literal path no longer resolves,
so the attachment "won't open". The repair re-links the DB row to the real file.

**Rules (do not relax):**
- Relink-only: the repair/open/convergence paths must NEVER move, copy, or delete
  bytes — only repoint DB rows, and only via the CRUD modules (crud-guards).
- Only ever relink to an *orphaned* (unreferenced) *hashed/opaque* file, never to a
  legacy plaintext file. Candidate dirs are reconstructable only: the stored dir if
  it is already 64-hex, else `sha256(storedDir)`, plus `sha256(recordInputString)`.
- Disambiguate conservatively: prefer matching extension, then exact byte size on a
  small bounded set; return null (report "unresolved") rather than guess.
- Claim each chosen file in a `referenced` set the moment it's used so two drifted
  rows in the same run can't both grab the same orphan (no double-link).

**Why:** bytes are irreplaceable user evidence; a wrong guess silently links a row
to the wrong file. Reporting "unresolved" is always safer than guessing.

**How to apply:** used by tolerant open (auto-relink on read failure), the Settings
"Repair attachment links" reconcile, and migration convergence (a row whose source
file already moved is relinked instead of failing). evidence rows have no
inputString fallback (recordId/inputString only exist on the attachments table).
