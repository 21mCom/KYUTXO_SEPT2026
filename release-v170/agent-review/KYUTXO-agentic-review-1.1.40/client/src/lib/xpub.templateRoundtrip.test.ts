// Task: confirm a Coinomi-era malformed key still round-trips through a saved
// derivation template. The Address Importer stores the RAW xpub string in the
// derivationTemplates table (saveDerivationTemplate); a later re-derivation
// from the saved template re-parses that stored key, so the lenient parse in
// client/src/lib/xpub.ts must also cover the template re-use flow.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import BIP32Factory from 'bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import bs58check from 'bs58check';
import {
  analyzeXpub,
  deriveDualChainAddresses,
  hasNonStandardHeader,
} from './xpub';
import { saveDerivationTemplate } from './data/record-crud';
import {
  getAllDerivationTemplates,
  clearDerivationTemplates,
} from './data/derivation-templates-crud';

const bip32 = BIP32Factory(ecc);

const ZPUB_VERSION = 0x04b24746;

function encodeExtendedKey(
  version: number,
  depth: number,
  parentFingerprint: number,
  childIndex: number,
  chainCode: Uint8Array,
  keyData: Uint8Array
): string {
  const buf = new Uint8Array(78);
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
  buf.set(keyData.slice(0, 33), 45);
  return bs58check.encode(buf);
}

// Same deterministic key material as xpub.lenient.test.ts (seed 32x 0x07,
// account m/84'/0'/0'), with the Coinomi quirk: depth 0 + nonzero
// fingerprint / child index.
const seed = new Uint8Array(32).fill(7);
const account = bip32.fromSeed(seed).derivePath("m/84'/0'/0'").neutered();
const malformedZpub = encodeExtendedKey(
  ZPUB_VERSION,
  0,
  0xdeadbeef,
  0x80000000,
  account.chainCode,
  account.publicKey
);
const correctedZpub = encodeExtendedKey(
  ZPUB_VERSION,
  3,
  0xdeadbeef,
  0x80000000,
  account.chainCode,
  account.publicKey
);

/**
 * Mirrors BulkImport.tsx handleSaveAddresses's "Save derivation template"
 * block: fingerprint / scriptType / derivationPath are computed from
 * analyzeXpub info and the RAW user-entered xpub string is stored.
 */
async function saveTemplateLikeBulkImport(rawXpub: string, gapLimit: number) {
  const xpubInfo = analyzeXpub(rawXpub);
  const scriptTypeMap: Record<string, 'P2WPKH' | 'P2PKH' | 'P2SH-P2WPKH' | 'P2TR'> = {
    BIP84: 'P2WPKH',
    BIP44: 'P2PKH',
    BIP49: 'P2SH-P2WPKH',
    BIP86: 'P2TR',
  };
  await saveDerivationTemplate({
    fingerprint: xpubInfo.parentFingerprint || 'unknown',
    scriptType: scriptTypeMap[xpubInfo.bipStandard] || 'P2WPKH',
    derivationPath:
      xpubInfo.depth === 3 ? "m/84'/0'/0'" : "m/84'/0'/0'/0",
    xpub: rawXpub,
    gapLimit,
    network: xpubInfo.network === 'mainnet' ? 'mainnet' : 'testnet',
  });
}

describe('malformed Coinomi key round-trips through a saved derivation template', () => {
  beforeEach(async () => {
    await clearDerivationTemplates({ skipNotification: true });
  });

  it('stores the raw malformed zpub verbatim in the template', async () => {
    await saveTemplateLikeBulkImport(malformedZpub, 5);
    const templates = await getAllDerivationTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].xpub).toBe(malformedZpub);
    // The stored key still carries the Coinomi quirk - re-use MUST re-parse it.
    expect(hasNonStandardHeader(templates[0].xpub!)).toBe(true);
    expect(templates[0].scriptType).toBe('P2WPKH');
    expect(templates[0].network).toBe('mainnet');
    expect(templates[0].gapLimit).toBe(5);
  });

  it('re-derives the SAME addresses from the saved template with no error', async () => {
    // Import-time derivation (what the user saw and saved as address records).
    const original = await deriveDualChainAddresses(malformedZpub, 0, 4, 0, 4);
    await saveTemplateLikeBulkImport(malformedZpub, 5);

    // Template re-use: read the stored key back and re-derive from it.
    const [template] = await getAllDerivationTemplates();
    const rederived = await deriveDualChainAddresses(template.xpub!, 0, 4, 0, 4);

    expect(rederived.receive.map((a) => a.address)).toEqual(
      original.receive.map((a) => a.address)
    );
    expect(rederived.change.map((a) => a.address)).toEqual(
      original.change.map((a) => a.address)
    );
    expect(rederived.receive).toHaveLength(5);

    // And they match the corrected-header (strict-parse) derivation.
    const strict = await deriveDualChainAddresses(correctedZpub, 0, 4, 0, 4);
    expect(rederived.receive.map((a) => a.address)).toEqual(
      strict.receive.map((a) => a.address)
    );
  });

  it('re-analysis of the stored key succeeds without a validation error', async () => {
    await saveTemplateLikeBulkImport(malformedZpub, 5);
    const [template] = await getAllDerivationTemplates();
    const info = analyzeXpub(template.xpub!);
    expect(info.nonStandardHeader).toBe(true);
    expect(info.isAccountLevel).toBe(true);
    expect(info.needsAdvancedMode).toBe(false);
  });

  it('sanity: a well-formed key also round-trips unchanged', async () => {
    await saveTemplateLikeBulkImport(correctedZpub, 3);
    const [template] = await getAllDerivationTemplates();
    expect(template.xpub).toBe(correctedZpub);
    const rederived = await deriveDualChainAddresses(template.xpub!, 0, 1, 0, 1);
    expect(rederived.receive).toHaveLength(2);
  });
});
