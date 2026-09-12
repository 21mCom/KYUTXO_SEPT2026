import { describe, it, expect } from 'vitest';
import { scanForPrivateKeys } from './import-manager';

// Build a plausible extended-private-key string: prefix + 107 base58-ish chars
// (real xprv strings are ~111 chars total).
const key = (prefix: string) =>
  `${prefix}${'9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUt'.repeat(2).slice(0, 107)}`;

describe('scanForPrivateKeys extended private key prefixes', () => {
  const prefixes = [
    'xprv', // BIP-32 mainnet
    'tprv', // BIP-32 testnet
    'yprv', // SLIP-132 P2SH-P2WPKH mainnet
    'uprv', // SLIP-132 P2SH-P2WPKH testnet
    'zprv', // SLIP-132 P2WPKH mainnet
    'vprv', // SLIP-132 P2WPKH testnet
    'Yprv', // SLIP-132 multisig P2SH-P2WSH mainnet
    'Uprv', // SLIP-132 multisig testnet
    'Zprv', // SLIP-132 multisig P2WSH mainnet
    'Vprv', // SLIP-132 multisig testnet
  ];

  for (const prefix of prefixes) {
    it(`rejects ${prefix} extended private keys`, () => {
      const result = scanForPrivateKeys(`label,addr\nfoo,${key(prefix)}\n`);
      expect(result.hasPrivateKeys).toBe(true);
      expect(result.warnings.some((w) => w.includes('extended private keys'))).toBe(true);
    });
  }

  it('does not flag extended PUBLIC keys (xpub/ypub/zpub/tpub/upub/vpub)', () => {
    for (const prefix of ['xpub', 'ypub', 'zpub', 'tpub', 'upub', 'vpub', 'Ypub', 'Zpub']) {
      const result = scanForPrivateKeys(`descriptor: ${key(prefix).replace('prv', 'pub')}`);
      expect(result.hasPrivateKeys).toBe(false);
    }
  });

  it('does not flag short strings that merely start with a prv prefix', () => {
    const result = scanForPrivateKeys('note about zprv format and yprv keys in general');
    expect(result.hasPrivateKeys).toBe(false);
  });

  it('still flags PEM private key material', () => {
    const result = scanForPrivateKeys('-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----');
    expect(result.hasPrivateKeys).toBe(true);
  });
});
