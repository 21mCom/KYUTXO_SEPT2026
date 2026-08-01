---
name: Electron error hygiene scope
description: What counts as a leak when sanitizing desktop-app error output.
---
Rule: error sanitization in the desktop main process must cover every escape surface — IPC payloads, all main-process logs (including success-path and startup lifecycle logs), rejection/validation reason strings, and fallback error pages. Any of these interpolating a URL, host:port, absolute path, or raw error text is a leak.

Remote-server-controlled error text is also untrusted: pass it through only after token-level redaction that removes host/URL/path-shaped material (including single-label hosts like `localhost`, IPv6, schemes, long opaque blobs) — separator-stripping alone launders hosts into plain words.

**Why:** desktop logs and error strings reach disk/UI; private node endpoints and paths in them defeat the privacy goal.

**How to apply:** log error name + errno code only; identify connections with opaque ids instead of host:port; keep hostnames out of allow/deny reasons; judge whole whitespace tokens before stripping separators.
