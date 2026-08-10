---
name: pdf.js in the real-browser test harness
description: pdf.js build selection is feature-detected at runtime (default build needs Promise.try / Chrome 128+); legacy build is the old-engine and Node fallback.
---

# pdf.js in the headless-Chromium test harness

When verifying PDFs in a REAL browser via the Nix `chromium` + `playwright-core`
pattern (the same one `check-proof-verify-browser.mjs` uses), the PDF glyph
check's `loadPdfjs()` feature-detects at runtime:

- Browser with native `Promise.try` (Chrome 128+): default `pdfjs-dist` build +
  `pdfjs-dist/build/pdf.worker.min.mjs?url` real worker — the exact production
  configuration.
- Older browser or Node: `pdfjs-dist/legacy/build/pdf.mjs` (+ legacy worker
  `?url` in the browser). Node ALWAYS uses legacy regardless of its own
  `Promise.try` support — the default build needs browser globals (DOMMatrix).

**Hard-won gotchas:**
- Never shim `Promise.try` via `page.addInitScript`: it fixes the MAIN thread
  but NOT the Web Worker pdf.js spawns (init scripts don't run in Workers) →
  `UnknownErrorException`. It would also fool the feature detection above into
  loading the default build on an old browser. Detection must be native-only.
- `import('pdfjs-dist')` as a raw `page.evaluate` string fails "Failed to
  resolve module specifier" — raw eval bypasses Vite's bare-import rewriting;
  import a Vite-served `/src/...ts` module instead.
- In the browser pdf.js needs an explicit `GlobalWorkerOptions.workerSrc`
  (Node has a built-in fake worker; the browser does not).
- The Nix channel (stable-24_05) pins Chromium 125; replit.nix can't be edited
  directly and the package tool installs from the same channel. But a one-off
  modern Chromium IS obtainable: `nix build github:NixOS/nixpkgs/nixos-25.05#chromium`
  (retry the ~2min-capped bash call; nix resumes from the store) then point the
  guard at it via `CHROMIUM_BIN`. Playwright's Chrome-for-Testing download does
  NOT work here — it crashes with a floating point exception at startup even
  with a full LD_LIBRARY_PATH built from the nix chromium's RUNPATH.
- CONFIRMED (Chromium 143): the default-build path works end to end — native
  `Promise.try` detected, default `pdfjs-dist` + real `pdf.worker.min.mjs`
  loaded (no legacy chunk requested), all glyph steps PASS. The v125 legacy
  fallback also still passes.

**Why legacy fallback is acceptable:** pdf.js is only a verification *oracle*
(KYUTXO writes PDFs with jsPDF, never reads them). Both builds parse the byte
stream identically. Real users run modern Electron Chromium.

**Other gotchas confirmed here:**
- pdfjs-dist is NOT in the app graph, so Vite optimizes it on first runtime import
  → one full-page reload that destroys the evaluate context. It's a ONE-TIME event
  (cached in `node_modules/.vite/deps`); do NOT re-`goto` on retry (that interrupts
  the background optimize so it never settles) — retry the evaluate on the same page.

## pdf.js 6.x notes (Aug 2026)
- pdfjs-dist 6.x removed the `isEvalSupported` getDocument option — TS callers fail typecheck (drop it); plain-JS scripts passing it are harmlessly ignored.
- The 6.x legacy build + legacy worker still run fine on the Nix-pinned Chromium v125 harness and in Node vitest; no other API changes bit the glyph/sample/PoF PDF checks.
