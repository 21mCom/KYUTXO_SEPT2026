import * as bitcoin from 'bitcoinjs-lib';

export type AddressType = 'P2PKH' | 'P2WPKH' | 'P2SH' | 'P2WSH' | 'P2TR' | 'Unknown';

export interface ValidationResult {
  isValid: boolean;
  type?: 'address' | 'transaction';
  addressType?: AddressType;
  network?: 'mainnet' | 'testnet';
  error?: string;
}

/**
 * Validates a Bitcoin address or transaction ID
 */
export function validateBitcoinInput(input: string): ValidationResult {
  if (!input || typeof input !== 'string') {
    return { isValid: false, error: 'Input is required' };
  }

  const trimmed = input.trim();

  // Check if it's a transaction ID (64 hex characters)
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    return {
      isValid: true,
      type: 'transaction',
    };
  }

  // Try to validate as Bitcoin address
  try {
    const addressValidation = validateAddress(trimmed);
    if (addressValidation.isValid) {
      return {
        isValid: true,
        type: 'address',
        addressType: addressValidation.addressType,
        network: addressValidation.network,
      };
    }
  } catch (error) {
    // Continue to error return below
  }

  return {
    isValid: false,
    error: 'Invalid Bitcoin address or transaction ID',
  };
}

/**
 * Validates a Bitcoin address and detects its type
 * Uses lenient validation - accepts addresses with correct format even if checksum fails
 */
export function validateAddress(address: string): ValidationResult {
  try {
    let network: 'mainnet' | 'testnet' = 'mainnet';
    let addressType: AddressType = 'Unknown';
    
    // Try strict Base58Check validation first (P2PKH and P2SH)
    try {
      const decoded = bitcoin.address.fromBase58Check(address);
      
      // Detect network and type based on version byte
      if (decoded.version === 0x00) {
        network = 'mainnet';
        addressType = 'P2PKH';
      } else if (decoded.version === 0x6f) {
        network = 'testnet';
        addressType = 'P2PKH';
      } else if (decoded.version === 0x05) {
        network = 'mainnet';
        addressType = 'P2SH';
      } else if (decoded.version === 0xc4) {
        network = 'testnet';
        addressType = 'P2SH';
      }
      
      return {
        isValid: true,
        type: 'address',
        addressType,
        network,
      };
    } catch {
      // Strict validation failed, try lenient format-based validation for legacy addresses
    }
    
    // Lenient validation for legacy addresses (format check only)
    // P2PKH mainnet: starts with 1, 25-34 chars
    if (/^1[a-km-zA-HJ-NP-Z1-9]{25,33}$/.test(address)) {
      return {
        isValid: true,
        type: 'address',
        addressType: 'P2PKH',
        network: 'mainnet',
      };
    }
    
    // P2SH mainnet: starts with 3, 25-34 chars  
    if (/^3[a-km-zA-HJ-NP-Z1-9]{25,33}$/.test(address)) {
      return {
        isValid: true,
        type: 'address',
        addressType: 'P2SH',
        network: 'mainnet',
      };
    }
    
    // P2PKH/P2SH testnet: starts with m, n, or 2
    if (/^[mn2][a-km-zA-HJ-NP-Z1-9]{25,33}$/.test(address)) {
      return {
        isValid: true,
        type: 'address',
        addressType: address.startsWith('2') ? 'P2SH' : 'P2PKH',
        network: 'testnet',
      };
    }
    
    // Try Bech32 (SegWit addresses)
    try {
      const decoded = bitcoin.address.fromBech32(address);
      
      // Detect network from prefix
      if (decoded.prefix === 'bc') {
        network = 'mainnet';
      } else if (decoded.prefix === 'tb') {
        network = 'testnet';
      }
      
      // Detect type based on witness version and data length
      if (decoded.version === 0) {
        if (decoded.data.length === 20) {
          addressType = 'P2WPKH';
        } else if (decoded.data.length === 32) {
          addressType = 'P2WSH';
        }
      } else if (decoded.version === 1 && decoded.data.length === 32) {
        addressType = 'P2TR';
      }
      
      return {
        isValid: true,
        type: 'address',
        addressType,
        network,
      };
    } catch {
      // Not a valid Bech32 address
    }
    
    // Lenient Bech32 format check
    if (/^bc1[a-z0-9]{25,87}$/i.test(address)) {
      return {
        isValid: true,
        type: 'address',
        addressType: address.length === 42 ? 'P2WPKH' : 'P2WSH',
        network: 'mainnet',
      };
    }
    
    if (/^tb1[a-z0-9]{25,87}$/i.test(address)) {
      return {
        isValid: true,
        type: 'address',
        addressType: address.length === 42 ? 'P2WPKH' : 'P2WSH',
        network: 'testnet',
      };
    }

    return {
      isValid: false,
      error: 'Invalid Bitcoin address format',
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

/**
 * Canonical storage form for a record identifier (address or transaction ID):
 *
 * - Surrounding whitespace is stripped.
 * - Transaction IDs (64 hex chars) are lowercased — hex case carries no meaning.
 * - Bech32/bech32m addresses (bc1…/tb1…/bcrt1…) are lowercased — BIP-173 makes
 *   them case-insensitive (all-lower and all-upper are both valid encodings of
 *   the same address).
 * - Base58 addresses (1…/3…/m…/n…/2…) are returned trimmed but otherwise
 *   untouched — case is meaningful in Base58Check, so "the same characters in
 *   different case" are genuinely different addresses.
 *
 * Every write path (record CRUD) stores this form and every exact-match lookup
 * (sync find-or-create, wallet-import merge, provenance, fund-trail, search)
 * canonicalizes its key the same way, so all subsystems agree on record
 * identity no matter how the identifier was typed or pasted.
 */
export function canonicalizeRecordIdentifier(input: string): string {
  if (!input || typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  const outpointMatch = trimmed.match(/^([a-fA-F0-9]{64}):(\d+)$/);
  if (outpointMatch) return `${outpointMatch[1].toLowerCase()}:${outpointMatch[2]}`;
  if (/^(?:bc|tb|bcrt)1[a-z0-9]+$/i.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

/**
 * True when the input looks like a bech32/bech32m address written with mixed
 * case. Mixed case is invalid per BIP-173 (which demands all-lower or
 * all-upper) but is tolerated by the app's intentionally lenient checksum
 * policy; the record will be saved in its lowercase canonical form. Used to
 * surface a non-blocking paste warning in the record form.
 */
export function isMixedCaseBech32(input: string): boolean {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!/^(?:bc|tb|bcrt)1[a-z0-9]+$/i.test(trimmed)) return false;
  return /[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed);
}

/**
 * Truncates a Bitcoin address for display
 */
export function truncateAddress(address: string, startChars = 10, endChars = 10): string {
  if (address.length <= startChars + endChars) {
    return address;
  }
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/**
 * Formats BTC amount with proper decimal places
 */
export function formatBTC(sats: number | string | undefined): string {
  if (sats === undefined || sats === null) return '0.00000000';
  const num = typeof sats === 'string' ? parseFloat(sats) : sats;
  return (num / 100_000_000).toFixed(8);
}
