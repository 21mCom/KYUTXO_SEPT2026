---
name: Packaged Electron never uses the local HTTP server
description: Host-guard / launch-token changes cannot break the packaged desktop app; only dev Electron hits localhost:5000
---

The packaged desktop app loads its renderer from the bundle-confined `kyutxo-app://bundle` scheme and does attachment/provider IO through IPC handlers registered in the main process — it never sends an HTTP request (and thus no Host header) to the Express server. Only dev-mode Electron uses `loadURL("http://localhost:5000")`.

**Why:** A task assumed "the packaged app loads the UI from the local server" and worried the DNS-rebinding Host allowlist would 403 it; investigation showed the premise was wrong.

**How to apply:** When evaluating server-side middleware (Host checks, launch token, headers) against the desktop app, check `electron/main.cjs` first. Lockstep tests parse every `loadURL(http…)` origin against `isAllowedHost` and require the packaged custom-scheme URL.
