---
name: Concurrent browser-check contention
description: Why the Chromium validation checks time out on input-password when run together
---
The validation suite runs several real-Chromium checks (sample-pdf, pof-empty, pof-empty-live, pdf-glyph, proof-verify) concurrently. Under that load (30+ Chromium processes plus Vite dev-server transforms) the initial page load exceeds the 30s `input-password` wait, so multiple checks fail with the same timeout.

**Why:** Nix Chromium + Vite cold transforms are CPU-bound; parallel runs starve each other. The app itself is fine — the same checks pass immediately when run one at a time.

**How to apply:** If validation reports several browser checks all timing out on `input-password`, don't chase an app bug. Re-run each `node scripts/check-*-browser*.mjs` sequentially (kill stale `chromium` processes first); if they pass standalone, the validation failure is contention flake, not a regression. Note: `pkill -f chromium` from a bash tool call can kill the calling shell — run it in its own command.
