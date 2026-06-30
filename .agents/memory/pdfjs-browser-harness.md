---
name: pdf.js in the real-browser test harness
description: Why the Nix test Chromium can't run pdfjs-dist's default build, and the legacy-build workaround for browser-based PDF checks.
---

# pdf.js in the headless-Chromium test harness

When verifying PDFs in a REAL browser via the Nix `chromium` + `playwright-core`
pattern (the same one `check-proof-verify-browser.mjs` uses), do NOT load
`pdfjs-dist`'s default build.

**Symptoms (in order, each masked the next):**
- `import('pdfjs-dist')` as a raw `page.evaluate` string fails "Failed to resolve
  module specifier" — that's just because raw eval bypasses Vite's bare-import
  rewriting; import a Vite-served `/src/...ts` module instead (it gets rewritten).
- Default build throws `TypeError: Promise.try is not a function`. pdfjs-dist v5
  uses `Promise.try` (Chrome 128+); the Nix-pinned Chromium is v125. A
  `page.addInitScript` shim fixes the MAIN thread but NOT the Web Worker pdf.js
  spawns (addInitScript does not run in Worker contexts) → `UnknownErrorException`.
- Legacy build (`pdfjs-dist/legacy/build/pdf.mjs`) is transpiled (no `Promise.try`)
  AND so is its worker. But in the browser it still needs an explicit
  `GlobalWorkerOptions.workerSrc` (Node has a built-in fake worker; the browser
  does not) → "No GlobalWorkerOptions.workerSrc specified." Point it at
  `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url`.

**Resolution:** use the legacy build + legacy worker `?url` in the browser branch;
Node keeps the legacy build with its fake worker.

**Why this is acceptable:** pdf.js is only a verification *oracle* (KYUTXO writes
PDFs with jsPDF, never reads them). Both builds parse the byte stream identically,
so the legacy build still exercises the real Vite-bundled jsPDF generation path.
Real users run modern Electron Chromium, so the gap is the stale test browser, not
the product.

**How to apply:** when the harness Chromium is bumped to v128+, the default build
+ real worker becomes usable again and the `Promise.try` shim can be dropped.

**Other gotchas confirmed here:**
- pdfjs-dist is NOT in the app graph, so Vite optimizes it on first runtime import
  → one full-page reload that destroys the evaluate context. It's a ONE-TIME event
  (cached in `node_modules/.vite/deps`); do NOT re-`goto` on retry (that interrupts
  the background optimize so it never settles) — retry the evaluate on the same page.
