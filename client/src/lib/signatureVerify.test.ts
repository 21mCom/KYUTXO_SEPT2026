import { describe, it, expect } from 'vitest';
import {
  verifyBitcoinSignature,
  verifyBip322Simple,
  signatureFormatLabel,
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
