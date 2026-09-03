---
name: Protected vault storage design
description: The approved direction for built-in packaged-Electron at-rest protection and its non-negotiable migration and claim gates.
---

Packaged Electron protection must replace both plaintext IndexedDB and
plaintext attachment files: use a SQLCipher primary database plus encrypted,
chunked attachment objects behind main-process typed IPC. The existing native
SQLite engine is only a read replica until that replacement is implemented.

**Why:** encrypting fields or the read replica leaves the live primary store,
indexes, or attachment bytes exposed and cannot honestly support an at-rest
protection claim.

**How to apply:** preserve the plaintext source through staged copy and
read-back verification; only switch after row/attachment/reference/integrity
checks pass. Keep current warnings in web/dev and packaged builds until a real
packaged check proves protected unlock, migration recovery, crash safety,
tamper detection, and locked-state filesystem contents.