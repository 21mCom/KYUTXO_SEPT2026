---
name: Filesystem cursor lifecycle
description: How bounded filesystem enumeration should combine exact summaries with long-running streamed exports.
---

Run a bounded-memory summary traversal before writing a manifest, but do not open the resumable directory iterator until the export reaches its file-streaming phase. Cursor sessions need finite page limits, a global cap, expiry cleanup, and explicit close on cancellation or failure.

**Why:** Opening a cursor while gathering manifest data can leave its directory handles idle while large database tables stream; a normal TTL can then expire mid-export. Offset pagination avoids handles but repeatedly rescans prior names and becomes quadratic.

**How to apply:** For filesystem-backed exports, separate `summary()` from cursor-based `listPage()`. Prove scale by counting actual traversal visits across many pages, not merely page calls, and keep symlink filtering on every traversal.