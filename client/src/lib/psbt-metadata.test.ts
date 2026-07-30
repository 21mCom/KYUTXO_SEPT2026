import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Record as DbRecord, DerivationTemplate } from './database';
import { createRecord, clearAllRecords } from './data/record-crud';
import { clearParticipants } from './data/transaction-crud';
import {
  detectInputScriptType,
  resolveInputDerivation,
  suggestFreshChangeAddress,
} from './psbt-metadata';

// BIP-84 test-vector account (mnemonic "abandon … about").
const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const ADDR_W0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/84'/0'/0'/0/0
const ADDR_W0_PUBKEY = '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c';
const ADDR_CHANGE0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/84'/0'/0'/1/0
const ADDR_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ADDR_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const ADDR_TR0 = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

function record(overrides: Partial<DbRecord>): DbRecord {
  return {
    type: 'address',
    inputString: ADDR_W0,
    label: '',
    tags: [],
    categories: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as DbRecord;
}

beforeEach(async () => {
  await clearAllRecords();
  await clearParticipants();
});

describe('detectInputScriptType', () => {
  it('detects types from the address format alone', () => {
    expect(detectInputScriptType(ADDR_W0)).toBe('P2WPKH');
    expect(detectInputScriptType(ADDR_P2PKH)).toBe('P2PKH');
    expect(detectInputScriptType(ADDR_TR0)).toBe('P2TR');
    expect(detectInputScriptType('not-an-address')).toBe('Unknown');
  });

  it('refines P2SH using the record xpub prefix and vault metadata', () => {
    expect(detectInputScriptType(ADDR_P2SH)).toBe('P2SH');
    expect(
      detectInputScriptType(ADDR_P2SH, record({ inputString: ADDR_P2SH, xpub: 'ypub6Ww3ibxVfGzL…' })),
    ).toBe('P2SH-P2WPKH');
    expect(
      detectInputScriptType(
        ADDR_P2SH,
        record({ inputString: ADDR_P2SH, vault: { isVaultXpub: true, m: 2, n: 3 } }),
      ),
    ).toBe('P2SH-P2WSH');
  });
});

describe('resolveInputDerivation', () => {
  it('returns undefined without a matching template — the true master fingerprint is never fabricated', () => {
    const info = resolveInputDerivation(
      record({ xpub: ZPUB, derivationPath: "m/84'/0'/0'/0/0" }),
      'P2WPKH',
      [],
    );
    expect(info).toBeUndefined();
  });

  it('prefers the template fingerprint and rebuilds the full path from it', () => {
    const template = {
      fingerprint: '73c5da0a',
      scriptType: 'P2WPKH',
      derivationPath: "m/84'/0'/0'",
      xpub: ZPUB,
      gapLimit: 20,
      network: 'mainnet',
      createdAt: 1,
      updatedAt: 1,
    } as DerivationTemplate;
    const info = resolveInputDerivation(
      record({ xpub: ZPUB, derivationPath: '0/0' }),
      'P2WPKH',
      [template],
    );
    expect(info).toBeDefined();
    expect(info!.masterFingerprintHex).toBe('73c5da0a');
    expect(info!.path).toBe("m/84'/0'/0'/0/0");
    expect(info!.pubkeyHex).toBe(ADDR_W0_PUBKEY);
  });

  it('returns undefined when the derived key does not reproduce the address', () => {
    // Path points at index 5, but the record address is index 0's. A matching
    // template is present, so the ONLY reason to withhold info is the mismatch.
    const template = {
      fingerprint: '73c5da0a',
      scriptType: 'P2WPKH',
      derivationPath: "m/84'/0'/0'",
      xpub: ZPUB,
      gapLimit: 20,
      network: 'mainnet',
      createdAt: 1,
      updatedAt: 1,
    } as DerivationTemplate;
    const info = resolveInputDerivation(
      record({ xpub: ZPUB, derivationPath: "m/84'/0'/0'/0/5" }),
      'P2WPKH',
      [template],
    );
    expect(info).toBeUndefined();
  });

  it('returns undefined for vault records, missing xpub, or missing path', () => {
    expect(
      resolveInputDerivation(
        record({ xpub: ZPUB, derivationPath: '0/0', vault: { isVaultXpub: true } }),
        'P2WPKH',
        [],
      ),
    ).toBeUndefined();
    expect(resolveInputDerivation(record({ derivationPath: '0/0' }), 'P2WPKH', [])).toBeUndefined();
    expect(resolveInputDerivation(record({ xpub: ZPUB }), 'P2WPKH', [])).toBeUndefined();
    expect(resolveInputDerivation(undefined, 'P2WPKH', [])).toBeUndefined();
  });
});

describe('suggestFreshChangeAddress', () => {
  it('returns the first unused change-chain address for a single-xpub selection', async () => {
    const suggestion = await suggestFreshChangeAddress([
      record({ xpub: ZPUB, derivationPath: "m/84'/0'/0'/0/0" }),
      record({ inputString: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', xpub: ZPUB, derivationPath: "m/84'/0'/0'/0/1" }),
    ]);
    expect(suggestion).toBe(ADDR_CHANGE0);
  });

  it('skips change addresses that already have records, returning the next fresh one', async () => {
    // The change-0 address is already tracked (but never used) — the suggestion
    // must move to change index 1.
    await createRecord({
      type: 'address',
      inputString: ADDR_CHANGE0,
      label: '',
      tags: [],
      categories: [],
      xpub: ZPUB,
      derivationPath: "m/84'/0'/0'/1/0",
    });
    const suggestion = await suggestFreshChangeAddress([record({ xpub: ZPUB, derivationPath: '0/0' })]);
    expect(suggestion).toBeDefined();
    expect(suggestion).not.toBe(ADDR_CHANGE0);
  });

  it('returns undefined when the selection spans multiple xpubs or only vaults', async () => {
    expect(
      await suggestFreshChangeAddress([
        record({ xpub: ZPUB }),
        record({ xpub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYt' }),
      ]),
    ).toBeUndefined();
    expect(
      await suggestFreshChangeAddress([record({ xpub: ZPUB, vault: { isVaultXpub: true } })]),
    ).toBeUndefined();
    expect(await suggestFreshChangeAddress([undefined])).toBeUndefined();
  });
});
