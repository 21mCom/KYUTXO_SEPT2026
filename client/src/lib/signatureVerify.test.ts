import { describe, it, expect } from 'vitest';
import {
  verifyBitcoinSignature,
  verifyBip322Simple,
  verifyBip322P2WPKH,
  verifyBip322Full,
  verifyBip322P2SH,
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
 * Malformed / tampered witness-stack cases for verifyBip322Simple.
 *
 * The base64 decodes fine but the serialized witness stack itself is broken,
 * or the single Schnorr signature item is tampered/mis-sized. Every case must
 * fail closed with a clear string error — never crash, never verify.
 */
describe('BIP-322 Simple — malformed and tampered witnesses (Taproot)', () => {
  // The authoritative vector's stack: [65-byte Schnorr sig (64 + SIGHASH_ALL)].
  const helloItems = () => splitWitness(HELLO_WORLD_SIG);

  it('rejects an empty witness stack (zero items)', async () => {
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', joinWitness([]));
    expect(result.verified).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('rejects a truncated witness (item length exceeds available data)', async () => {
    const bytes = b64ToBytes(HELLO_WORLD_SIG);
    const truncated = bytes.subarray(0, bytes.length - 10);
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', bytesToB64(truncated));
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/witness/i);
  });

  it('rejects trailing garbage bytes after the witness stack', async () => {
    const bytes = b64ToBytes(HELLO_WORLD_SIG);
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 0);
    padded.set([0xde, 0xad, 0xbe, 0xef], bytes.length);
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', bytesToB64(padded));
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/witness/i);
  });

  it('rejects a bit-flipped Schnorr signature (tampered witness)', async () => {
    const [sig] = helloItems();
    const bad = flipByte(sig, 10);
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', joinWitness([bad]));
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });

  it('rejects a signature of unexpected length (63 bytes)', async () => {
    const [sig] = helloItems();
    const short = sig.subarray(0, 63);
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', joinWitness([short]));
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/length/i);
  });

  it('rejects when the sighash-type byte is altered (sighash binding)', async () => {
    // The 65th byte (SIGHASH_ALL = 0x01) participates in the sighash the
    // Schnorr signature commits to; changing it to SIGHASH_NONE must fail.
    const [sig] = helloItems();
    const mutated = sig.slice();
    mutated[64] = 0x02; // SIGHASH_NONE
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', joinWitness([mutated]));
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('fails gracefully on a multi-item witness that is not a valid Full spend', async () => {
    // Two copies of the key-path signature form a bogus "script-path" stack;
    // the Full verifier must reject it with a clear error, not crash.
    const [sig] = helloItems();
    const result = await verifyBip322Simple(
      P2TR_ADDR,
      'Hello World',
      joinWitness([sig, sig]),
    );
    expect(result.verified).toBe(false);
    expect(typeof result.error).toBe('string');
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

/**
 * Taproot script-path witness carrying a BIP-341 ANNEX (leading 0x50 item).
 *
 * The annex is the last witness-stack item; when present it participates in
 * the BIP-341 sighash via sha_annex, so the verifier must both detect it
 * (peel it off before locating the control block / leaf script) and feed it
 * into the sighash. This vector was generated by an INDEPENDENT pure-Python
 * BIP-340/341/342 reference-style implementation (point arithmetic, tagged
 * hashes, taproot tweak, BIP-322 to_spend/to_sign, and the annex-aware
 * script-path sighash all hand-written — no bitcoinjs-lib / noble code), so a
 * passing verify proves annex handling agrees with an external
 * implementation. The witness stack is
 * [64-byte Schnorr sig (SIGHASH_DEFAULT), leaf script, control block, annex],
 * annex = 0x50 || "kyutxo annex test vector".
 */
const P2TR_ANNEX_ADDR = 'bc1pmwz5hs7aar3r8d4mgzzsz20rxsgykhal3e79mpvs43um9fz28zfqy9e44x';
const P2TR_ANNEX_SIG =
  'BEAz61jegCjGU9ZgSvlBsFwAF7kxgjKEHsVvd5IQVWkhbzVsVIxNhV+v2EVWn7xJdNgChQ7Q3t3vgkgQd1lhQs7JIiChGt5CBUOD2ZkjpdEbVXdSDJxje9gAwgo43TC5D9QfFqwhwBO5exbdJ0AP3yLZUQDpHjznziYp68dWZ/dq5Fob/Sh7GVBreXV0eG8gYW5uZXggdGVzdCB2ZWN0b3I=';
// Same signature but with the annex item removed from the stack — the sig
// committed to sha_annex, so verification must fail.
const P2TR_ANNEX_STRIPPED_SIG =
  'A0Az61jegCjGU9ZgSvlBsFwAF7kxgjKEHsVvd5IQVWkhbzVsVIxNhV+v2EVWn7xJdNgChQ7Q3t3vgkgQd1lhQs7JIiChGt5CBUOD2ZkjpdEbVXdSDJxje9gAwgo43TC5D9QfFqwhwBO5exbdJ0AP3yLZUQDpHjznziYp68dWZ/dq5Fob/Sh7';
// Same stack but with one payload byte of the annex flipped.
const P2TR_ANNEX_ALTERED_SIG =
  'BEAz61jegCjGU9ZgSvlBsFwAF7kxgjKEHsVvd5IQVWkhbzVsVIxNhV+v2EVWn7xJdNgChQ7Q3t3vgkgQd1lhQs7JIiChGt5CBUOD2ZkjpdEbVXdSDJxje9gAwgo43TC5D9QfFqwhwBO5exbdJ0AP3yLZUQDpHjznziYp68dWZ/dq5Fob/Sh7GVBreXV0eW8gYW5uZXggdGVzdCB2ZWN0b3I=';

/**
 * Taproot KEY-PATH witness carrying a BIP-341 ANNEX: [schnorr sig, annex].
 *
 * When a key-path witness has the annex as its last item, the annex must be
 * peeled off (keeping the spend on the key-path route) and fed into the
 * BIP-341 sighash via sha_annex (spend_type annex bit). These vectors were
 * generated by an INDEPENDENT pure-Python BIP-340/341 reference-style
 * implementation (hand-written point arithmetic, tagged hashes, taproot
 * tweak, BIP-322 to_spend/to_sign, and the annex-aware key-path sighash — no
 * bitcoinjs-lib / noble code), so a passing verify proves annex handling
 * agrees with an external implementation.
 * annex = 0x50 || "kyutxo keypath annex vector".
 */
const P2TR_KEYPATH_ANNEX_ADDR =
  'bc1pddrn4apn0qt2j5cjfr6c33cttsx09pc8kdlm6nlh3yapwws4dpgq98vxan';
// [64-byte Schnorr sig (SIGHASH_DEFAULT), annex]
const P2TR_KEYPATH_ANNEX_SIG =
  'AkB0LAZp8vfFceQJjuzSUFIrAQ0Bx/xMCaGLit27LpKGQ3XRwffFKX3Bn6535GjlfoWG9jWpRWECe83msMERysNmHFBreXV0eG8ga2V5cGF0aCBhbm5leCB2ZWN0b3I=';
// Same signature with the annex removed — the sig committed to sha_annex.
const P2TR_KEYPATH_ANNEX_STRIPPED_SIG =
  'AUB0LAZp8vfFceQJjuzSUFIrAQ0Bx/xMCaGLit27LpKGQ3XRwffFKX3Bn6535GjlfoWG9jWpRWECe83msMERysNm';
// Same stack with one payload byte of the annex flipped.
const P2TR_KEYPATH_ANNEX_ALTERED_SIG =
  'AkB0LAZp8vfFceQJjuzSUFIrAQ0Bx/xMCaGLit27LpKGQ3XRwffFKX3Bn6535GjlfoWG9jWpRWECe83msMERysNmHFBreXV0eW8ga2V5cGF0aCBhbm5leCB2ZWN0b3I=';
// [65-byte sig (64 + SIGHASH_ALL flag byte), annex] for the same key/annex.
const P2TR_KEYPATH_ANNEX_ALL_SIG =
  'AkHeq3N1PN9KoBrkKKO9RiY4bP/i49YU0FnsRSh2mqZQ0b0F6QsuGOgpM7z7LqdyoTcEpbYMu66KY8moVmc5e79AARxQa3l1dHhvIGtleXBhdGggYW5uZXggdmVjdG9y';

describe('BIP-322 Simple verification (Taproot key-path with annex)', () => {
  it('verifies an independently generated key-path witness that carries an annex', async () => {
    const result = await verifyBip322Simple(
      P2TR_KEYPATH_ANNEX_ADDR,
      'Hello World',
      P2TR_KEYPATH_ANNEX_SIG,
    );
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies the 65-byte SIGHASH_ALL variant with an annex', async () => {
    const result = await verifyBip322Simple(
      P2TR_KEYPATH_ANNEX_ADDR,
      'Hello World',
      P2TR_KEYPATH_ANNEX_ALL_SIG,
    );
    expect(result.verified).toBe(true);
  });

  it('routes the annex-carrying key-path witness through verifyBitcoinSignature', async () => {
    const result = await verifyBitcoinSignature(
      P2TR_KEYPATH_ANNEX_ADDR,
      'Hello World',
      P2TR_KEYPATH_ANNEX_SIG,
    );
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('rejects the witness when the annex is stripped (sig committed to sha_annex)', async () => {
    const result = await verifyBip322Simple(
      P2TR_KEYPATH_ANNEX_ADDR,
      'Hello World',
      P2TR_KEYPATH_ANNEX_STRIPPED_SIG,
    );
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });

  it('rejects the witness when an annex byte is altered', async () => {
    const result = await verifyBip322Simple(
      P2TR_KEYPATH_ANNEX_ADDR,
      'Hello World',
      P2TR_KEYPATH_ANNEX_ALTERED_SIG,
    );
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });

  it('rejects the annex-carrying signature against the wrong message', async () => {
    const result = await verifyBip322Simple(
      P2TR_KEYPATH_ANNEX_ADDR,
      'Goodbye World',
      P2TR_KEYPATH_ANNEX_SIG,
    );
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects the annex-carrying signature against a different Taproot address', async () => {
    const result = await verifyBip322Simple(P2TR_ADDR, 'Hello World', P2TR_KEYPATH_ANNEX_SIG);
    expect(result.verified).toBe(false);
  });

  it('still rejects the plain vector when a bogus annex is appended (sig did not commit to it)', async () => {
    // The authoritative Bitcoin Core key-path vector was signed WITHOUT an
    // annex; appending one changes the sighash, so it must fail — but on the
    // key-path route with a verify error, not a script-path parse error.
    const [sig] = splitWitness(HELLO_WORLD_SIG);
    const annex = new Uint8Array([0x50, 0x01, 0x02, 0x03]);
    const result = await verifyBip322Simple(
      P2TR_ADDR,
      'Hello World',
      joinWitness([sig, annex]),
    );
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });
});

describe('BIP-322 Full verification (Taproot script-path with annex)', () => {
  it('verifies an independently generated script-path witness that carries an annex', async () => {
    const result = await verifyBip322Full(P2TR_ANNEX_ADDR, EXT_MSG, P2TR_ANNEX_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('routes the annex-carrying witness through verifyBitcoinSignature', async () => {
    const result = await verifyBitcoinSignature(P2TR_ANNEX_ADDR, EXT_MSG, P2TR_ANNEX_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('rejects the witness when the annex is stripped (sig committed to sha_annex)', async () => {
    const result = await verifyBip322Full(P2TR_ANNEX_ADDR, EXT_MSG, P2TR_ANNEX_STRIPPED_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });

  it('rejects the witness when an annex byte is altered', async () => {
    const result = await verifyBip322Full(P2TR_ANNEX_ADDR, EXT_MSG, P2TR_ANNEX_ALTERED_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });

  it('rejects the annex-carrying signature against the wrong message', async () => {
    const result = await verifyBip322Full(P2TR_ANNEX_ADDR, FULL_MSG, P2TR_ANNEX_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

/**
 * BIP-322 "Full" vectors for P2SH-wrapped SegWit multisig (P2SH-P2WSH, the
 * legacy "3…" form used by older multisig vaults before native bech32 became
 * common). These are deterministic witnesses produced offline from fixed
 * private keys, serialized as the to_sign witness stack and base64-encoded —
 * exactly the artefact a wrapped-multisig wallet exports. Verification
 * independently rebuilds the BIP-322 to_spend/to_sign with the P2SH
 * scriptPubKey, confirms hash160(redeemScript) matches the address, re-derives
 * the BIP-143 sighash, and re-runs the multisig script.
 */
const P2SH_P2WSH_2OF2_ADDR = '3GKSstjZTsY2XfdxbzDtWTJJEw4B4918PY';
const P2SH_P2WSH_2OF2_SIG =
  'BABIMEUCIQCadTCxF4nxWc3SUPxswQANiHXbElgvkdWBCwUxGf3xfgIgBA9b/XFCIH2+rqWUXv53UolAR2rxfAHc0IdUHma8meoBSDBFAiEA8GtfmPQfcFLZRRHzPHISGVvrzeCGtM2yHpoAcl7TlHMCIBId6VTsTZ+cElN8SdhCiNa+iIX8diqxLMEEeX6Ih/KeAUdSIQNPNVvct8wK9yjvPM65YV2QaEu1sspfhZqw8LcEB1hxqiECRm1/yuVj5csJoNGHC7WANEgEYXh5oUlJzyIoXxuuPydSrg==';

const P2SH_P2WSH_2OF3_ADDR = '3Fb8YstDgknYfB3hHVvNv5YckPJREWg6k4';
const P2SH_P2WSH_2OF3_SIG =
  'BABIMEUCIQCggqw56AMHc1lP0f5UaRBAfpn7TgQ+xiYE67R9vG0DMAIgf7+74GcO/IelJSgA9203iKl35Y2dua24+YQ8Pfk8iZcBSDBFAiEAlen4NupPDjxdlJQ9gxithLMNFZpV71CvYz+pen0j1KgCIG2kCzm9otoQZgiIHQ1jBUsrCWq2SXU+9sPL0mvaYgyJAWlSIQNPNVvct8wK9yjvPM65YV2QaEu1sspfhZqw8LcEB1hxqiECRm1/yuVj5csJoNGHC7WANEgEYXh5oUlJzyIoXxuuPychAjxyrdtP3wmvlPDJTX/pKjhqfnDPih2FkWOGuyU1x7GxU64=';

describe('BIP-322 Full verification (P2SH-wrapped multisig)', () => {
  it('verifies a 2-of-2 P2SH-P2WSH multisig script-path signature', async () => {
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, FULL_MSG, P2SH_P2WSH_2OF2_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies a 2-of-3 P2SH-P2WSH multisig (signed by two of three cosigners)', async () => {
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF3_ADDR, FULL_MSG, P2SH_P2WSH_2OF3_SIG);
    expect(result.verified).toBe(true);
  });

  it('rejects a wrapped-multisig signature against the wrong message', async () => {
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, 'Goodbye World', P2SH_P2WSH_2OF2_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a wrapped-multisig signature against a different P2SH address', async () => {
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF3_ADDR, FULL_MSG, P2SH_P2WSH_2OF2_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/does not correspond|not supported/i);
  });

  it('rejects a wrapped single-key proof carrying a 65-byte uncompressed public key', async () => {
    // Reuse the DER signature from the P2WPKH BIP-322 vector and pair it with
    // a 65-byte uncompressed-form (0x04-prefixed) public key — the witness
    // shape a mistaken tool would produce. P2SH-P2WPKH is only defined for
    // compressed keys, so this must fail closed with an error that names the
    // compressed-key requirement (never crash, never verify).
    const [derSig] = splitWitness(P2WPKH_BIP322_HELLO_SIG);
    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed[1] = 0xc7; // arbitrary non-zero coordinate bytes
    uncompressed[64] = 0x72;
    const result = await verifyBip322P2SH(
      P2SH_P2WSH_2OF2_ADDR,
      FULL_MSG,
      joinWitness([derSig, uncompressed]),
    );
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/uncompressed/i);
    expect(result.error).toMatch(/33-byte compressed/i);
  });

  it('rejects a non-P2SH address', async () => {
    const result = await verifyBip322P2SH(P2WSH_2OF2_ADDR, FULL_MSG, P2SH_P2WSH_2OF2_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/P2SH/i);
  });

  it('rejects invalid base64', async () => {
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, FULL_MSG, 'not base64!!!@@@');
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/base64/i);
  });

  it('routes a P2SH BIP-322 witness through verifyBitcoinSignature', async () => {
    const result = await verifyBitcoinSignature(P2SH_P2WSH_2OF2_ADDR, FULL_MSG, P2SH_P2WSH_2OF2_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('still verifies a legacy 65-byte signature for a P2SH-P2WPKH address (fallback)', async () => {
    const result = await verifyBitcoinSignature(VEC1.p2sh, MESSAGE, VEC1.sig);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('legacy');
  });
});

/**
 * BIP-322 vectors for BARE (pre-SegWit) P2SH multisig — the raw
 * `OP_m <pubkeys…> OP_n OP_CHECKMULTISIG` redeem script hashed directly into
 * a "3…" address, spent through a legacy scriptSig with no witness. These
 * proofs carry the legacy-format artefact: either a stack container
 * ([dummy, sigs…, redeemScript]) or the full serialized BIP-322 to_sign
 * transaction whose scriptSig holds the same pushes. Signatures are
 * deterministic (RFC-6979) ECDSA over the legacy (pre-BIP-143) sighash with
 * the redeem script as scriptCode.
 */
const BARE_P2SH_2OF2_ADDR = '37mwvhnNzuu6Tm4MwDMmi1imo5ru3QMYrZ';
const BARE_P2SH_2OF2_STACK_SIG =
  'BABIMEUCIQDgcLHjoaAdGs+M315lDVo+TbFcFkB/cCfmHN7/LfFVUAIgRZGM/aeIRnpUOtaG0RiNrkbD6llhbKUgXsQNy2dr3/EBRzBEAiA8ZMUuz1h6UbWmWNHozVt3MH+2aSl1o+ILLLh3Hjgw+gIgQyjjt6NQ+S2HM3lXUCYn+MRwF0jxBwLqi6sX0vbyAeYBR1IhA9796kzbZ3dQpCD+6AfqzyHrmJiuebl2h2bk+qBKLUo0IQJWAVcMtH8jjSsChttKmQ+g87oo0aMZ9efPVcKiRE2nzFKu';
const BARE_P2SH_2OF2_TX_SIG =
  'AAAAAAHXHxN3iSLIntt7AeRyixEvp4hd9USKhgZ2+0UMfz6lcAAAAADaAEgwRQIhAOBwseOhoB0az4zfXmUNWj5NsVwWQH9wJ+Yc3v8t8VVQAiBFkYz9p4hGelQ61obRGI2uRsPqWWFspSBexA3LZ2vf8QFHMEQCIDxkxS7PWHpRtaZY0ejNW3cwf7ZpKXWj4gssuHceODD6AiBDKOO3o1D5LYczeVdQJif4xHAXSPEHAuqLqxfS9vIB5gFHUiED3v3qTNtnd1CkIP7oB+rPIeuYmK55uXaHZuT6oEotSjQhAlYBVwy0fyONKwKG20qZD6DzuijRoxn1589VwqJETafMUq4AAAAAAQAAAAAAAAAAAWoAAAAA';

const BARE_P2SH_2OF3_ADDR = '33tZmFdJAqDKaZ43WvyYSQrGaHUxz3zKpK';
const BARE_P2SH_2OF3_STACK_SIG =
  'BABHMEQCICcl+YcN2BfIMzdrAlb1oiQk5GzzqETYN7Ge/7olk4w5AiABPpMIu4SneSYwSuwBcwIHunfvceERaqRKxjCE5rL3SwFIMEUCIQD6VI8Z+i38ggFABa18/YSqJVY/K1Kq7PhIf63B727/8gIgNqHI5+B/wLSYfI6inkNkMO4KmuN/wtYeSvnDQEzWBHIBaVIhA9796kzbZ3dQpCD+6AfqzyHrmJiuebl2h2bk+qBKLUo0IQJWAVcMtH8jjSsChttKmQ+g87oo0aMZ9efPVcKiRE2nzCECK06gp5ekQ9KT71z/RE9JefBqz+vX6G0ndHVlYTg4W2xTrg==';
const BARE_P2SH_2OF3_TX_SIG =
  'AAAAAAFxr/qnPauOAuQd90YhAeABWOEFVQN7gEAsWjsZbbC8fAAAAAD9/QAARzBEAiAnJfmHDdgXyDM3awJW9aIkJORs86hE2Dexnv+6JZOMOQIgAT6TCLuEp3kmMErsAXMCB7p373HhEWqkSsYwhOay90sBSDBFAiEA+lSPGfot/IIBQAWtfP2EqiVWPytSquz4SH+twe9u//ICIDahyOfgf8C0mHyOop5DZDDuCprjf8LWHkr5w0BM1gRyAUxpUiED3v3qTNtnd1CkIP7oB+rPIeuYmK55uXaHZuT6oEotSjQhAlYBVwy0fyONKwKG20qZD6DzuijRoxn1589VwqJETafMIQIrTqCnl6RD0pPvXP9ET0l58GrP69fobSd0dWVhODhbbFOuAAAAAAEAAAAAAAAAAAFqAAAAAA==';

/**
 * Bare P2SH 2-of-2 vector whose signatures commit to a VERSION-2 to_sign
 * transaction. BIP-322 permits the virtual to_sign to carry nVersion 0 or 2,
 * and some legacy wallet tooling emits v2. Produced deterministically offline
 * from fixed keys, both as the raw stack container and as the serialized v2
 * to_sign transaction.
 */
const BARE_P2SH_V2_ADDR = '3QaPLKWhH6Ya8Vs8jNLn24PwLku3pcBVdX';
const BARE_P2SH_V2_STACK_SIG =
  'BABIMEUCIQCMts29giEhlMpUFkZyLoZs0/55pX7/kFg2fnmVJK9JowIgFT7rLXaCO60MlQagK6osSTDIyHZfMKQrg/k7QLDmFxgBSDBFAiEAjw3lcH7JmxMxeFG4VJrLbMdEgcIK6tfwYLBtTdMi76cCIFwR9YzXDs2y0nuD3ufQ66Nl1uRbTV7YL3Qpg2I4uJtcAUdSIQN6Kd+0JvMup1/v/xrdIeuy48LYMhP7UxyWGOAEOJpWwiEDr5RcqgcjtS5AB47aJ+TAs2ePeF3j7LOosGkgTosjePBSrg==';
const BARE_P2SH_V2_TX_SIG =
  'AgAAAAF5BXXu7+6SUHew36ZtM3MKgq45VapW+ZfUAXhV+w+/jwAAAADbAEgwRQIhAIy2zb2CISGUylQWRnIuhmzT/nmlfv+QWDZ+eZUkr0mjAiAVPustdoI7rQyVBqArqixJMMjIdl8wpCuD+TtAsOYXGAFIMEUCIQCPDeVwfsmbEzF4UbhUmstsx0SBwgrq1/BgsG1N0yLvpwIgXBH1jNcOzbLSe4Pe59Dro2XW5FtNXtgvdCmDYji4m1wBR1IhA3op37Qm8y6nX+//Gt0h67LjwtgyE/tTHJYY4AQ4mlbCIQOvlFyqByO1LkAHjton5MCzZ494XePss6iwaSBOiyN48FKuAAAAAAEAAAAAAAAAAAFqAAAAAA==';

describe('BIP-322 verification (bare P2SH multisig)', () => {
  it('verifies a 2-of-2 bare P2SH multisig proof (stack container)', async () => {
    const result = await verifyBip322P2SH(BARE_P2SH_2OF2_ADDR, FULL_MSG, BARE_P2SH_2OF2_STACK_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies a 2-of-2 bare P2SH multisig proof (serialized to_sign transaction)', async () => {
    const result = await verifyBip322P2SH(BARE_P2SH_2OF2_ADDR, FULL_MSG, BARE_P2SH_2OF2_TX_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies a 2-of-3 bare P2SH multisig (two of three cosigners, both containers)', async () => {
    const stack = await verifyBip322P2SH(BARE_P2SH_2OF3_ADDR, FULL_MSG, BARE_P2SH_2OF3_STACK_SIG);
    expect(stack.verified).toBe(true);
    const tx = await verifyBip322P2SH(BARE_P2SH_2OF3_ADDR, FULL_MSG, BARE_P2SH_2OF3_TX_SIG);
    expect(tx.verified).toBe(true);
  });

  it('verifies a bare P2SH proof signed over a version-2 to_sign (stack container)', async () => {
    const result = await verifyBip322P2SH(BARE_P2SH_V2_ADDR, FULL_MSG, BARE_P2SH_V2_STACK_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies a bare P2SH proof signed over a version-2 to_sign (serialized v2 transaction)', async () => {
    const result = await verifyBip322P2SH(BARE_P2SH_V2_ADDR, FULL_MSG, BARE_P2SH_V2_TX_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('rejects a v2-committed proof against the wrong message', async () => {
    const result = await verifyBip322P2SH(BARE_P2SH_V2_ADDR, 'Goodbye World', BARE_P2SH_V2_STACK_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });

  it('rejects a bare-multisig proof against the wrong message', async () => {
    const result = await verifyBip322P2SH(BARE_P2SH_2OF2_ADDR, 'Goodbye World', BARE_P2SH_2OF2_STACK_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });

  it('rejects a bare-multisig transaction proof against the wrong message', async () => {
    const result = await verifyBip322P2SH(BARE_P2SH_2OF2_ADDR, 'Goodbye World', BARE_P2SH_2OF2_TX_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a bare-multisig proof against a different P2SH address', async () => {
    const result = await verifyBip322P2SH(BARE_P2SH_2OF3_ADDR, FULL_MSG, BARE_P2SH_2OF2_STACK_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/does not correspond/i);
  });

  it('routes a bare P2SH proof through verifyBitcoinSignature', async () => {
    const result = await verifyBitcoinSignature(BARE_P2SH_2OF2_ADDR, FULL_MSG, BARE_P2SH_2OF2_TX_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  /**
   * Forged proofs that reuse ONE cosigner's signature twice. The stack
   * container is [dummy, sigA, sigB, redeemScript]; a lone cosigner could try
   * to fill both signature slots with their own (individually valid)
   * signature. checkMultisig's sequential key matching must reject this: the
   * duplicated signature verifies against its own key but not the next one,
   * so the proof can never reach the required threshold.
   */
  const b64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const bytesToB64 = (bytes: Uint8Array): string => {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  /** Parse a small serialized witness stack (single-byte varints only). */
  const parseStack = (bytes: Uint8Array): Uint8Array[] => {
    const items: Uint8Array[] = [];
    let off = 0;
    const count = bytes[off++];
    for (let i = 0; i < count; i++) {
      const len = bytes[off++];
      items.push(bytes.subarray(off, off + len));
      off += len;
    }
    expect(off).toBe(bytes.length);
    return items;
  };
  const serializeStack = (items: Uint8Array[]): Uint8Array => {
    const total = 1 + items.reduce((n, it) => n + 1 + it.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    out[off++] = items.length;
    for (const it of items) {
      out[off++] = it.length;
      out.set(it, off);
      off += it.length;
    }
    return out;
  };
  /** Replace one signature slot with a copy of another cosigner's signature. */
  const forgeDuplicateSig = (stackSigB64: string, copyFrom: number, into: number): string => {
    const items = parseStack(b64ToBytes(stackSigB64));
    // [dummy, sig1, …, sigM, redeemScript] — signature slots are 1..length-2.
    const forged = items.slice();
    forged[into] = items[copyFrom];
    return bytesToB64(serializeStack(forged));
  };

  it('rejects a 2-of-2 bare P2SH proof where one cosigner signature is duplicated', async () => {
    // Sanity: the original proof still verifies, so the only difference in the
    // forged proof is the duplicated signature.
    const genuine = await verifyBip322P2SH(BARE_P2SH_2OF2_ADDR, FULL_MSG, BARE_P2SH_2OF2_STACK_SIG);
    expect(genuine.verified).toBe(true);

    // First cosigner fills both slots with their own signature.
    const dupFirst = forgeDuplicateSig(BARE_P2SH_2OF2_STACK_SIG, 1, 2);
    const r1 = await verifyBip322P2SH(BARE_P2SH_2OF2_ADDR, FULL_MSG, dupFirst);
    expect(r1.verified).toBe(false);
    expect(r1.error).toMatch(/did not verify/i);

    // Second cosigner fills both slots with their own signature.
    const dupSecond = forgeDuplicateSig(BARE_P2SH_2OF2_STACK_SIG, 2, 1);
    const r2 = await verifyBip322P2SH(BARE_P2SH_2OF2_ADDR, FULL_MSG, dupSecond);
    expect(r2.verified).toBe(false);
    expect(r2.error).toMatch(/did not verify/i);
  });

  it('rejects a 2-of-3 bare P2SH proof where one cosigner signature is duplicated', async () => {
    const genuine = await verifyBip322P2SH(BARE_P2SH_2OF3_ADDR, FULL_MSG, BARE_P2SH_2OF3_STACK_SIG);
    expect(genuine.verified).toBe(true);

    const dupFirst = forgeDuplicateSig(BARE_P2SH_2OF3_STACK_SIG, 1, 2);
    const r1 = await verifyBip322P2SH(BARE_P2SH_2OF3_ADDR, FULL_MSG, dupFirst);
    expect(r1.verified).toBe(false);
    expect(r1.error).toMatch(/did not verify/i);

    const dupSecond = forgeDuplicateSig(BARE_P2SH_2OF3_STACK_SIG, 2, 1);
    const r2 = await verifyBip322P2SH(BARE_P2SH_2OF3_ADDR, FULL_MSG, dupSecond);
    expect(r2.verified).toBe(false);
    expect(r2.error).toMatch(/did not verify/i);
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

/**
 * EXTERNAL / cross-implementation BIP-322 "Full" vectors.
 *
 * The vectors above prove internal consistency, but they were produced with the
 * same crypto stack the verifier uses (bitcoinjs-lib sighash + noble secp256k1),
 * so a divergence shared by both signer and verifier would go unnoticed. No
 * published library ships genuine P2WSH-multisig / P2TR-script-path Full vectors
 * — bip322-js explicitly refuses both, and rust-bitcoin's "taproot full" test is
 * only a key-path spend reserialized — so these vectors were generated by a
 * fully INDEPENDENT reference implementation that shares no code with the
 * verifier:
 *
 *   - secp256k1 + Schnorr: the canonical BIP-340 reference implementation
 *     (pure-Python point arithmetic), NOT @bitcoinerlab/secp256k1 / noble.
 *   - ECDSA: RFC-6979 deterministic, low-S, hand-rolled on the same reference
 *     field math, NOT bitcoinjs-lib's signer.
 *   - BIP-143 / BIP-341 / BIP-342 sighash, taproot tweak + control block,
 *     bech32/bech32m, and the BIP-322 to_spend / to_sign virtual transactions:
 *     all hand-written in Python, NOT bitcoinjs-lib's Transaction class.
 *
 * That independent implementation was first validated by re-deriving and
 * verifying the two OFFICIAL published BIP-322 Simple vectors (the bitcoin/bips
 * P2WPKH "Hello World" vector and Bitcoin Core's P2TR vector) before being used
 * to emit the Full witnesses below. A passing verify here therefore proves
 * KYUTXO's Full pipeline agrees with an external implementation, not merely with
 * itself.
 */
const EXT_MSG = 'I certify that I control the following Bitcoin address.';

// P2WSH 2-of-2 multisig, both cosigners signing.
const EXT_P2WSH_2OF2_ADDR =
  'bc1q28k22j4fgzh3yphtk68rdyn22s2e0nl5p5uxevjx9p7ccjn6hprsclnv2r';
const EXT_P2WSH_2OF2_SIG =
  'BABHMEQCIByoInsVkxn7YsdL2aZX0tnn5xGdvpsyLAusVC9abyJrAiBuSaZ8RPRDDwoRHEt58hdz1RqZK8z/VEtIRqdvoGsPyAFIMEUCIQDZRceVsZ57u4bYyeqlA9gqSs4bi156RQksPhk1zvZ6BwIgDguUd6AnRLkAEOQ7Z+EalO4CAOKd9fQGjnhkCe08opkBR1IhAjz720qCycp/Wt11nhmmYRPXMeTZgiq7S6e/+K1WpiUtIQMPpoXX/rnGmRfLTUEyUONU4lRrf8IH63zsoneS15CGyVKu';

// P2WSH 2-of-3 multisig, signed by two of three cosigners.
const EXT_P2WSH_2OF3_ADDR =
  'bc1qw6myamt0mq4nyefqstmkdrs6p6pt4gkms3z9m8dzav4f2ew6jswsta88y3';
const EXT_P2WSH_2OF3_SIG =
  'BABHMEQCIFuFxTxcXpkFUsviSGETid1bU8d0VEBYLrH2W7E4q5rbAiBd0SOoYTEZ2oNTk6xjf0RCPhmTab9sxJJ38nrtW1W5kgFHMEQCIBZfvDXFCql+FnoxpzZ1EttExrusbrlWAGCINeIp60aHAiAEmCTKN4cgxJTXBzrJ+S8IXKuteL0Yr2sQa4cxOfDFlgFpUiECPPvbSoLJyn9a3XWeGaZhE9cx5NmCKrtLp7/4rVamJS0hAw+mhdf+ucaZF8tNQTJQ41TiVGt/wgfrfOyid5LXkIbJIQLUWakxLWbqkW9G2Ta07MskqT8JwdAl3MZyt7u7KYvS0lOu';

// P2TR single-leaf script-path (<xA> OP_CHECKSIG).
const EXT_P2TR_LEAF_ADDR =
  'bc1pe5e99hvr2whxs95wtapl23yyfr38z46ne3gggdjkn84ty0fudansavhj3a';
const EXT_P2TR_LEAF_SIG =
  'A0A2FPQYWIMyJ/zUYZfncd9rXzIW0odK6NUAoyKOBbX6FRbDSumXXE3KlaGJhKi+kQjDcsStRxw/nAqJ6+L06FdPIiCm90uo3iM0R8fDFIu+nu6HEyuyPxoqXVla98/bsUCYpqwhweHAAU/rJ6MbNvz95k9ajbiFF04vodpudzePjd2rT+Q9';

// P2TR CHECKSIGADD 2-of-2 (<xA> OP_CHECKSIG <xB> OP_CHECKSIGADD OP_2 OP_NUMEQUAL).
const EXT_P2TR_CSA_ADDR =
  'bc1p3wawevwa46quqrtmjj22rd58pp7vtchxl98zm27n5q7hxkdk8dss36y4gj';
const EXT_P2TR_CSA_SIG =
  'BEBujq6LRmZ54+Yd2U61ZuZ8syMAjwEIDK8Khrmwv2Z0hVGWFyUS3Lzkojet3SUwHMI4NbmRb22abXpNOiivy/6LQD7Mq3nPb5EfSf0E99e1xlXyawmGZKuzdWfugY/Hz7uAD5itHlAaHSVO2F0665tTFRb/prdmCI++GqW8+gClSi9GIEFwbAfWkhruaXo8Q9iyvqp9dBG1hej+Epo7KpD4y/lrrCBQAWPlbIFWR5ZVgsKUVO1vkCo8UDo4tykH8BYT+FJd0rpSnCHAZZBkvVWi1jy8+EHSK0d4N/c6athPNZVcxUCmSHcE1d8=';

// P2TR multi-leaf taproot trees (deep multisig vaults). The signing leaf sits
// alongside other committed scripts, so the control block carries a 32-byte-
// per-level merkle path that verifyTaprootCommitment must fold to re-derive
// the output key — the branch a single-leaf tree never exercises.
// 2-leaf tree, spending leaf 0 (1-node merkle path).
const EXT_P2TR_2LEAF_ADDR =
  'bc1pqpldgprlt26wnfepjwwjeckqf3xx209mv6cv5tmqg7yp3ce70t8qxkp6l9';
const EXT_P2TR_2LEAF_SIG =
  'A0CE6iStiz/MJsj8mrO9eI7YlMePdDQ7ZNl1P3XG8basn3+HYQ2XlkLg27zIxVpGD7ck8d2dQ3rorgY85FZ/CZjlIiD5+3LJw5Ensu1OTWzVGRSdFTGiZpUYVjjhTZtBITS6bKxBwZ6Q385Z2IITzh0Nfr85F5IiQkLcp12/lSvSjOrYnsmaxjPBEYswVPX5yNRPREECRo1xdxuvKjl25u7FIMXmRdE=';

// 4-leaf tree, spending leaf 2 (2-node merkle path).
const EXT_P2TR_4LEAF_ADDR =
  'bc1pw5uutnp49f5p6pddf5uzmdwq7rtqjy4q0rdfa6g9jc39q33w6zjq4y0eak';
const EXT_P2TR_4LEAF_SIG =
  'A0CAMxrmvcyZA+NoVD9dRm7/PBgXZOVzoSHBX2fKtLtkZLFv/oUnOE1J3tSE4k51dMCF6XROcQu8YZtbw0n4T8PfIiCjDjcKNN2qhu12YKD7QA1DzRFwisS72htM+LU/20N8OKxhwN1Kbqvq6udX4wtvGczBplOg2Us+14x+FIfa1XVd4KzpL5w6939n9dcX9+wB/l634de4ICixTur3OCOCZyWl7V6y/xMiWZiGC1HIJIW3B+vP4czzO+npe5J1GBWa9E2DHg==';

describe('BIP-322 Full verification (external independent vectors)', () => {
  it('verifies an externally-produced P2WSH 2-of-2 multisig witness', async () => {
    const result = await verifyBip322Full(EXT_P2WSH_2OF2_ADDR, EXT_MSG, EXT_P2WSH_2OF2_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies an externally-produced P2WSH 2-of-3 multisig witness', async () => {
    const result = await verifyBip322Full(EXT_P2WSH_2OF3_ADDR, EXT_MSG, EXT_P2WSH_2OF3_SIG);
    expect(result.verified).toBe(true);
  });

  it('verifies an externally-produced P2TR single-leaf script-path witness', async () => {
    const result = await verifyBip322Full(EXT_P2TR_LEAF_ADDR, EXT_MSG, EXT_P2TR_LEAF_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies an externally-produced P2TR CHECKSIGADD 2-of-2 tapscript witness', async () => {
    const result = await verifyBip322Full(EXT_P2TR_CSA_ADDR, EXT_MSG, EXT_P2TR_CSA_SIG);
    expect(result.verified).toBe(true);
  });

  it('verifies an externally-produced P2TR script-path witness in a 2-leaf tree (merkle-path folding)', async () => {
    const result = await verifyBip322Full(EXT_P2TR_2LEAF_ADDR, EXT_MSG, EXT_P2TR_2LEAF_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('verifies an externally-produced P2TR script-path witness in a 4-leaf tree (2-level merkle path)', async () => {
    const result = await verifyBip322Full(EXT_P2TR_4LEAF_ADDR, EXT_MSG, EXT_P2TR_4LEAF_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('rejects a multi-leaf tapscript witness against the wrong message', async () => {
    const result = await verifyBip322Full(EXT_P2TR_2LEAF_ADDR, 'Goodbye World', EXT_P2TR_2LEAF_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a multi-leaf tapscript witness against a different multi-leaf address', async () => {
    const result = await verifyBip322Full(EXT_P2TR_4LEAF_ADDR, EXT_MSG, EXT_P2TR_2LEAF_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/control block does not commit/i);
  });

  it('rejects an external multisig witness against the wrong message', async () => {
    const result = await verifyBip322Full(EXT_P2WSH_2OF2_ADDR, 'Goodbye World', EXT_P2WSH_2OF2_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects an external tapscript witness against the wrong message', async () => {
    const result = await verifyBip322Full(EXT_P2TR_LEAF_ADDR, 'Goodbye World', EXT_P2TR_LEAF_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
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
  // This test is the single place that pins the exact human-readable label
  // wording. Other tests (PDF/UI) must derive expected labels via
  // signatureFormatLabel so a deliberate wording change only updates here.
  it('pins the exact label strings for both formats', () => {
    expect(signatureFormatLabel('bip322')).toBe('BIP-322');
    expect(signatureFormatLabel('legacy')).toBe('Bitcoin Signed Message');
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

/**
 * Negative cross-implementation BIP-322 "Full" vectors: structurally-valid but
 * INSUFFICIENT witnesses an attacker would actually craft.
 *
 * The positive external vectors above prove the verifier ACCEPTS genuine
 * independent witnesses; these prove it REJECTS the cases that matter most —
 * a witness whose script still hashes to / commits to the address (so it sails
 * past the hash and taproot-commitment checks) but whose SIGNATURES are too few,
 * mis-ordered, or tampered.
 *
 * Rather than re-deriving fresh signatures, these "almost valid" witnesses are
 * generated from the externally-produced positive vectors by an INDEPENDENT
 * witness-stack rewriter (the helpers below) that only ever re-orders, drops, or
 * bit-flips stack items — it shares no code with signatureVerify.ts's own
 * (non-exported) parser/interpreter. The witness/leaf script item is left
 * untouched, so the address hash160/sha256 and the taproot control-block
 * commitment still match; only the signature material is broken. That isolates
 * the rejection to the signature-validation logic (CHECKMULTISIG / CHECKSIG /
 * CHECKSIGADD), exactly the surface an attacker probes.
 */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** CompactSize varint reader (independent of the verifier's internal one). */
function readCompactSize(buf: Uint8Array, off: number): { value: number; size: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const first = buf[off];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) return { value: dv.getUint16(off + 1, true), size: 3 };
  if (first === 0xfe) return { value: dv.getUint32(off + 1, true), size: 5 };
  return { value: Number(dv.getBigUint64(off + 1, true)), size: 9 };
}

/** Parse a serialized witness stack into its items. */
function splitWitness(b64: string): Uint8Array[] {
  const buf = b64ToBytes(b64);
  let off = 0;
  const { value: count, size } = readCompactSize(buf, off);
  off += size;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const { value: len, size: lenSize } = readCompactSize(buf, off);
    off += lenSize;
    items.push(buf.subarray(off, off + len));
    off += len;
  }
  return items;
}

/** Encode a small length as a CompactSize varint (all items here are < 0xfd*… big). */
function writeCompactSize(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

/** Re-serialize a witness stack from its items and base64-encode it. */
function joinWitness(items: Uint8Array[]): string {
  const chunks: Uint8Array[] = [writeCompactSize(items.length)];
  for (const item of items) {
    chunks.push(writeCompactSize(item.length));
    chunks.push(item);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return bytesToB64(out);
}

/** Return a copy of `item` with the byte at `index` flipped (XOR 0xff). */
function flipByte(item: Uint8Array, index: number): Uint8Array {
  const copy = item.slice();
  copy[index] ^= 0xff;
  return copy;
}

describe("BIP-322 Full rejects structurally-valid-but-insufficient multisig (P2WSH)", () => {
  // EXT_P2WSH_2OF3 stack: [<empty dummy>, sigA, sigC, <witnessScript>].
  const items = splitWitness(EXT_P2WSH_2OF3_SIG);

  it("rejects a 2-of-3 P2WSH with only ONE signature (too few sigs)", async () => {
    // Drop sigC, leaving the dummy, a single sig, and the (untouched) script.
    const tooFew = joinWitness([items[0], items[1], items[3]]);
    const result = await verifyBip322Full(EXT_P2WSH_2OF3_ADDR, EXT_MSG, tooFew);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    // The script item is unchanged, so it must get past the hash check and fail
    // in signature validation, not in the address-mismatch branch.
    expect(result.error).not.toMatch(/witness script does not hash/i);
  });

  it("rejects a 2-of-3 P2WSH with the cosigner signatures in the wrong order", async () => {
    // OP_CHECKMULTISIG matches sigs to keys sequentially in script order, so
    // swapping the two valid sigs makes the second one run out of keys.
    const swapped = joinWitness([items[0], items[2], items[1], items[3]]);
    const result = await verifyBip322Full(EXT_P2WSH_2OF3_ADDR, EXT_MSG, swapped);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/witness script does not hash/i);
  });

  it("rejects a 2-of-3 P2WSH where one signature is tampered (one bad sig)", async () => {
    // Flip a byte inside the r-value of sigA: the DER stays structurally
    // parseable but the signature no longer verifies against any cosigner key.
    const badSig = flipByte(items[1], 10);
    const tampered = joinWitness([items[0], badSig, items[2], items[3]]);
    const result = await verifyBip322Full(EXT_P2WSH_2OF3_ADDR, EXT_MSG, tampered);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/witness script does not hash/i);
  });

  it("rejects a 2-of-2 P2WSH where one of the two signatures is tampered", async () => {
    // Same attack on the 2-of-2 vault: a single bad sig must fail the m-of-n.
    const twoOfTwo = splitWitness(EXT_P2WSH_2OF2_SIG); // [empty, sigA, sigB, script]
    const badSig = flipByte(twoOfTwo[2], 10);
    const tampered = joinWitness([twoOfTwo[0], twoOfTwo[1], badSig, twoOfTwo[3]]);
    const result = await verifyBip322Full(EXT_P2WSH_2OF2_ADDR, EXT_MSG, tampered);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/witness script does not hash/i);
  });

  /**
   * Forged proofs that reuse ONE cosigner's signature twice — a lone cosigner
   * filling both signature slots with their own (individually valid)
   * signature. checkMultisig's sequential key matching must reject this: the
   * duplicated signature verifies against its own key but not any later one,
   * so the proof can never reach the m-of-n threshold. These use the
   * internally-generated P2WSH vectors (FULL_MSG), mirroring the bare-P2SH
   * duplicate-signature forgery tests.
   */
  it("rejects a 2-of-2 P2WSH proof where one cosigner signature is duplicated", async () => {
    // Sanity: the original proof still verifies, so the only difference in
    // the forged proofs is the duplicated signature.
    const genuine = await verifyBip322Full(P2WSH_2OF2_ADDR, FULL_MSG, P2WSH_2OF2_SIG);
    expect(genuine.verified).toBe(true);

    // Stack: [<empty dummy>, sigA, sigB, <witnessScript>].
    const stack = splitWitness(P2WSH_2OF2_SIG);

    // First cosigner fills both slots with their own signature.
    const dupFirst = joinWitness([stack[0], stack[1], stack[1], stack[3]]);
    const r1 = await verifyBip322Full(P2WSH_2OF2_ADDR, FULL_MSG, dupFirst);
    expect(r1.verified).toBe(false);
    expect(r1.error).toMatch(/did not verify/i);
    expect(r1.error).not.toMatch(/witness script does not hash/i);

    // Second cosigner fills both slots with their own signature.
    const dupSecond = joinWitness([stack[0], stack[2], stack[2], stack[3]]);
    const r2 = await verifyBip322Full(P2WSH_2OF2_ADDR, FULL_MSG, dupSecond);
    expect(r2.verified).toBe(false);
    expect(r2.error).toMatch(/did not verify/i);
    expect(r2.error).not.toMatch(/witness script does not hash/i);
  });

  it("rejects a 2-of-3 P2WSH proof where one cosigner signature is duplicated", async () => {
    const genuine = await verifyBip322Full(P2WSH_2OF3_ADDR, FULL_MSG, P2WSH_2OF3_SIG);
    expect(genuine.verified).toBe(true);

    // Stack: [<empty dummy>, sigA, sigC, <witnessScript>].
    const stack = splitWitness(P2WSH_2OF3_SIG);

    const dupFirst = joinWitness([stack[0], stack[1], stack[1], stack[3]]);
    const r1 = await verifyBip322Full(P2WSH_2OF3_ADDR, FULL_MSG, dupFirst);
    expect(r1.verified).toBe(false);
    expect(r1.error).toMatch(/did not verify/i);
    expect(r1.error).not.toMatch(/witness script does not hash/i);

    const dupSecond = joinWitness([stack[0], stack[2], stack[2], stack[3]]);
    const r2 = await verifyBip322Full(P2WSH_2OF3_ADDR, FULL_MSG, dupSecond);
    expect(r2.verified).toBe(false);
    expect(r2.error).toMatch(/did not verify/i);
    expect(r2.error).not.toMatch(/witness script does not hash/i);
  });
});

describe("BIP-322 Full rejects structurally-valid-but-insufficient multisig (P2TR script-path)", () => {
  // EXT_P2TR_CSA stack: [sigB, sigA, <leafScript>, <controlBlock>].
  const items = splitWitness(EXT_P2TR_CSA_SIG);

  it("rejects a CHECKSIGADD 2-of-2 with one good and one tampered signature", async () => {
    // Flip a byte in the second Schnorr signature: CHECKSIGADD then counts only
    // one valid sig, so OP_2 OP_NUMEQUAL fails (1 ≠ 2).
    const badSig = flipByte(items[1], 10);
    const tampered = joinWitness([items[0], badSig, items[2], items[3]]);
    const result = await verifyBip322Full(EXT_P2TR_CSA_ADDR, EXT_MSG, tampered);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    // The leaf script + control block are untouched, so it gets past the
    // taproot-commitment check and fails in tapscript signature validation.
    expect(result.error).not.toMatch(/control block does not commit/i);
  });

  it("rejects a CHECKSIGADD 2-of-2 with the two signatures swapped", async () => {
    // Each Schnorr sig is bound to a specific cosigner key by position, so
    // swapping them makes both CHECKSIG/CHECKSIGADD checks fail.
    const swapped = joinWitness([items[1], items[0], items[2], items[3]]);
    const result = await verifyBip322Full(EXT_P2TR_CSA_ADDR, EXT_MSG, swapped);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/control block does not commit/i);
  });

  it("rejects a CHECKSIGADD 2-of-2 with one signature dropped (too few sigs)", async () => {
    // Remove sigB, leaving a single sig for a 2-of-2 tapscript: the count can
    // never reach 2, so verification must fail (without crashing).
    const tooFew = joinWitness([items[1], items[2], items[3]]);
    const result = await verifyBip322Full(EXT_P2TR_CSA_ADDR, EXT_MSG, tooFew);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/control block does not commit/i);
  });
});

describe("BIP-322 P2SH-P2WSH rejects structurally-valid-but-insufficient wrapped multisig", () => {
  // verifyBip322P2SH reconstructs the redeem script from the untouched
  // witnessScript (last item), so all of these mutated witnesses still pass the
  // hash160(redeemScript) address check and must fail in SIGNATURE validation —
  // never in the "does not correspond" redeem-mismatch branch.
  // P2SH_P2WSH_2OF3 stack: [<empty dummy>, sigA, sigB, <witnessScript>].
  const twoOfThree = splitWitness(P2SH_P2WSH_2OF3_SIG);
  // P2SH_P2WSH_2OF2 stack: [<empty dummy>, sigA, sigB, <witnessScript>].
  const twoOfTwo = splitWitness(P2SH_P2WSH_2OF2_SIG);

  it("rejects a wrapped 2-of-3 with one signature dropped (too few sigs)", async () => {
    const tooFew = joinWitness([twoOfThree[0], twoOfThree[1], twoOfThree[3]]);
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF3_ADDR, FULL_MSG, tooFew);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/does not correspond/i);
  });

  it("rejects a wrapped 2-of-3 where one signature is tampered", async () => {
    // Flip a byte inside the r-value: the DER stays structurally parseable but
    // the signature no longer verifies against any cosigner key.
    const badSig = flipByte(twoOfThree[1], 10);
    const tampered = joinWitness([twoOfThree[0], badSig, twoOfThree[2], twoOfThree[3]]);
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF3_ADDR, FULL_MSG, tampered);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/does not correspond/i);
  });

  it("rejects a wrapped 2-of-3 with the cosigner signatures swapped", async () => {
    // OP_CHECKMULTISIG matches sigs to keys sequentially in script order, so
    // swapping the two valid sigs makes the second one run out of keys.
    const swapped = joinWitness([twoOfThree[0], twoOfThree[2], twoOfThree[1], twoOfThree[3]]);
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF3_ADDR, FULL_MSG, swapped);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/does not correspond/i);
  });

  it("rejects a wrapped 2-of-2 with one signature dropped (too few sigs)", async () => {
    const tooFew = joinWitness([twoOfTwo[0], twoOfTwo[1], twoOfTwo[3]]);
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, FULL_MSG, tooFew);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/does not correspond/i);
  });

  it("rejects a wrapped 2-of-2 where one of the two signatures is tampered", async () => {
    const badSig = flipByte(twoOfTwo[2], 10);
    const tampered = joinWitness([twoOfTwo[0], twoOfTwo[1], badSig, twoOfTwo[3]]);
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, FULL_MSG, tampered);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/does not correspond/i);
  });

  it("rejects a wrapped 2-of-2 with the cosigner signatures swapped", async () => {
    const swapped = joinWitness([twoOfTwo[0], twoOfTwo[2], twoOfTwo[1], twoOfTwo[3]]);
    const result = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, FULL_MSG, swapped);
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/does not correspond/i);
  });

  /**
   * Forged wrapped proofs that reuse ONE cosigner's signature twice. The
   * untouched witnessScript still reconstructs the correct redeem script, so
   * these get past the hash160 address check and must be rejected by
   * checkMultisig's sequential signature matching — a lone cosigner must not
   * be able to forge a 2-of-N wrapped proof.
   */
  it("rejects a wrapped 2-of-2 proof where one cosigner signature is duplicated", async () => {
    // First cosigner fills both slots with their own signature.
    const dupFirst = joinWitness([twoOfTwo[0], twoOfTwo[1], twoOfTwo[1], twoOfTwo[3]]);
    const r1 = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, FULL_MSG, dupFirst);
    expect(r1.verified).toBe(false);
    expect(r1.error).toMatch(/did not verify/i);
    expect(r1.error).not.toMatch(/does not correspond/i);

    // Second cosigner fills both slots with their own signature.
    const dupSecond = joinWitness([twoOfTwo[0], twoOfTwo[2], twoOfTwo[2], twoOfTwo[3]]);
    const r2 = await verifyBip322P2SH(P2SH_P2WSH_2OF2_ADDR, FULL_MSG, dupSecond);
    expect(r2.verified).toBe(false);
    expect(r2.error).toMatch(/did not verify/i);
    expect(r2.error).not.toMatch(/does not correspond/i);
  });

  it("rejects a wrapped 2-of-3 proof where one cosigner signature is duplicated", async () => {
    const dupFirst = joinWitness([twoOfThree[0], twoOfThree[1], twoOfThree[1], twoOfThree[3]]);
    const r1 = await verifyBip322P2SH(P2SH_P2WSH_2OF3_ADDR, FULL_MSG, dupFirst);
    expect(r1.verified).toBe(false);
    expect(r1.error).toMatch(/did not verify/i);
    expect(r1.error).not.toMatch(/does not correspond/i);

    const dupSecond = joinWitness([twoOfThree[0], twoOfThree[2], twoOfThree[2], twoOfThree[3]]);
    const r2 = await verifyBip322P2SH(P2SH_P2WSH_2OF3_ADDR, FULL_MSG, dupSecond);
    expect(r2.verified).toBe(false);
    expect(r2.error).toMatch(/did not verify/i);
    expect(r2.error).not.toMatch(/does not correspond/i);
  });
});

/**
 * P2SH-P2WPKH (wrapped single-key "3…" vault) BIP-322 vector, generated
 * deterministically offline like the wrapped-multisig vectors above: fixed
 * private key sha256("KYUTXO P2SH-P2WPKH BIP-322 vector key"), RFC-6979
 * ECDSA over the BIP-143 sighash of the BIP-322 to_sign transaction whose
 * to_spend output carries the P2SH scriptPubKey. Witness stack:
 * [DER sig + SIGHASH_ALL byte, 33-byte compressed pubkey].
 */
const P2SH_P2WPKH_ADDR = '3AK7FtoYUyY4qNecR5VLwjmw7uU6FrwFB7';
const P2SH_P2WPKH_SIG =
  'AkgwRQIhAMoylwMGkfqbpK/65/XQ+D3niVHdZ87AWTiPJWemmSpTAiAkhzM4VOHIA8Ta+vwyzryLeFf2X+4zJqDIQKinuac86AEhA1GNUOBChF8VuAUZmjHsXVI/GWuGqYLaJ0g57bkWZIbG';

describe('BIP-322 P2SH-P2WPKH (wrapped single-key) verification', () => {
  // Witness stack: [DER sig (with trailing sighash byte), 33-byte pubkey].
  const items = splitWitness(P2SH_P2WPKH_SIG);

  it('verifies the wrapped single-key vector', async () => {
    const result = await verifyBip322P2SH(P2SH_P2WPKH_ADDR, FULL_MSG, P2SH_P2WPKH_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('routes the wrapped single-key witness through verifyBitcoinSignature', async () => {
    const result = await verifyBitcoinSignature(P2SH_P2WPKH_ADDR, FULL_MSG, P2SH_P2WPKH_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
  });

  it('rejects the signature against the wrong message', async () => {
    const result = await verifyBip322P2SH(P2SH_P2WPKH_ADDR, 'Goodbye World', P2SH_P2WPKH_SIG);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
  });

  it('rejects a bit-flipped DER signature (tampered witness)', async () => {
    // Flip a byte inside the r-value: the DER stays structurally parseable and
    // the untouched pubkey still hashes to the address's redeem script, so the
    // forgery must be caught by ECDSA validation itself — never by crashing and
    // never by the redeem-script-mismatch branch.
    const badSig = flipByte(items[0], 10);
    const result = await verifyBip322P2SH(
      P2SH_P2WPKH_ADDR,
      FULL_MSG,
      joinWitness([badSig, items[1]]),
    );
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/did not verify/i);
    expect(result.error).not.toMatch(/does not correspond/i);
  });

  it('rejects a substituted foreign pubkey (redeem script no longer matches)', async () => {
    // Swap in a different valid 33-byte compressed pubkey (from the native
    // P2WPKH vector). It hashes to a DIFFERENT redeem script, so the witness
    // can no longer prove control of this address.
    const foreignPub = splitWitness(P2WPKH_BIP322_HELLO_SIG)[1];
    expect(foreignPub.length).toBe(33);
    const result = await verifyBip322P2SH(
      P2SH_P2WPKH_ADDR,
      FULL_MSG,
      joinWitness([items[0], foreignPub]),
    );
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/does not correspond|not supported/i);
  });

  it('rejects when the sighash-type byte is altered (sighash binding)', async () => {
    // The trailing sighash byte of the DER item participates in the BIP-143
    // sighash the ECDSA signature commits to; changing SIGHASH_ALL (0x01) to
    // SIGHASH_NONE (0x02) must fail signature validation, not crash or pass.
    const mutated = items[0].slice();
    mutated[mutated.length - 1] = 0x02; // SIGHASH_NONE
    const result = await verifyBip322P2SH(
      P2SH_P2WPKH_ADDR,
      FULL_MSG,
      joinWitness([mutated, items[1]]),
    );
    expect(result.verified).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/does not correspond/i);
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
