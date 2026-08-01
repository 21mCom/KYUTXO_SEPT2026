---
name: Streaming HTTP downloads need pipeline, not .pipe
description: Aborted client downloads leak fds when a FileHandle read stream is .pipe()d to the response.
---

Rule: when streaming a file to an HTTP response, use `stream/promises` `pipeline(readStream, res)` — never `readStream.pipe(res)`.

**Why:** `.pipe` does not destroy the readable when the response closes early (client abort/disconnect); with an explicitly opened FileHandle, `autoClose` only fires when the read stream itself ends/errors, so concurrent aborted downloads accumulate open fds until the server hits its fd limit. Code review rejects `.pipe` here.

**How to apply:** wrap `await pipeline(stream, res)` in try/catch; treat `ERR_STREAM_PREMATURE_CLOSE` as routine (client abort, no log), log other errors and `res.destroy()` so clients see truncation instead of a silent short file. Verify cleanup in tests by scanning `/proc/self/fd` readlinks for the file path after aborting fetches mid-stream (file must exceed socket buffers, ~16MB).
