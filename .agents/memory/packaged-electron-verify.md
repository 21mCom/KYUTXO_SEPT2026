---
name: Packaged Electron verification on Replit
description: How to launch and drive the electron-builder asar in this environment; file:// CSP + routing gotchas
---

## Launch recipe
- Upstream Electron (≥~39) binaries crash with "Floating point exception" here regardless of libraries; run the electron-builder `app.asar` under the nix `electron` (29.x) instead, with `--remote-debugging-port`, then drive with playwright-core `connectOverCDP`.
- Do NOT use the nix `xvfb-run` wrapper: its bundled xorg-server **1.20** Xvfb segfaults the whole session instantly (even `electron --version` under it exits 139, with zero output). Launch a modern nix xorg-server **21.x** `Xvfb :99` directly and set `DISPLAY` on the electron process. The segfault also appears on normal SIGTERM teardown, so judge success by CDP coming up, not by exit code.
- Do not enumerate and sort all of `/nix/store` with Node `fs.readdirSync` to locate Electron/Xvfb; the store mount can block for minutes. Prefer explicit env overrides, then a narrow shell glob with a timeout.
- A repeatable guard exists: `scripts/check-packaged-electron-browser.mjs` (release gate, Step 4 of `scripts/electron-build.sh`; `KYUTXO_PACKAGED_SKIP_BUILD=1` reuses release/linux-unpacked). Package the asar for it via `electron-builder --dir --linux -c.npmRebuild=false` (npmRebuild would target electron 39 ABI and needs network).
- Background processes die at the tool-call boundary: launch + drive in ONE shell command.
- A `pkill -f 'pattern'` whose pattern appears in the same command line kills the shell itself (exit -1 with no output). Keep pkill in a separate command or bracket the pattern.
- Replit sets `XDG_CONFIG_HOME` etc. to the workspace — export HOME **and** the XDG vars in the launch script or vault state persists across "fresh" runs in `workspace/.config/<app>`.

## file:// renderer gotchas (durable)
- Vite's absolute `/assets/...` URLs 404 under `file://`; the packaged app needs the `protocol.handle('file')` fallback in electron/main.cjs that remaps missing absolute paths into `dist/public`. **Why:** loadFile alone leaves a blank window.
- Chromium IGNORES CSP delivered as a response header on `file://` documents — CSP must be injected as a `<meta>` tag into the served HTML (the file-protocol handler does this). `webRequest.onHeadersReceived` never applied to file:// at all.
- CDP/DevTools `Runtime.evaluate` bypasses CSP eval restrictions — probe enforcement with in-page mechanisms (inline `<script>` + securitypolicyviolation, Trusted Types sink assignment), never `eval()` from the driver. Note TT also blocks the probe's own `script.textContent` assignment — catch that as "enforced".
- Packaged app routing is hash-based (`useAdaptiveLocation`): navigate via `location.hash = '#/path'`, not pushState.

## Native save dialog
- The Electron backup sink opens a native GTK "Save File" dialog (invisible to CDP). Accept it with `xdotool windowfocus --sync <win> ; key Return` on the fixed Xvfb display (no WM → `windowactivate` is a no-op). The file saves relative to the Electron process **cwd** (defaultPath is a bare filename), not $HOME.
