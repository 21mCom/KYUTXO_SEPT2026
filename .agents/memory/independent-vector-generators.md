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
- The SegWit v2 + P2SH-wrapped independent vectors ARE covered: `scripts/proof-vectors/generate_segwit_v2_independent.py` (seed `"vault-independent-segwit-v2-vector-key"`, RFC-6979 deterministic ECDSA) reproduces all four constants byte-for-byte; verified 2026-08-05.
- Still exposed: the EXT_* "external independent vectors" (P2WSH 2-of-2/2-of-3 multisig, P2TR leaf/CSA/multi-leaf) in signatureVerify.test.ts have NO committed generator; their keys may be unrecoverable throwaways.
