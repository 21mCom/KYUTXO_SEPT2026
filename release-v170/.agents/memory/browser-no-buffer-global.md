---
name: Browser code must avoid the Node Buffer global
description: Why client/src crypto code that passes Node unit tests can still crash in the browser, and how to write it portably.
---

# Browser code must not rely on the Node `Buffer` global

This app's Vite bundle does **not** polyfill the Node `Buffer` global, and there
is no `import { Buffer } from 'buffer'` anywhere in the client. Any `client/src`
module that runs in the browser and uses `Buffer.from(...)` / `Buffer.alloc` /
`Buffer.concat` will throw `Buffer is not defined` at runtime.

**Why this is a trap:** vitest runs in the Node environment where `Buffer` is a
global, so unit tests pass green while the same code crashes in a real browser.
A `try/catch` around the call surfaces it only as a confusing generic error
(e.g. "Verification failed unexpectedly: Buffer is not defined").

**How to apply:**
- In browser code, prefer `Uint8Array` end to end. `bitcoinjs-lib` v7 and
  `@bitcoinerlab/secp256k1` already accept/return `Uint8Array` — pass the
  `Uint8Array` straight into `bitcoin.payments.p2*({ pubkey })`; do **not**
  wrap it in `Buffer.from(...)`. (`xpub.ts` is the correct reference pattern:
  it passes `child.publicKey` directly.)
- Need base64? Use `atob`/`btoa` + manual byte loops (see `signatureVerify.ts`)
  or the existing `base64ToBuffer` helper in `crypto.ts` (returns `Uint8Array`).
- To catch this class of bug, verify crypto paths in a **real browser**
  (testing skill + a console `await import('/src/lib/<mod>.ts')` snippet), not
  just vitest. The dev server serves source at `/src/...` (Vite root = `client/`).
