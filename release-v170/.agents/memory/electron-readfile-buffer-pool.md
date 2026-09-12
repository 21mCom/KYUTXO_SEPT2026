---
name: Electron readFile Buffer pool over IPC
description: Why returning a Node Buffer's .buffer directly over Electron IPC leaks/corrupts neighboring bytes
---

When returning file bytes from the Electron main process to the renderer (e.g. a
`read-attachment` IPC handler), do NOT return `nodeBuffer.buffer` directly.

**Why:** `fs.readFile` returns a Node `Buffer` that is frequently a *view* into a
larger shared/pooled `ArrayBuffer`. `.buffer` is that whole pool, not just this
file's bytes — sending it over IPC ships unrelated memory (a data leak) and the
consumer sees wrong/extra bytes (corruption), which manifested as attachments
that "open" but render garbage or fail verification.

**How to apply:** slice to the buffer's exact window before returning:
`data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)`. Applies
to any path that hands a Node Buffer's backing store to another context.
