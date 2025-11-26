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
 */
export function validateAddress(address: string): ValidationResult {
  try {
    const lowerAddress = address.toLowerCase();
    let network: 'mainnet' | 'testnet' = 'mainnet';
    let addressType: AddressType = 'Unknown';
    
    // Try Base58Check (P2PKH and P2SH)
    try {
      const decoded = bitcoin.address.fromBase58Check(address);
      
      // Detect network and type based on version byte
      if (decoded.version === 0x00) {
        // P2PKH mainnet
        network = 'mainnet';
        addressType = 'P2PKH';
      } else if (decoded.version === 0x6f) {
        // P2PKH testnet
        network = 'testnet';
        addressType = 'P2PKH';
      } else if (decoded.version === 0x05) {
        // P2SH mainnet
        network = 'mainnet';
        addressType = 'P2SH';
      } else if (decoded.version === 0xc4) {
        // P2SH testnet
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
      // Not a Base58Check address, try Bech32
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
      // Not a valid address
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
export function formatBTC(amount: number | string | undefined): string {
  if (amount === undefined || amount === null) return '0.00000000';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return num.toFixed(8);
}
