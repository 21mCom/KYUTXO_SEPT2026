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
  directly and the package tool installs from the same channel, so the harness
  browser can't be bumped from inside a task — the feature detection makes the
  full-fidelity path activate automatically once it is.

**Why legacy fallback is acceptable:** pdf.js is only a verification *oracle*
(KYUTXO writes PDFs with jsPDF, never reads them). Both builds parse the byte
stream identically. Real users run modern Electron Chromium.

**Other gotchas confirmed here:**
- pdfjs-dist is NOT in the app graph, so Vite optimizes it on first runtime import
  → one full-page reload that destroys the evaluate context. It's a ONE-TIME event
  (cached in `node_modules/.vite/deps`); do NOT re-`goto` on retry (that interrupts
  the background optimize so it never settles) — retry the evaluate on the same page.
