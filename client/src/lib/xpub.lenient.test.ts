import { describe, it, expect } from 'vitest';
import BIP32Factory from 'bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import bs58check from 'bs58check';
import {
  analyzeXpub,
  deriveDualChainAddresses,
  deriveAddressesForChain,
  hasNonStandardHeader,
  validateExtendedPublicKey,
} from './xpub';

const bip32 = BIP32Factory(ecc);

const VERSIONS = {
  xpub: 0x0488b21e,
  zpub: 0x04b24746,
};

function encodeExtendedKey(
  version: number,
  depth: number,
  parentFingerprint: number,
  childIndex: number,
  chainCode: Uint8Array,
  keyData: Uint8Array,
  payloadLength = 78
): string {
  const buf = new Uint8Array(payloadLength);
  const writeU32 = (v: number, o: number) => {
    buf[o] = (v >>> 24) & 0xff;
    buf[o + 1] = (v >>> 16) & 0xff;
    buf[o + 2] = (v >>> 8) & 0xff;
    buf[o + 3] = v & 0xff;
  };
  writeU32(version, 0);
  buf[4] = depth;
  writeU32(parentFingerprint, 5);
  writeU32(childIndex, 9);
  buf.set(chainCode.slice(0, 32), 13);
  buf.set(keyData.slice(0, Math.min(33, payloadLength - 45)), 45);
  return bs58check.encode(buf);
}

// Deterministic key material: account node at m/84'/0'/0' from a fixed seed.
const seed = new Uint8Array(32).fill(7);
const master = bip32.fromSeed(seed);
const account = master.derivePath("m/84'/0'/0'").neutered();
const pubkey = account.publicKey;
const chainCode = account.chainCode;
// Nonzero fingerprint/index like Coinomi-era exports carried.
const FP = 0xdeadbeef;
const IDX = 0x80000000; // account 0' as it would appear in the child-number field

// Malformed: depth 0 but nonzero fingerprint + child index (Coinomi quirk)
const malformedXpub = encodeExtendedKey(VERSIONS.xpub, 0, FP, IDX, chainCode, pubkey);
const malformedZpub = encodeExtendedKey(VERSIONS.zpub, 0, FP, IDX, chainCode, pubkey);
// Corrected header: same key material at depth 3 (strict-parse valid)
const correctedXpub = encodeExtendedKey(VERSIONS.xpub, 3, FP, IDX, chainCode, pubkey);
const correctedZpub = encodeExtendedKey(VERSIONS.zpub, 3, FP, IDX, chainCode, pubkey);

describe('Coinomi-era malformed xpub lenient parsing', () => {
  it('strict bip32 rejects the malformed key (sanity check)', () => {
    expect(() => bip32.fromBase58(malformedXpub)).toThrow(/Invalid (index|parent fingerprint)/);
  });

  it('hasNonStandardHeader detects the quirk and passes well-formed keys', () => {
    expect(hasNonStandardHeader(malformedXpub)).toBe(true);
    expect(hasNonStandardHeader(malformedZpub)).toBe(true);
    expect(hasNonStandardHeader(correctedXpub)).toBe(false);
    expect(hasNonStandardHeader(account.toBase58())).toBe(false);
  });

  it('derives the same addresses as the corrected-header key (xpub / P2PKH)', async () => {
    const lenient = await deriveDualChainAddresses(malformedXpub, 0, 4, 0, 4);
    const strict = await deriveDualChainAddresses(correctedXpub, 0, 4, 0, 4);
    expect(lenient.receive.map(a => a.address)).toEqual(strict.receive.map(a => a.address));
    expect(lenient.change.map(a => a.address)).toEqual(strict.change.map(a => a.address));
    expect(lenient.receive).toHaveLength(5);
  });

  it('derives the same addresses as the corrected-header key (zpub / P2WPKH)', async () => {
    const lenient = await deriveAddressesForChain(malformedZpub, 0, 0, 4);
    const strict = await deriveAddressesForChain(correctedZpub, 0, 0, 4);
    expect(lenient.map(a => a.address)).toEqual(strict.map(a => a.address));
    expect(lenient[0].address.startsWith('bc1q')).toBe(true);
  });

  it('analyzeXpub treats the key as account-level with a non-standard-header reason', () => {
    const info = analyzeXpub(malformedZpub);
    expect(info.nonStandardHeader).toBe(true);
    expect(info.isAccountLevel).toBe(true);
    expect(info.needsAdvancedMode).toBe(false);
    expect(info.suggestedPath).toBe('0');
    expect(info.reason).toMatch(/non-standard header/i);
    expect(info.reason).toMatch(/Coinomi/i);
  });

  it('does not misclassify the malformed key as a master key path', () => {
    const info = analyzeXpub(malformedXpub);
    expect(info.reason).not.toMatch(/Electrum/i);
  });

  it('well-formed keys behave exactly as before', async () => {
    const genuine = account.toBase58();
    const info = analyzeXpub(genuine);
    expect(info.nonStandardHeader).toBeFalsy();
    expect(info.isAccountLevel).toBe(true);
    const result = await deriveDualChainAddresses(genuine, 0, 1, 0, 1);
    expect(result.receive).toHaveLength(2);
  });

  it('rejects a key with a bad checksum', async () => {
    const corrupted = malformedXpub.slice(0, -1) + (malformedXpub.endsWith('1') ? '2' : '1');
    expect(validateExtendedPublicKey(corrupted).valid).toBe(false);
    await expect(deriveDualChainAddresses(corrupted, 0, 1, 0, 1)).rejects.toThrow();
  });

  it('rejects a key with the wrong payload length', async () => {
    const shortKey = encodeExtendedKey(VERSIONS.xpub, 0, FP, IDX, chainCode, pubkey, 77);
    expect(validateExtendedPublicKey(shortKey).valid).toBe(false);
    await expect(deriveDualChainAddresses(shortKey, 0, 1, 0, 1)).rejects.toThrow();
  });

  it('rejects a malformed-header key whose key data is not a valid curve point', async () => {
    const badPoint = new Uint8Array(33);
    badPoint[0] = 0x02;
    badPoint.fill(0xff, 1);
    const badKey = encodeExtendedKey(VERSIONS.xpub, 0, FP, IDX, chainCode, badPoint);
    await expect(deriveDualChainAddresses(badKey, 0, 1, 0, 1)).rejects.toThrow(/public key|point|Point/i);
  });
});
