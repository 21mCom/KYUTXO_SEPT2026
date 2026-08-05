---
name: Independent proof-vector generators
description: How the BIP-322 independent test vectors are generated/reproduced; pitfalls when re-deriving committed signature vectors
---

# Independent proof-vector generators

Committed generator: `scripts/generate-bip322-independent-vectors.py` (pure Python, no crypto deps) reproduces the Taproot annex + v2 vectors in `signatureVerify.test.ts` byte-for-byte.

Rules / lessons:
- Any new "independently generated" vector MUST land together with its deterministic generator (seed-string keys + BIP-340 aux_rand = 32 zero bytes). Never sign with throwaway/random keys.
- **Why:** earlier vectors were made by uncommitted throwaway scripts; recovering their keys required brute-forcing seed strings, and one key (original key-path v2) was never recovered — that vector had to be regenerated and replaced.
- Seed-string conventions found in this repo: `"kyutxo-annex-internal-key"`, `"kyutxo keypath annex vector seed"`, `"kyutxo v2 taproot scriptpath internal key"` — sha256(seed) mod n.
- When a re-derived sig mismatches, check WHICH message the test passes (some vectors sign EXT_MSG "I certify that I control…", not "Hello World") before suspecting the nonce.
- The app verifier tries to_sign nVersion 0 AND 2 (fallback loop), so a "passing" vector doesn't tell you which version it committed to.
- Same exposure likely exists for the SegWit v2 / wrapped-multisig independent vectors added by sibling tasks; extend the same generator rather than new throwaway scripts.
