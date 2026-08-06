---
name: Windows import.meta.url pathname trap
description: new URL(import.meta.url).pathname is /D:/... on Windows and path.win32.resolve mangles it; scripts that may run on windows-2022 CI must derive paths via fileURLToPath.
---

# Windows import.meta.url pathname trap

`path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')` works on
Linux but breaks on Windows: the URL pathname is `/D:/a/repo/scripts/x.mjs`,
and `path.win32.resolve` turns that into the invalid UNC-ish path `\\D:\a\repo`.
Any `readdirSync`/`statSync` on it then throws — and if the throw is swallowed
by a catch-and-continue guard, the failure mode is a confusing false negative
(e.g. "bundle not found" right after the build emitted it).

**Fix:** `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')` —
fileURLToPath handles drive letters on every platform. The shared helper
`repoRootFromModuleUrl` in `scripts/packaged-bundle-freshness.mjs` is the
pinned implementation (regression tests assert win32-style `/D:/...` inputs
never produce a `\\` UNC path).

**Why:** the packaged-bundle-freshness guard was written/tested on Linux and
broke the Windows release build the first time it ran on windows-2022; the
CI log showed the bundle emitted yet the guard reported it missing.

**How to apply:** any script that can run on a Windows runner (build.yml steps,
electron-builder hooks) must never derive filesystem paths from
`new URL(...).pathname` without a win32 guard. A static guard
(`scripts/check-win32-path-derivation.js`, wired into validation) now scans
scripts/**/*.{js,mjs} and fails on the naive pattern unless the same file
uses fileURLToPath or a drive-letter strip; files OUTSIDE scripts/ (e.g.
electron-builder hooks, build.yml inline node) are not covered — grep there.
Same bug class as the win32 npm spawn trap (github-push-build-pipeline.md):
Windows-only failures that Linux validation cannot see.
