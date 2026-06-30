import { describe, it, expect } from 'vitest';
import {
  verifyBitcoinSignature,
  verifyBip322Simple,
  verifyBip322P2WPKH,
  verifyBip322Full,
  signatureFormatLabel,
  buildChallengeMessage,
  generateDeclarationNonce,
} from './signatureVerify';

/**
 * Authoritative BIP-322 Simple test vector from Bitcoin Core's util_tests.cpp
 * (single-key-spend P2TR address, SIGHASH_ALL flag).
 *   address: bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3
 *   message: "Hello World"
 */
const P2TR_ADDR = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3';
const P2TR_ADDR_TESTNET = 'tb1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5s3g3s37';
const HELLO_WORLD_SIG =
  'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==';

describe('BIP-322 Simple verification (Taproot)', () => {
  it('verifies the authoritative Bitcoin Core vector', async () => {
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', HELLO_WORLD_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies the testnet variant of the same key', async () => {
    const result = await verifyBip322Simple(P2TR_ADDR_TESTNET, 'Hello World', HELLO_WORLD_SIG);
    expect(result.verified).toBe(true);
  });

  it('rejects a signature against the wrong message', async () => {
    const result = await verifyBip322Simple(P2TR_ADDR, 'Goodbye World', HELLO_WORLD_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a signature against an empty message', async () => {
    const result = await verifyBip322Simple(P2TR_ADDR, '', HELLO_WORLD_SIG);
    expect(result.verified).toBe(false);
  });

  it('rejects a signature against a different Taproot address', async () => {
    const wrong = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
    const result = await verifyBip322Simple(wrong, 'Hello World', HELLO_WORLD_SIG);
    expect(result.verified).toBe(false);
  });

  it('rejects invalid base64', async () => {
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', 'not valid base64!!!@@@');
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/base64/i);
  });

  it('rejects a non-Taproot address', async () => {
    const result = await verifyBip322Simple(
      'bc1ql64jd2pewssuuehu6g7kh6ud54amq5n8t95eeq',
      'Hello World',
      HELLO_WORLD_SIG,
    );
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/Taproot|P2TR/i);
  });
});

/**
 * BIP-322 Simple test vector for a native SegWit P2WPKH (bc1q…) address.
 *
 * This uses the canonical BIP-322 reference key/address (the same fixture used
 * across the BIP-322 reference implementations and bip322-js): private key
 * WIF `L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k` →
 * address `bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l`. The signatures are
 * the deterministic (RFC-6979) BIP-322 Simple witnesses for the messages
 * "Hello World" and "" (empty) with SIGHASH_ALL, base64-encoded.
 */
const P2WPKH_BIP322_ADDR = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
const P2WPKH_BIP322_HELLO_SIG =
  'AkgwRQIhAOzyynlqt93lOKJr+wmmxIens//zPzl9tqIOua93wO6MAiBi5n5EyAcPScOjf1lAqIUIQtr3zKNeavYabHyR8eGhowEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy';
const P2WPKH_BIP322_EMPTY_SIG =
  'AkgwRQIhAPkJ1Q4oYS0htvyuSFHLxRQpFAY56b70UvE7Dxazen0ZAiAtZfFz1S6T6I23MWI2lK/pcNTWncuyL8UL+oMdydVgzAEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy';

describe('BIP-322 Simple verification (native SegWit P2WPKH)', () => {
  it('verifies a known external bc1q BIP-322 vector', async () => {
    const result = await verifyBip322P2WPKH(
      P2WPKH_BIP322_ADDR,
      'Hello World',
      P2WPKH_BIP322_HELLO_SIG,
    );
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies the empty-message vector', async () => {
    const result = await verifyBip322P2WPKH(P2WPKH_BIP322_ADDR, '', P2WPKH_BIP322_EMPTY_SIG);
    expect(result.verified).toBe(true);
  });

  it('rejects the signature against the wrong message', async () => {
    const result = await verifyBip322P2WPKH(
      P2WPKH_BIP322_ADDR,
      'Goodbye World',
      P2WPKH_BIP322_HELLO_SIG,
    );
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects the signature against a different bc1q address', async () => {
    const result = await verifyBip322P2WPKH(
      'bc1qwe7rk7w29xsfttcfrr2s35qk8w880j9vrlfkf0',
      'Hello World',
      P2WPKH_BIP322_HELLO_SIG,
    );
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/public key does not correspond/i);
  });

  it('rejects a non-P2WPKH address', async () => {
    const result = await verifyBip322P2WPKH(P2TR_ADDR, 'Hello World', P2WPKH_BIP322_HELLO_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/P2WPKH|witness v0/i);
  });

  it('rejects invalid base64', async () => {
    const result = await verifyBip322P2WPKH(P2WPKH_BIP322_ADDR, 'Hello World', 'not base64!!!@@@');
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/base64/i);
  });
});

/**
 * BIP-322 "Full" (script-path) test vectors covering the multisig vault and
 * tapscript cases that BIP-322 Simple cannot express.
 *
 * These are deterministic witnesses produced offline from fixed private keys
 * (RFC-6979 ECDSA / BIP-340 Schnorr with zero aux-rand), serialized as the
 * to_sign witness stack and base64-encoded — exactly the artefact a multisig
 * wallet (Sparrow, Electrum, Specter, etc.) exports when proving control of a
 * vault address. Verification independently re-derives the BIP-143 / BIP-341
 * sighash, re-checks the taproot commitment, and re-runs the script, so a
 * passing verify exercises the entire Full pipeline.
 */
const FULL_MSG = 'Hello World';

// P2WSH 2-of-2 multisig (OP_2 <pkA> <pkB> OP_2 OP_CHECKMULTISIG).
const P2WSH_2OF2_ADDR = 'bc1qfpchwlajc9pau0d07x70wrpnpaztq76kfax9nkd4wxa9dkp68dwsufky9g';
const P2WSH_2OF2_SIG =
  'BABHMEQCIBFFh2jDYGfAgcuZzo3HhHiRGn87fjZSI/z+W2uGEGEcAiBJpv32zgDb+7vZyxf6vnp8o7CkbRN2Jy4WpB1cu878xgFIMEUCIQDXRoPFQ7SzbYIVGWq7hANoceKbtdiiQZtmcRVWR4vqHQIgJH5LKbiKOVROPFv7t3sxxBiC3L5b0HzPxwk/81b7SXgBR1IhAtgntbsL3xs/6UNoiJwxgdLC6j0rnr1e7JlIeU5aHRb5IQJIHVIzTIoCDYEi8uGdY4IIsHtYX/Nf898lcYpzDga7y1Ku';

// P2WSH 2-of-3 multisig signed by cosigners A and C.
const P2WSH_2OF3_ADDR = 'bc1qrplxp6qgrzdv5jnh5maez84nrj6aufwy2vlt7nq8ypy7ue5fnjrsheau67';
const P2WSH_2OF3_SIG =
  'BABHMEQCIChuOtFeHwwphZvWQEmqQlvadZPK6fQc4eNCjDQNNEwGAiALZ2yT8tqUF1kT3qvQuNLOLLCtJclmhSLT7efVzXhqngFIMEUCIQD/B0aX6CwHfDdhkIXhRE0vEXXrW9LOUZ9PbPMEh4ppvQIgKXu3mfxt1m+nd6XvL7YF1OE/l9tTIqIPFIBYmzWIo0kBaVIhA0ZTI5/ClDgc9pJVSs7YIxQ3YYmtMAEkSictFyUjYLuqIQPGQoYK2gW/hgyK+xxx6PZErBrlboPBoT3BQ4trBkXKmSEDylzEGIqCMkcKCpPlABdw6fDmVUwjBGw6QaEgVr7me79Trg==';

// P2TR single-leaf script-path (<xA> OP_CHECKSIG).
const P2TR_LEAF_ADDR = 'bc1pcnljf6kcnlqvltg0fu08egg8s6hkesl4d33pss4vuydslpkam6kqxnvn7f';
const P2TR_LEAF_SIG =
  'A0A1mEkAVwneZScZ471WeokN/HeyoOHZL+bs3n+U3O2ZaqC/0N7VXErZb5+2auYT68rftiDKRYT4tSK1KtZqv2HdIiDsXbY6q+HSqka826luZyqGIC0F1tHPrZ1ga6Oyt9mDUKwhwWtnUePNDU0/a+5R0EusRiuVc/O12Sss8leylEVxdx+h';

// P2TR CHECKSIGADD 2-of-2 (<xA> OP_CHECKSIG <xB> OP_CHECKSIGADD OP_2 OP_NUMEQUAL).
const P2TR_CSA_ADDR = 'bc1pwaatmdwjh3xztpz6lew4mtawspz3akx8aq5sf66qw4r834ghe8cq683zkv';
const P2TR_CSA_SIG =
  'BEDbm8wDIesbp8yPsgrek2cpASs1w2NkZkYiXN+cKkFUkVsdGqRaxTb/tiQkePaabQpP4zQlvWhmLoXFQMQcgaIJQPr1Nn+5qvjShOlBbkc5CfOv+6sdMe3PBz+X0yo0HPbfuBwqaPr9S3r8rrZWNTu7wUQ0Se8BvjLVBLs0ScmdH0FGIA1jpSluz0Or686GWTNsukRa9xg4yqVHjl3gzW3apxBErCC9dva6y8sp/lTRYJbYIVbZzSBbxZmpxwCl4IvQgbRxxLpSnCHBfXjJA59OcnFVwi7dLG509eKJ2aaR4751bva53LqRN0A=';

describe('BIP-322 Full verification (P2WSH multisig)', () => {
  it('verifies a 2-of-2 P2WSH multisig script-path signature', async () => {
    const result = await verifyBip322Full(P2WSH_2OF2_ADDR, FULL_MSG, P2WSH_2OF2_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies a 2-of-3 P2WSH multisig (signed by two of three cosigners)', async () => {
    const result = await verifyBip322Full(P2WSH_2OF3_ADDR, FULL_MSG, P2WSH_2OF3_SIG);
    expect(result.verified).toBe(true);
  });

  it('rejects a multisig signature against the wrong message', async () => {
    const result = await verifyBip322Full(P2WSH_2OF2_ADDR, 'Goodbye World', P2WSH_2OF2_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a multisig signature against a different P2WSH address', async () => {
    const result = await verifyBip322Full(P2WSH_2OF3_ADDR, FULL_MSG, P2WSH_2OF2_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/witness script does not hash/i);
  });

  it('rejects invalid base64', async () => {
    const result = await verifyBip322Full(P2WSH_2OF2_ADDR, FULL_MSG, 'not base64!!!@@@');
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/base64/i);
  });
});

describe('BIP-322 Full verification (Taproot script-path)', () => {
  it('verifies a single-leaf P2TR script-path signature', async () => {
    const result = await verifyBip322Full(P2TR_LEAF_ADDR, FULL_MSG, P2TR_LEAF_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies a CHECKSIGADD 2-of-2 tapscript multisig signature', async () => {
    const result = await verifyBip322Full(P2TR_CSA_ADDR, FULL_MSG, P2TR_CSA_SIG);
    expect(result.verified).toBe(true);
  });

  it('rejects a tapscript signature against the wrong message', async () => {
    const result = await verifyBip322Full(P2TR_LEAF_ADDR, 'Goodbye World', P2TR_LEAF_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects when the control block does not commit to the address', async () => {
    const result = await verifyBip322Full(P2TR_CSA_ADDR, FULL_MSG, P2TR_LEAF_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/control block does not commit/i);
  });
});

describe('verifyBitcoinSignature routing (BIP-322 Full)', () => {
  it('routes a P2WSH (bc1q 32-byte) address to the Full verifier', async () => {
    const result = await verifyBitcoinSignature(P2WSH_2OF2_ADDR, FULL_MSG, P2WSH_2OF2_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('routes a Taproot script-path witness through the Simple entry point', async () => {
    const result = await verifyBitcoinSignature(P2TR_LEAF_ADDR, FULL_MSG, P2TR_LEAF_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifyBip322Simple delegates a multi-item Taproot witness to Full', async () => {
    const result = await verifyBip322Simple(P2TR_CSA_ADDR, FULL_MSG, P2TR_CSA_SIG);
    expect(result.verified).toBe(true);
  });
});

describe('verifyBitcoinSignature routing', () => {
  it('routes Taproot addresses to the BIP-322 path', async () => {
    const result = await verifyBitcoinSignature(P2TR_ADDR, 'Hello World', HELLO_WORLD_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('routes a bc1q BIP-322 witness to the BIP-322 P2WPKH path', async () => {
    const result = await verifyBitcoinSignature(
      P2WPKH_BIP322_ADDR,
      'Hello World',
      P2WPKH_BIP322_HELLO_SIG,
    );
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('still verifies a legacy BIP-137 signature for a bc1q address (fallback)', async () => {
    const result = await verifyBitcoinSignature(VEC2.p2wpkh, MESSAGE, VEC2.sig);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('legacy');
  });

  it('requires all three inputs', async () => {
    const result = await verifyBitcoinSignature('', 'msg', 'sig');
    expect(result.verified).toBe(false);
  });
});

describe('signatureFormatLabel', () => {
  it('labels BIP-322 and legacy formats', () => {
    expect(signatureFormatLabel('bip322')).toMatch(/BIP-322/);
    expect(signatureFormatLabel('legacy')).toMatch(/Bitcoin Signed Message/);
  });
});

/**
 * End-to-end signature-verification vectors.
 *
 * These are genuine "Bitcoin Signed Message" (BSM) signatures — the exact
 * standardized format produced by Electrum, Bitcoin Core, Sparrow, Trezor,
 * Ledger, etc. They were produced by signing `MESSAGE` with two fixed test
 * keys over the canonical magic hash
 * (double-SHA256 of varint(magic)+magic+varint(msg)+msg), then prefixing the
 * recovery+compressed header byte (27 + recoveryId + 4).
 *
 * The magic-hash construction in signatureVerify.ts was independently
 * cross-checked, byte-for-byte, against a separate canonical implementation
 * (including the long-message 3-byte varint path), so a passing verify here
 * exercises the full real-wallet pipeline: base64 decode → header parse →
 * Web Crypto SHA-256d → @bitcoinerlab/secp256k1 recover → bitcoinjs-lib
 * address derivation.
 */
const MESSAGE = "I certify that I control the following Bitcoin address.";

const VEC1 = {
  sig: "H72VK8HyRDe4nk1xkYqVSYYCsHnIW0vWAHwepHY9NbX8XDuRBu+d01+7LiWh5DAvvo0rm8Mt7mcby6BDsnYvAAw=",
  p2pkh: "1EgNtna8ohPPfDu3AJKCg6tMuP9rqTnQnL",
  p2wpkh: "bc1qjcxzyzqj2u3mgrt0m8wzgcee0n4u3592ehm4gt",
  p2sh: "3Bn49vExQ5BGF7dMQ7A3PewhxzGAQEwzqy",
};

const VEC2 = {
  sig: "IIxtBxuNMtMv+9gSBmfkRFo9NrgfyOlw8cVSJhg0eT6NClVBzBhGGzxhbkqYXktBs+V7ATt/2/Afm+GHQrBmscI=",
  p2pkh: "1BoVZT4nxZR52omiEk8JmFHQfgDdptPCXq",
  p2wpkh: "bc1qwe7rk7w29xsfttcfrr2s35qk8w880j9vrlfkf0",
  p2sh: "32CAx5WEnyQoNBNRATDSvcfKGvkvJRcWBr",
};

function mutateHeader(sigBase64: string, newHeader: number): string {
  const bin = atob(sigBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  bytes[0] = newHeader;
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return btoa(out);
}

describe("verifyBitcoinSignature — valid signatures", () => {
  it("verifies a P2PKH (1…) address against its matching signature", async () => {
    const res = await verifyBitcoinSignature(VEC1.p2pkh, MESSAGE, VEC1.sig);
    expect(res.verified).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("verifies a native SegWit P2WPKH (bc1q…) address", async () => {
    const res = await verifyBitcoinSignature(VEC2.p2wpkh, MESSAGE, VEC2.sig);
    expect(res.verified).toBe(true);
  });

  it("verifies a P2SH-P2WPKH (3…) address from the same compressed key", async () => {
    const res = await verifyBitcoinSignature(VEC1.p2sh, MESSAGE, VEC1.sig);
    expect(res.verified).toBe(true);
  });

  it("accepts all three address forms derived from one compressed key", async () => {
    for (const addr of [VEC2.p2pkh, VEC2.p2wpkh, VEC2.p2sh]) {
      const res = await verifyBitcoinSignature(addr, MESSAGE, VEC2.sig);
      expect(res.verified).toBe(true);
    }
  });
});

describe("verifyBitcoinSignature — rejects bad input clearly", () => {
  it("rejects a valid signature against the wrong address (no silent pass)", async () => {
    const res = await verifyBitcoinSignature(VEC2.p2pkh, MESSAGE, VEC1.sig);
    expect(res.verified).toBe(false);
    expect(res.error).toMatch(/not produced by the key controlling this address/i);
  });

  it("rejects when the signed message has been tampered with", async () => {
    const res = await verifyBitcoinSignature(VEC1.p2pkh, MESSAGE + " (edited)", VEC1.sig);
    expect(res.verified).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("requires all three fields", async () => {
    const res = await verifyBitcoinSignature("", MESSAGE, VEC1.sig);
    expect(res.verified).toBe(false);
    expect(res.error).toMatch(/required/i);
  });

  it("reports a clear error for a signature of the wrong length", async () => {
    const res = await verifyBitcoinSignature(VEC1.p2pkh, MESSAGE, "AAAA");
    expect(res.verified).toBe(false);
    expect(res.error).toMatch(/length/i);
  });

  it("reports an unrecognised header byte", async () => {
    const res = await verifyBitcoinSignature(VEC1.p2pkh, MESSAGE, mutateHeader(VEC1.sig, 10));
    expect(res.verified).toBe(false);
    expect(res.error).toMatch(/header/i);
  });

  it("fails closed (no crash) on a structurally-valid but corrupt signature", async () => {
    const corrupt = btoa(String.fromCharCode(31, ...new Array(64).fill(0)));
    const res = await verifyBitcoinSignature(VEC1.p2pkh, MESSAGE, corrupt);
    expect(res.verified).toBe(false);
    expect(typeof res.error).toBe("string");
  });
});

describe("challenge message helpers", () => {
  it("builds a deterministic challenge embedding the address and nonce", () => {
    const msg = buildChallengeMessage({
      address: VEC1.p2pkh,
      declarantName: "Alice",
      declarationDate: "2026-06-30",
      purpose: "Mortgage application",
      nonce: "deadbeefcafe0001",
    });
    expect(msg).toContain(VEC1.p2pkh);
    expect(msg).toContain("deadbeefcafe0001");
    expect(msg).toContain("Alice");
  });

  it("generates a 16-char hex nonce", () => {
    const nonce = generateDeclarationNonce();
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(generateDeclarationNonce()).not.toBe(nonce);
  });
});
