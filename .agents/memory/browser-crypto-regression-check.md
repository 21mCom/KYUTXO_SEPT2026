---
name: Faithful browser-crypto regression checks
description: Why a browser-only Buffer/Web-Crypto crash can only be caught in a real browser, not faked in Node/jsdom, and how to wire a repeatable headless check.
---

# Catching browser-only Buffer/Web-Crypto regressions

To prove a crypto path (signature verification, etc.) runs without the Node
`Buffer` global, you MUST execute the real Vite-bundled module in a real
browser. Two tempting shortcuts both FAIL and produce false results:

1. `delete globalThis.Buffer` inside vitest/Node. In Node, dependency *Node
   builds* (bitcoinjs-lib, @bitcoinerlab/secp256k1) legitimately use the global
   `Buffer`, so deleting it makes those deps fail and the verify silently
   returns false — a false negative unrelated to our code. It also breaks
   vitest's own error serialization ("Failed to fully serialize error: Buffer
   is not defined").

2. vitest with `resolve.conditions: ['browser']` + jsdom + deleted global
   `Buffer`. Still unfaithful: it gives different results than a real browser
   (e.g. address-decode / signature-length errors and `ok=false`) because
   jsdom + Node resolution does NOT replicate Vite's dependency bundling and
   the Buffer-polyfill injection Vite does for deps that need it.

**Why it must be a real browser:** only the real Vite dev/prod bundle resolves
the browser builds AND injects the polyfills exactly as users get them, so a
reintroduced global-`Buffer` use in OUR code is the only thing that crashes.

**How to apply (repeatable, shell-runnable):**
- Factor the check into a browser-safe self-checking function that runs the real
  verify path on valid + tampered + wrong-message inputs and returns
  `{ ok, bufferGlobalPresent, steps }`. Keep the harness Buffer-free
  (Uint8Array + atob/btoa) so it never introduces the bug it guards.
- Run it two ways, both registered as validation steps:
  - Node vitest for deterministic correctness coverage.
  - A headless-Chromium runner that loads the running dev server, dynamically
    imports the module, runs the function, and fails unless
    `bufferGlobalPresent === false` AND `ok === true`.
- Headless browser without a display: install Chromium via Nix
  (`installSystemDependencies(["chromium"])`) + `playwright-core` (no browser
  download), launch with `executablePath` = `which chromium` and
  `--no-sandbox --disable-gpu --disable-dev-shm-usage`. `crypto.subtle` is
  undefined on `data:` URLs (not a secure context) but present on
  `http://localhost` (localhost is secure), so always drive the localhost page.
- The static no-Buffer source scan only checks text; it cannot prove the live
  bundled path runs Buffer-free, so it is not a substitute for the browser run.
