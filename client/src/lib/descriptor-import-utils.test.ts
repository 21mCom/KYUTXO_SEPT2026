import { describe, it, expect } from 'vitest';
import {
  analyzeDescriptorInput,
  computeExistingRecordMerge,
  describeKeptFieldCounts,
} from './descriptor-import-utils';

// Representative key expressions (fake-but-well-formed xpubs are fine for
// parse-level tests; derivation is not exercised here).
const KEY1 =
  "[aabbccdd/48'/0'/0'/2']xpub6DUcLc2N3S1sQxOnEkKfeq8hVkjuA5U2DSXBUvBHzeqWaKrKPn5CJZZUYtQVGh3xkGYPGZZKfLRJTM2mFf1U8h9M6FN8DlPMFqXHqcQtG7a/**";
const KEY2 =
  "[11223344/48'/0'/0'/2']xpub6Ct8ZvGYA4Zt6mbNXFbL61Er2ZZZTAAKW1cCz54sBzNAeM9nWHpFYqkJVLBHVkG3bYbG7hzUgXCptnHR47dwHrE2H8Q3D6vN9YLap0kVjZ4/**";

const NUNCHUK_BSMS = [
  'BSMS 1.0',
  `wsh(sortedmulti(2,${KEY1},${KEY2}))`,
  '/0/*,/1/*',
  'bc1qxr9dzr64gjsestfz7ll985694rmxsanpq93pnkg3sgv40rnkkyzscf20fs',
].join('\r\n') + '\r\n\r\n';

describe('analyzeDescriptorInput', () => {
  it('parses a realistic Nunchuk BSMS file (CRLF, /** wildcard, trailing blank lines)', () => {
    const res = analyzeDescriptorInput(NUNCHUK_BSMS, 'wallet.bsms');
    expect(res.ok).toBe(true);
    expect(res.source).toBe('bsms');
    expect(res.suggestedSoftware).toBe('Nunchuk');
    expect(res.firstAddress).toBe(
      'bc1qxr9dzr64gjsestfz7ll985694rmxsanpq93pnkg3sgv40rnkkyzscf20fs',
    );
    expect(res.descriptor?.isMultisig).toBe(true);
    expect(res.descriptor?.threshold).toBe(2);
    expect(res.descriptor?.keys).toHaveLength(2);
    // BSMS unified wildcard /** must be recognized as dual-chain
    expect(res.descriptor?.chainType).toBe('dual-chain');
  });

  it('recognizes BSMS content pasted without a filename', () => {
    const res = analyzeDescriptorInput(NUNCHUK_BSMS, '');
    expect(res.ok).toBe(true);
    expect(res.source).toBe('bsms');
  });

  it('BSMS with a single-sig wpkh descriptor offers an Address Importer handoff (not a generic multisig error)', () => {
    const content = [
      'BSMS 1.0',
      "wpkh([aabbccdd/84'/0'/0']xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8/**)",
      'No path restrictions',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    ].join('\n');
    const res = analyzeDescriptorInput(content, 'single.bsms');
    expect(res.ok).toBe(false);
    expect(res.source).toBe('bsms');
    expect(res.singleSig?.scriptType).toBe('p2wpkh');
    expect(res.singleSig?.chainType).toBe('dual-chain');
    expect(res.error).toMatch(/single-signature/i);
    expect(res.error).not.toMatch(/multisig content/i);
  });

  it('surfaces the BSMS parse error for a corrupt BSMS file', () => {
    const res = analyzeDescriptorInput('BSMS 1.0\nnot-a-descriptor\n', 'bad.bsms');
    expect(res.ok).toBe(false);
    expect(res.source).toBe('bsms');
    expect(res.error).toMatch(/descriptor/i);
  });

  it('parses a Sparrow JSON export and carries the wallet label', () => {
    const json = JSON.stringify({
      label: 'Family Vault',
      descriptor: `wsh(sortedmulti(2,${KEY1.replace('/**', '/0/*')},${KEY2.replace('/**', '/0/*')}))#abcd1234`,
    });
    const res = analyzeDescriptorInput(json, 'export.json');
    expect(res.ok).toBe(true);
    expect(res.source).toBe('sparrow');
    expect(res.walletLabel).toBe('Family Vault');
    expect(res.descriptor?.chainType).toBe('receive-only');
  });

  it('reports a clear error for JSON without any descriptor', () => {
    const res = analyzeDescriptorInput('{"foo": "bar"}', 'export.json');
    expect(res.ok).toBe(false);
    expect(res.source).toBe('sparrow');
    expect(res.error).toMatch(/descriptor/i);
  });

  it('parses a pasted raw descriptor', () => {
    const res = analyzeDescriptorInput(
      `wsh(sortedmulti(2,${KEY1.replace('/**', '/<0;1>/*')},${KEY2.replace('/**', '/<0;1>/*')}))`,
      '',
    );
    expect(res.ok).toBe(true);
    expect(res.source).toBe('raw');
    expect(res.descriptor?.chainType).toBe('dual-chain');
  });

  it('fails with an error for garbage and for empty input', () => {
    expect(analyzeDescriptorInput('garbage input', '').ok).toBe(false);
    expect(analyzeDescriptorInput('garbage input', '').error).toBeTruthy();
    expect(analyzeDescriptorInput('', '').ok).toBe(false);
    expect(analyzeDescriptorInput('   ', '').error).toMatch(/empty/i);
  });
});

describe('computeExistingRecordMerge', () => {
  const entered = {
    owner: 'Alice',
    walletName: 'Vault A',
    seedName: 'Seed 1',
    walletSoftware: 'Nunchuk',
    notes: 'imported via BSMS',
    tags: ['multisig', 'cold'],
    categories: ['savings'],
  };

  it('keeps existing scalar values and reports them as kept', () => {
    const merge = computeExistingRecordMerge(
      {
        owner: 'Bob',
        notes: 'old note',
        tags: ['multisig', 'legacy'],
        categories: [],
      },
      entered,
    );
    expect(merge.fields.owner).toBe('Bob');
    expect(merge.fields.notes).toBe('old note');
    expect(merge.keptFields).toEqual(expect.arrayContaining(['owner', 'notes']));
    // blank existing fields take the user's entry
    expect(merge.fields.walletName).toBe('Vault A');
    expect(merge.fields.seedName).toBe('Seed 1');
    expect(merge.fields.walletSoftware).toBe('Nunchuk');
    expect(merge.appliedFields).toEqual(
      expect.arrayContaining(['walletName', 'seedName', 'walletSoftware']),
    );
    // tags/categories are unioned
    expect(merge.tags.sort()).toEqual(['cold', 'legacy', 'multisig']);
    expect(merge.categories).toEqual(['savings']);
  });

  it('does not report a kept field when values are identical or entry is blank', () => {
    const merge = computeExistingRecordMerge(
      { owner: 'Alice', walletName: 'Old Vault' },
      { ...entered, walletName: '' },
    );
    expect(merge.keptFields).toEqual([]);
    expect(merge.fields.walletName).toBe('Old Vault');
  });

  it('leaves blank fields undefined when nothing was entered', () => {
    const merge = computeExistingRecordMerge({}, {
      tags: [],
      categories: [],
    });
    expect(merge.fields.owner).toBeUndefined();
    expect(merge.keptFields).toEqual([]);
    expect(merge.appliedFields).toEqual([]);
  });
});

describe('describeKeptFieldCounts', () => {
  it('formats non-zero counts with labels and pluralization', () => {
    const lines = describeKeptFieldCounts({ owner: 3, notes: 1 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Owner: kept the existing value on 3 addresses/);
    expect(lines[1]).toMatch(/Notes: kept the existing value on 1 address$/);
  });

  it('returns no lines when nothing was kept', () => {
    expect(describeKeptFieldCounts({})).toEqual([]);
  });
});

// ── Single-sig descriptor handling ──────────────────────────────────────────
// Real (checksum-valid) keys: BIP32 test-vector xpub and BIP84 test-vector zpub.
const REAL_XPUB =
  'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
const REAL_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

import {
  buildBulkImportHandoffUrl,
  parseBulkImportHandoffParams,
  singleSigTargetPrefix,
} from './descriptor-import-utils';
import { parseSingleSigDescriptor, parseDescriptor } from './descriptor-parser';

describe('parseSingleSigDescriptor', () => {
  it('parses wpkh with key origin, <0;1> wildcard, and checksum', () => {
    const res = parseSingleSigDescriptor(
      `wpkh([aabbccdd/84'/0'/0']${REAL_XPUB}/<0;1>/*)#abcd1234`,
    );
    expect(res.success).toBe(true);
    expect(res.descriptor?.scriptType).toBe('p2wpkh');
    expect(res.descriptor?.key.fingerprint).toBe('aabbccdd');
    expect(res.descriptor?.key.derivationPath).toBe("84'/0'/0'");
    expect(res.descriptor?.key.xpub).toBe(REAL_XPUB);
    expect(res.descriptor?.chainType).toBe('dual-chain');
    expect(res.descriptor?.network).toBe('mainnet');
  });

  it('parses plain pkh(xpub) without origin as receive-only when /0/*', () => {
    const res = parseSingleSigDescriptor(`pkh(${REAL_XPUB}/0/*)`);
    expect(res.success).toBe(true);
    expect(res.descriptor?.scriptType).toBe('p2pkh');
    expect(res.descriptor?.key.fingerprint).toBe('00000000');
    expect(res.descriptor?.chainType).toBe('receive-only');
  });

  it('parses sh(wpkh(...)) as nested segwit', () => {
    const res = parseSingleSigDescriptor(
      `sh(wpkh([11223344/49'/0'/0']${REAL_XPUB}/0/*))#deadbeef`,
    );
    expect(res.success).toBe(true);
    expect(res.descriptor?.scriptType).toBe('p2sh-p2wpkh');
    expect(res.descriptor?.key.fingerprint).toBe('11223344');
  });

  it('parses zpub-based wpkh and BSMS /** unified wildcard as dual-chain', () => {
    const res = parseSingleSigDescriptor(`wpkh(${REAL_ZPUB}/**)`);
    expect(res.success).toBe(true);
    expect(res.descriptor?.scriptType).toBe('p2wpkh');
    expect(res.descriptor?.chainType).toBe('dual-chain');
  });

  it('rejects a malformed key with a helpful error', () => {
    const res = parseSingleSigDescriptor('wpkh(notakey/0/*)');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/extended public key/i);
  });

  it('rejects a checksum-invalid xpub via existing xpub validation', () => {
    const corrupted = REAL_XPUB.slice(0, -4) + 'aaaa';
    const res = parseSingleSigDescriptor(`wpkh(${corrupted}/0/*)`);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/invalid/i);
  });
});

describe('parseDescriptor single-sig integration', () => {
  it('returns singleSig payload (success=false) for a valid wpkh descriptor', () => {
    const res = parseDescriptor(`wpkh([aabbccdd/84'/0'/0']${REAL_XPUB}/<0;1>/*)`);
    expect(res.success).toBe(false);
    expect(res.singleSig?.scriptType).toBe('p2wpkh');
    expect(res.error).toMatch(/single-signature/i);
  });

  it('analyzeDescriptorInput surfaces singleSig for raw pasted content', () => {
    const res = analyzeDescriptorInput(`wpkh(${REAL_XPUB}/<0;1>/*)`, '');
    expect(res.ok).toBe(false);
    expect(res.singleSig?.scriptType).toBe('p2wpkh');
    expect(res.singleSig?.chainType).toBe('dual-chain');
  });

  it('still errors (no singleSig) for a genuinely malformed wpkh descriptor', () => {
    const res = analyzeDescriptorInput('wpkh(garbage)', '');
    expect(res.ok).toBe(false);
    expect(res.singleSig).toBeUndefined();
    expect(res.error).toBeTruthy();
  });
});

describe('Address Importer handoff', () => {
  it('re-encodes the key to match the script type and round-trips via URL params', () => {
    const parsed = parseSingleSigDescriptor(
      `wpkh([aabbccdd/84'/0'/0']${REAL_XPUB}/<0;1>/*)`,
    );
    const url = buildBulkImportHandoffUrl(parsed.descriptor!);
    expect(url.startsWith('/import?')).toBe(true);
    const handoff = parseBulkImportHandoffParams(url.split('?')[1]);
    expect(handoff).not.toBeNull();
    // wpkh + xpub-prefixed key must arrive as a zpub so prefix-driven
    // derivation produces bc1q addresses as the descriptor specifies.
    expect(handoff!.xpub.startsWith('zpub')).toBe(true);
    expect(handoff!.scriptType).toBe('p2wpkh');
    expect(handoff!.chainType).toBe('dual-chain');
    expect(handoff!.fingerprint).toBe('aabbccdd');
    expect(handoff!.derivationPath).toBe("84'/0'/0'");
  });

  it('keeps an already-matching prefix unchanged', () => {
    const parsed = parseSingleSigDescriptor(`wpkh(${REAL_ZPUB}/**)`);
    const url = buildBulkImportHandoffUrl(parsed.descriptor!);
    const handoff = parseBulkImportHandoffParams(url.split('?')[1]);
    expect(handoff!.xpub).toBe(REAL_ZPUB);
  });

  it('singleSigTargetPrefix maps script types on both networks', () => {
    expect(singleSigTargetPrefix('p2wpkh', 'mainnet')).toBe('zpub');
    expect(singleSigTargetPrefix('p2wpkh', 'testnet')).toBe('vpub');
    expect(singleSigTargetPrefix('p2sh-p2wpkh', 'mainnet')).toBe('ypub');
    expect(singleSigTargetPrefix('p2pkh', 'testnet')).toBe('tpub');
  });

  it('parseBulkImportHandoffParams ignores unrelated query strings', () => {
    expect(parseBulkImportHandoffParams('')).toBeNull();
    expect(parseBulkImportHandoffParams('?foo=bar')).toBeNull();
    expect(parseBulkImportHandoffParams('?source=descriptor')).toBeNull();
  });
});
