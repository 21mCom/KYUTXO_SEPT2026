import { describe, it, expect } from 'vitest';
import {
  verifyBitcoinSignature,
  verifyBip322Simple,
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

describe('verifyBitcoinSignature routing', () => {
  it('routes Taproot addresses to the BIP-322 path', async () => {
    const result = await verifyBitcoinSignature(P2TR_ADDR, 'Hello World', HELLO_WORLD_SIG);
    expect(result.verified).toBe(true);
    expect(result.format).toBe('bip322');
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
