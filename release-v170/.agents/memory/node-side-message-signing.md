---
name: Node-side Bitcoin message signing for browser checks
description: How browser checks verify the REAL signature path when the challenge contains a per-session nonce
---

**Rule:** When a browser check needs a "Control Verified" address, don't try to pre-generate a signature — the challenge embeds a per-session nonce. Instead read the exact challenge text from the page (`textContent` of the `<pre>`), sign it in the Node script with a fixed private key, and paste the result.

**Why:** The pre-generated BIP-322 fixture (proofVerificationBrowserCheck) only works for its fixed "Hello World" message; live challenges change every session, so runtime signing is the only way to drive the real verify path end-to-end.

**How to apply:** Legacy Bitcoin Signed Message in Node: double-SHA256 of `[len]magic + varint(len) + message`, `secp256k1.sign` from `@noble/curves/secp256k1` (returns `.recovery` + 64-byte compact), header byte = `27 + recovery + 4` (compressed), base64 of header||compact. Derive the matching P2PKH address at runtime via bitcoinjs-lib so address and key never drift. Freshness-anchor UIs: block all non-localhost requests via `context.route` so the anchor fetch fails deterministically and the manual height/hash entry path surfaces. Compare PDF text with ALL whitespace stripped (pdf.js item joins + splitTextToSize wraps); containment of the full challenge string still proves exact content and line order.
