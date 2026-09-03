---
name: Packaged Electron verification on Replit
description: How to launch and drive the electron-builder asar in this environment; custom-scheme, CSP, and routing gotchas
---

## Launch recipe
- Upstream Electron (≥~39) binaries crash with "Floating point exception" here regardless of libraries; run the electron-builder `app.asar` under the nix `electron` (29.x) instead, with `--remote-debugging-port`, then drive with playwright-core `connectOverCDP`.
- Do NOT use the nix `xvfb-run` wrapper: its bundled xorg-server **1.20** Xvfb segfaults the whole session instantly (even `electron --version` under it exits 139, with zero output). Launch a modern nix xorg-server **21.x** `Xvfb :99` directly and set `DISPLAY` on the electron process. The segfault also appears on normal SIGTERM teardown, so judge success by CDP coming up, not by exit code.
- Do not enumerate and sort all of `/nix/store` with Node `fs.readdirSync` to locate Electron/Xvfb; the store mount can block for minutes. Prefer explicit env overrides, then a narrow shell glob with a timeout.
- A repeatable guard exists: `scripts/check-packaged-electron-browser.mjs` (release gate, Step 4 of `scripts/electron-build.sh`; `KYUTXO_PACKAGED_SKIP_BUILD=1` reuses release/linux-unpacked). Package the asar for it via `electron-builder --dir --linux -c.npmRebuild=false` (npmRebuild would target electron 39 ABI and needs network).
- Background processes die at the tool-call boundary: launch + drive in ONE shell command.
- A `pkill -f 'pattern'` whose pattern appears in the same command line kills the shell itself (exit -1 with no output). Keep pkill in a separate command or bracket the pattern.
- Replit sets `XDG_CONFIG_HOME` etc. to the workspace — export HOME **and** the XDG vars in the launch script or vault state persists across "fresh" runs in `workspace/.config/<app>`.

## Custom-scheme renderer gotchas (durable)
- Packaged assets must use the privileged standard+secure `kyutxo-app://bundle` scheme and resolve only beneath `dist/public`; never restore a `file://` handler or OS-path fallback.
- Keep CSP in a `<meta>` tag as the proven cross-version enforcement source, plus response headers. Packaged `connect-src` stays self-only so blockchain-provider traffic cannot bypass validated main-process IPC.
- CDP/DevTools `Runtime.evaluate` bypasses CSP eval restrictions — probe enforcement with in-page mechanisms (inline `<script>` + securitypolicyviolation, Trusted Types sink assignment), never `eval()` from the driver. Note TT also blocks the probe's own `script.textContent` assignment — catch that as "enforced".
- Packaged app routing is hash-based (`useAdaptiveLocation`): navigate via `location.hash = '#/path'`, not pushState.

## Native save dialog
- The Electron backup sink opens a native GTK "Save File" dialog (invisible to CDP). Accept it with `xdotool windowfocus --sync <win> ; key Return` on the fixed Xvfb display (no WM → `windowactivate` is a no-op). The file saves relative to the Electron process **cwd** (defaultPath is a bare filename), not $HOME.

## Windows portable release gate
The Windows renderer release gate must launch the generated `*-Portable.exe` wrapper, not only the sibling `win-unpacked` executable. Copy the exact package-version artifact into a disposable directory before launching it, and place `TEMP`, `TMP`, and Windows profile fallbacks under the same root.

**Why:** electron-builder's portable wrapper sets `PORTABLE_EXECUTABLE_DIR` to its own directory and extracts through the Windows temp directory. Launching it in `release/` writes portable test state there, while killing only the wrapper can orphan the extracted Electron child and leave files locked.

**How to apply:** keep the unpacked executable for ABI checks, but use the wrapper for renderer startup. For persistence coverage, create a vault, stop its full Windows process tree with `taskkill /T` (then `/F`), verify non-empty `KYUTXO_Data` beside the copied wrapper, and relaunch that same wrapper before cleanup.
