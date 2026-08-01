---
name: Oversized-upload rejection is browser-testable
description: How to e2e-test a multer size-cap rejection without shipping the giant file over CDP.
---

Rule: to test a server upload size cap end-to-end, build the >cap `File` **inside**
`page.evaluate` (`new File([new ArrayBuffer(cap+1)], ...)`), assign it to the real
`input[type=file]` via `DataTransfer`, and dispatch `change` — the real UI handler runs
and no bytes cross the CDP wire.

**Why:** feared Chromium would see a socket reset before multer's 413 response mid-upload;
in practice the 413 JSON is delivered cleanly and the UI error toast shows the server message.

**How to apply:** any future check of upload limits or large-body rejection paths; also
remember a REPLACE restore assigns fresh Dexie row ids, so re-look-up ids after restoring.
