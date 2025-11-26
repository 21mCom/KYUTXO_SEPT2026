import * as bitcoin from 'bitcoinjs-lib';
import BIP32Factory from 'bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import bs58check from 'bs58check';

export interface DerivedAddress {
  index: number;
  address: string;
  path: string;
}

const XPUB_VERSIONS = {
  xpub: 0x0488b21e,
  ypub: 0x049d7cb2,
  zpub: 0x04b24746,
  tpub: 0x043587cf,
};

function getXpubType(xpub: string): 'xpub' | 'ypub' | 'zpub' | 'tpub' {
  if (xpub.startsWith('xpub')) return 'xpub';
  if (xpub.startsWith('ypub')) return 'ypub';
  if (xpub.startsWith('zpub')) return 'zpub';
  if (xpub.startsWith('tpub')) return 'tpub';
  throw new Error('Unsupported extended public key format. Must start with xpub, ypub, zpub, or tpub.');
}

function convertToXpub(extendedKey: string, type: 'xpub' | 'ypub' | 'zpub' | 'tpub'): string {
  if (type === 'xpub' || type === 'tpub') {
    return extendedKey;
  }
  
  const data = Buffer.from(bs58check.decode(extendedKey));
  data.writeUInt32BE(XPUB_VERSIONS.xpub, 0);
  
  return bs58check.encode(data);
}

export async function deriveAddressesFromXpub(
  extendedKey: string,
  derivationPath: string,
  count: number
): Promise<DerivedAddress[]> {
  const type = getXpubType(extendedKey);
  const network = type === 'tpub' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  
  const addresses: DerivedAddress[] = [];

  try {
    const bip32 = BIP32Factory(ecc);
    
    const convertedKey = convertToXpub(extendedKey, type);
    const node = bip32.fromBase58(convertedKey, network);
    
    for (let i = 0; i < count; i++) {
      const child = node.derive(i);
      
      let address: string;
      
      if (type === 'zpub') {
        const { address: p2wpkhAddress } = bitcoin.payments.p2wpkh({
          pubkey: child.publicKey,
          network,
        });
        address = p2wpkhAddress!;
      } else if (type === 'ypub') {
        const { address: p2shAddress } = bitcoin.payments.p2sh({
          redeem: bitcoin.payments.p2wpkh({
            pubkey: child.publicKey,
            network,
          }),
          network,
        });
        address = p2shAddress!;
      } else {
        const { address: p2pkhAddress } = bitcoin.payments.p2pkh({
          pubkey: child.publicKey,
          network,
        });
        address = p2pkhAddress!;
      }
      
      addresses.push({
        index: i,
        address,
        path: `${derivationPath}/${i}`,
      });
    }
    
    return addresses;
  } catch (error) {
    console.error('Derivation error:', error);
    throw new Error(`Failed to derive addresses: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function validateExtendedPublicKey(key: string): { valid: boolean; type?: string; error?: string } {
  try {
    const type = getXpubType(key);
    
    const decoded = bs58check.decode(key);
    if (decoded.length !== 78) {
      return { valid: false, error: 'Invalid key length' };
    }
    
    return { valid: true, type };
  } catch (error) {
    return { valid: false, error: 'Invalid extended public key format' };
  }
}
