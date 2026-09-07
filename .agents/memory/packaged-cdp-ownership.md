---
name: Packaged CDP ownership
description: The ownership and relaunch contract for packaged Electron browser checks.
---

Packaged Electron checks must request an OS-selected loopback CDP port and prove the endpoint belongs to their unique disposable Chromium profile by matching its `DevToolsActivePort` browser token against `/json/version` before connecting.

**Why:** A fixed or merely reachable port can belong to a surviving or unrelated browser, allowing a release check to test the wrong renderer.

**How to apply:** Use the shared packaged-CDP helper for every packaged renderer launch. When reusing a profile, first prove the old endpoint is down, then remove the stale ownership file, launch, and establish ownership again.