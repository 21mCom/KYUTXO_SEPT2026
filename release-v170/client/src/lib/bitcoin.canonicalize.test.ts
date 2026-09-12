// Unit tests for canonicalizeRecordIdentifier / isMixedCaseBech32 (Task #1861).
//
// The canonicalizer is the shared definition of "the same record" across the
// UI duplicate check, sync find-or-create, wallet-import merges, provenance,
// fund-trail, and the fast-path search key. These tests pin down exactly
// which forms fold together and which must NOT (base58 case is meaningful).

import { describe, it, expect } from 'vitest';
import { canonicalizeRecordIdentifier, isMixedCaseBech32 } from './bitcoin';

const BECH32_LOWER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BASE58_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const BASE58_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const TXID_LOWER = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

describe('canonicalizeRecordIdentifier', () => {
  it('trims stray whitespace', () => {
    expect(canonicalizeRecordIdentifier(`  ${BECH32_LOWER}  `)).toBe(BECH32_LOWER);
    expect(canonicalizeRecordIdentifier(`\t${BASE58_P2PKH}\n`)).toBe(BASE58_P2PKH);
  });

  it('lowercases all-uppercase bech32', () => {
    expect(canonicalizeRecordIdentifier(BECH32_LOWER.toUpperCase())).toBe(BECH32_LOWER);
  });

  it('lowercases mixed-case bech32', () => {
    const mixed = 'bc1qW508D6qejXTDG4y5r3Zarvary0c5xw7KV8F3T4';
    expect(canonicalizeRecordIdentifier(mixed)).toBe(BECH32_LOWER);
  });

  it('lowercases testnet (tb1) and regtest (bcrt1) bech32', () => {
    const tb = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    expect(canonicalizeRecordIdentifier(tb.toUpperCase())).toBe(tb);
    const bcrt = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
    expect(canonicalizeRecordIdentifier(bcrt.toUpperCase())).toBe(bcrt);
  });

  it('leaves base58 addresses case-sensitive (trim only)', () => {
    // Case is meaningful in Base58Check — folding case would merge genuinely
    // different addresses, so only whitespace is stripped.
    expect(canonicalizeRecordIdentifier(BASE58_P2PKH)).toBe(BASE58_P2PKH);
    expect(canonicalizeRecordIdentifier(` ${BASE58_P2SH} `)).toBe(BASE58_P2SH);
    expect(canonicalizeRecordIdentifier(BASE58_P2PKH.toUpperCase())).toBe(
      BASE58_P2PKH.toUpperCase(),
    );
  });

  it('lowercases uppercase-hex transaction IDs', () => {
    expect(canonicalizeRecordIdentifier(TXID_LOWER.toUpperCase())).toBe(TXID_LOWER);
    expect(canonicalizeRecordIdentifier(`  ${TXID_LOWER.toUpperCase()} `)).toBe(TXID_LOWER);
  });

  it('lowercases the txid part of outpoint identifiers (txid:vout)', () => {
    expect(canonicalizeRecordIdentifier(`${TXID_LOWER.toUpperCase()}:0`)).toBe(
      `${TXID_LOWER}:0`,
    );
    expect(canonicalizeRecordIdentifier(`  ${TXID_LOWER.toUpperCase()}:15 `)).toBe(
      `${TXID_LOWER}:15`,
    );
    expect(canonicalizeRecordIdentifier(`${TXID_LOWER}:3`)).toBe(`${TXID_LOWER}:3`);
    // Non-outpoint colon strings stay verbatim
    expect(canonicalizeRecordIdentifier('ABC:0')).toBe('ABC:0');
    expect(canonicalizeRecordIdentifier(`${TXID_LOWER.toUpperCase()}:x`)).toBe(
      `${TXID_LOWER.toUpperCase()}:x`,
    );
  });

  it('trims but otherwise leaves free-form strings alone', () => {
    expect(canonicalizeRecordIdentifier('  Some Custom Identifier  ')).toBe(
      'Some Custom Identifier',
    );
  });

  it('handles empty and blank input', () => {
    expect(canonicalizeRecordIdentifier('')).toBe('');
    expect(canonicalizeRecordIdentifier('   ')).toBe('');
  });
});

describe('isMixedCaseBech32', () => {
  it('is true for mixed-case bech32', () => {
    expect(isMixedCaseBech32('bc1qW508D6qejXTDG4y5r3Zarvary0c5xw7KV8F3T4')).toBe(true);
  });

  it('is false for all-lower and all-upper bech32', () => {
    expect(isMixedCaseBech32(BECH32_LOWER)).toBe(false);
    expect(isMixedCaseBech32(BECH32_LOWER.toUpperCase())).toBe(false);
  });

  it('is false for base58 and txids even when they mix case', () => {
    expect(isMixedCaseBech32(BASE58_P2PKH)).toBe(false);
    expect(isMixedCaseBech32(TXID_LOWER.toUpperCase())).toBe(false);
  });
});
