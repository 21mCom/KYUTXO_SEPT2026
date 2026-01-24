import * as bitcoin from 'bitcoinjs-lib';
import BIP32Factory from 'bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import bs58check from 'bs58check';

export type ChainType = 'receive' | 'change';

export interface DerivedAddress {
  index: number;
  address: string;
  path: string;
  chainType: ChainType;
  chainLabel: string;
}

export interface DualChainResult {
  receive: DerivedAddress[];
  change: DerivedAddress[];
  xpub: string;
  bipStandard: BipStandard;
  network: 'mainnet' | 'testnet';
}

export interface XpubInfo {
  prefix: XpubPrefix;
  bipStandard: BipStandard;
  network: 'mainnet' | 'testnet';
  suggestedPath: string;
  depth: number;
  isAccountLevel: boolean;
  isChainLevel: boolean;
  needsAdvancedMode: boolean;
  reason?: string;
  parentFingerprint?: string;
}

export type XpubPrefix = 'xpub' | 'ypub' | 'zpub' | 'tpub' | 'upub' | 'vpub';
export type BipStandard = 'BIP44' | 'BIP49' | 'BIP84' | 'BIP86' | 'unknown';

const XPUB_VERSIONS: Record<string, number> = {
  xpub: 0x0488b21e,
  ypub: 0x049d7cb2,
  zpub: 0x04b24746,
  tpub: 0x043587cf,
  upub: 0x044a5262,
  vpub: 0x045f1cf6,
};

const PREFIX_TO_BIP: Record<XpubPrefix, { bip: BipStandard; network: 'mainnet' | 'testnet'; accountPath: string }> = {
  xpub: { bip: 'BIP44', network: 'mainnet', accountPath: "m/44'/0'/0'" },
  ypub: { bip: 'BIP49', network: 'mainnet', accountPath: "m/49'/0'/0'" },
  zpub: { bip: 'BIP84', network: 'mainnet', accountPath: "m/84'/0'/0'" },
  tpub: { bip: 'BIP44', network: 'testnet', accountPath: "m/44'/1'/0'" },
  upub: { bip: 'BIP49', network: 'testnet', accountPath: "m/49'/1'/0'" },
  vpub: { bip: 'BIP84', network: 'testnet', accountPath: "m/84'/1'/0'" },
};

function getXpubPrefix(xpub: string): XpubPrefix {
  const trimmed = xpub.trim();
  if (trimmed.startsWith('xpub')) return 'xpub';
  if (trimmed.startsWith('ypub')) return 'ypub';
  if (trimmed.startsWith('zpub')) return 'zpub';
  if (trimmed.startsWith('tpub')) return 'tpub';
  if (trimmed.startsWith('upub')) return 'upub';
  if (trimmed.startsWith('vpub')) return 'vpub';
  throw new Error('Unsupported extended public key format. Supported: xpub, ypub, zpub, tpub, upub, vpub.');
}

function writeUInt32BE(data: Uint8Array, value: number, offset: number): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

function convertToXpub(extendedKey: string, prefix: XpubPrefix): string {
  if (prefix === 'xpub') {
    return extendedKey;
  }
  
  const network = PREFIX_TO_BIP[prefix].network;
  const targetVersion = network === 'testnet' ? XPUB_VERSIONS.tpub : XPUB_VERSIONS.xpub;
  
  const decoded = bs58check.decode(extendedKey);
  const data = new Uint8Array(decoded);
  writeUInt32BE(data, targetVersion, 0);
  
  return bs58check.encode(data);
}

function getKeyDepth(extendedKey: string): number {
  try {
    const decoded = bs58check.decode(extendedKey);
    return decoded[4];
  } catch {
    return -1;
  }
}

function getParentFingerprint(extendedKey: string): string | undefined {
  try {
    const decoded = bs58check.decode(extendedKey);
    // Parent fingerprint is bytes 5-8 (4 bytes after version and depth)
    const fingerprint = decoded.slice(5, 9);
    return Array.from(fingerprint).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

export function analyzeXpub(extendedKey: string): XpubInfo {
  const trimmed = extendedKey.trim();
  const prefix = getXpubPrefix(trimmed);
  const prefixInfo = PREFIX_TO_BIP[prefix];
  const depth = getKeyDepth(trimmed);
  const parentFingerprint = getParentFingerprint(trimmed);
  
  const isAccountLevel = depth === 3;
  const isChainLevel = depth === 4;
  // Depth 0-2: Could be Electrum native wallet format (depth 0 or 1) or partial derivation
  const isElectrumStyle = depth === 0 || depth === 1;
  const isPartialDerivation = depth === 2;
  
  let needsAdvancedMode = false;
  let reason: string | undefined;
  let suggestedPath = "0";
  
  if (isElectrumStyle) {
    // Electrum native wallets export zpub at depth 0 or 1
    // They use simple derivation: 0/<n> for receive, 1/<n> for change
    needsAdvancedMode = false;
    suggestedPath = "0";
    reason = 'Detected Electrum-style key (depth ' + depth + '). Using standard Electrum paths: 0/<n> for receive, 1/<n> for change.';
  } else if (isPartialDerivation) {
    // Depth 2 is unusual - might need user input
    needsAdvancedMode = true;
    reason = 'Key is at depth 2 (unusual). You may need to specify derivation paths in advanced mode.';
    suggestedPath = "0/0";
  } else if (isChainLevel) {
    // Depth 4: Already at chain level (e.g., m/84'/0'/0'/0)
    suggestedPath = "";
  } else if (isAccountLevel) {
    // Depth 3: Standard account level (e.g., m/84'/0'/0')
    suggestedPath = "0";
  }
  
  return {
    prefix,
    bipStandard: prefixInfo.bip,
    network: prefixInfo.network,
    suggestedPath,
    depth,
    isAccountLevel,
    isChainLevel,
    needsAdvancedMode,
    reason,
    parentFingerprint,
  };
}

export async function deriveAddressesForChain(
  extendedKey: string,
  chain: 0 | 1,
  startIndex: number = 0,
  endIndex: number = 19
): Promise<DerivedAddress[]> {
  const trimmed = extendedKey.trim();
  const prefix = getXpubPrefix(trimmed);
  const prefixInfo = PREFIX_TO_BIP[prefix];
  const network = prefixInfo.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const depth = getKeyDepth(trimmed);
  
  if (endIndex < startIndex) {
    throw new Error('End index must be greater than or equal to start index');
  }
  
  if (endIndex - startIndex > 500) {
    throw new Error('Maximum 500 addresses can be derived at once');
  }
  
  const chainType: ChainType = chain === 0 ? 'receive' : 'change';
  const chainLabel = chain === 0 ? 'Receive Address (External)' : 'Change Address (Internal)';
  const addresses: DerivedAddress[] = [];

  try {
    const bip32 = BIP32Factory(ecc);
    
    const convertedKey = convertToXpub(trimmed, prefix);
    let node = bip32.fromBase58(convertedKey, network);
    
    let pathPrefix: string;
    
    if (depth === 4) {
      // Already at chain level - just derive indices
      pathPrefix = `chain-level/${chain}`;
    } else if (depth === 3) {
      // Standard account level - derive chain first, then indices
      node = node.derive(chain);
      pathPrefix = `${prefixInfo.accountPath}/${chain}`;
    } else if (depth === 0 || depth === 1) {
      // Electrum-style: depth 0 or 1, use simple 0/<n> and 1/<n> derivation
      node = node.derive(chain);
      pathPrefix = `${chain}`;
    } else {
      // Depth 2 or other unusual depths
      throw new Error(`XPUB at depth ${depth} requires Advanced Mode with a custom derivation path.`);
    }
    
    for (let i = startIndex; i <= endIndex; i++) {
      const child = node.derive(i);
      
      let address: string;
      
      if (prefix === 'zpub' || prefix === 'vpub') {
        const { address: p2wpkhAddress } = bitcoin.payments.p2wpkh({
          pubkey: child.publicKey,
          network,
        });
        address = p2wpkhAddress!;
      } else if (prefix === 'ypub' || prefix === 'upub') {
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
        path: `${pathPrefix}/${i}`,
        chainType,
        chainLabel,
      });
    }
    
    return addresses;
  } catch (error) {
    console.error('Derivation error:', error);
    throw new Error(`Failed to derive addresses: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function deriveDualChainAddresses(
  extendedKey: string,
  receiveStartIndex: number = 0,
  receiveEndIndex: number = 19,
  changeStartIndex: number = 0,
  changeEndIndex: number = 19
): Promise<DualChainResult> {
  const trimmed = extendedKey.trim();
  const prefix = getXpubPrefix(trimmed);
  const prefixInfo = PREFIX_TO_BIP[prefix];
  const depth = getKeyDepth(trimmed);
  
  if (depth === 4) {
    const addresses = await deriveAddressesForChain(trimmed, 0, receiveStartIndex, receiveEndIndex);
    return {
      receive: addresses,
      change: [],
      xpub: trimmed,
      bipStandard: prefixInfo.bip,
      network: prefixInfo.network,
    };
  }
  
  const [receive, change] = await Promise.all([
    deriveAddressesForChain(trimmed, 0, receiveStartIndex, receiveEndIndex),
    deriveAddressesForChain(trimmed, 1, changeStartIndex, changeEndIndex),
  ]);
  
  return {
    receive,
    change,
    xpub: trimmed,
    bipStandard: prefixInfo.bip,
    network: prefixInfo.network,
  };
}

export async function deriveAddressesFromXpub(
  extendedKey: string,
  startIndex: number = 0,
  endIndex: number = 19,
  isChangeChain: boolean = false
): Promise<DerivedAddress[]> {
  return deriveAddressesForChain(extendedKey, isChangeChain ? 1 : 0, startIndex, endIndex);
}

export async function deriveAddressesAdvanced(
  extendedKey: string,
  customPath: string,
  startIndex: number = 0,
  endIndex: number = 19,
  chainType: ChainType = 'receive'
): Promise<DerivedAddress[]> {
  const trimmed = extendedKey.trim();
  const prefix = getXpubPrefix(trimmed);
  const prefixInfo = PREFIX_TO_BIP[prefix];
  const network = prefixInfo.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  
  if (endIndex < startIndex) {
    throw new Error('End index must be greater than or equal to start index');
  }
  
  if (endIndex - startIndex > 500) {
    throw new Error('Maximum 500 addresses can be derived at once');
  }
  
  const chainLabel = chainType === 'receive' ? 'Receive Address (External)' : 'Change Address (Internal)';
  const addresses: DerivedAddress[] = [];

  try {
    const bip32 = BIP32Factory(ecc);
    
    const convertedKey = convertToXpub(trimmed, prefix);
    let node = bip32.fromBase58(convertedKey, network);
    
    const cleanPath = customPath.trim();
    
    if (cleanPath && cleanPath !== '' && cleanPath !== 'm' && cleanPath !== 'm/') {
      const pathParts = cleanPath
        .replace(/^m\/?/, '')
        .split('/')
        .filter(p => p.length > 0);
      
      for (const part of pathParts) {
        const isHardened = part.endsWith("'") || part.endsWith('h');
        const index = parseInt(part.replace(/['h]$/, ''), 10);
        
        if (isNaN(index)) {
          throw new Error(`Invalid path component: ${part}`);
        }
        
        if (isHardened) {
          throw new Error('Cannot derive hardened paths from an extended public key. Use non-hardened paths like "0" or "0/0".');
        }
        
        node = node.derive(index);
      }
    }
    
    for (let i = startIndex; i <= endIndex; i++) {
      const child = node.derive(i);
      
      let address: string;
      
      if (prefix === 'zpub' || prefix === 'vpub') {
        const { address: p2wpkhAddress } = bitcoin.payments.p2wpkh({
          pubkey: child.publicKey,
          network,
        });
        address = p2wpkhAddress!;
      } else if (prefix === 'ypub' || prefix === 'upub') {
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
      
      const displayPath = cleanPath 
        ? (cleanPath.endsWith('/') ? `${cleanPath}${i}` : `${cleanPath}/${i}`)
        : `${i}`;
      
      addresses.push({
        index: i,
        address,
        path: displayPath,
        chainType,
        chainLabel,
      });
    }
    
    return addresses;
  } catch (error) {
    console.error('Derivation error:', error);
    throw new Error(`Failed to derive addresses: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function deriveDualChainAdvanced(
  extendedKey: string,
  receiveCustomPath: string,
  changeCustomPath: string,
  receiveStartIndex: number = 0,
  receiveEndIndex: number = 19,
  changeStartIndex: number = 0,
  changeEndIndex: number = 19
): Promise<DualChainResult> {
  const trimmed = extendedKey.trim();
  const prefix = getXpubPrefix(trimmed);
  const prefixInfo = PREFIX_TO_BIP[prefix];
  
  const [receive, change] = await Promise.all([
    deriveAddressesAdvanced(trimmed, receiveCustomPath, receiveStartIndex, receiveEndIndex, 'receive'),
    deriveAddressesAdvanced(trimmed, changeCustomPath, changeStartIndex, changeEndIndex, 'change'),
  ]);
  
  return {
    receive,
    change,
    xpub: trimmed,
    bipStandard: prefixInfo.bip,
    network: prefixInfo.network,
  };
}

export function validateExtendedPublicKey(key: string): { valid: boolean; type?: XpubPrefix; error?: string } {
  try {
    const trimmed = key.trim();
    const prefix = getXpubPrefix(trimmed);
    
    const decoded = bs58check.decode(trimmed);
    if (decoded.length !== 78) {
      return { valid: false, error: 'Invalid key length' };
    }
    
    return { valid: true, type: prefix };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Invalid extended public key format' };
  }
}

export function getBipDescription(bip: BipStandard): string {
  switch (bip) {
    case 'BIP44':
      return 'Legacy (P2PKH) - Addresses starting with 1';
    case 'BIP49':
      return 'Nested SegWit (P2SH-P2WPKH) - Addresses starting with 3';
    case 'BIP84':
      return 'Native SegWit (P2WPKH) - Addresses starting with bc1q';
    case 'BIP86':
      return 'Taproot (P2TR) - Addresses starting with bc1p';
    default:
      return 'Unknown standard';
  }
}

export function getDepthDescription(depth: number): string {
  switch (depth) {
    case 0:
      return 'Master key';
    case 1:
      return 'Purpose level';
    case 2:
      return 'Coin type level';
    case 3:
      return 'Account level (standard)';
    case 4:
      return 'Chain level (external/change)';
    case 5:
      return 'Address level';
    default:
      return `Depth ${depth}`;
  }
}

// ============================================
// MULTISIG ADDRESS DERIVATION
// ============================================

export type MultisigScriptType = 'p2sh' | 'p2wsh' | 'p2sh-p2wsh';

export interface MultisigXpubEntry {
  xpub: string;
  derivationPath?: string; // Optional custom path like "0" or "1" for chain
  name?: string; // Optional cosigner name (e.g., "Hardware Wallet", "Cold Storage")
  notes?: string; // Optional notes about this cosigner
}

export interface MultisigConfig {
  xpubs: MultisigXpubEntry[];
  m: number; // Required signatures
  n: number; // Total signers (derived from xpubs.length)
  scriptType: MultisigScriptType;
  network?: 'mainnet' | 'testnet';
}

export interface DerivedMultisigAddress {
  index: number;
  address: string;
  redeemScript?: string; // For P2SH and P2SH-P2WSH
  witnessScript?: string; // For P2WSH and P2SH-P2WSH
  chainType: ChainType;
  chainLabel: string;
  pubkeys: string[]; // Sorted pubkeys used for this address
}

export interface MultisigDualChainResult {
  receive: DerivedMultisigAddress[];
  change: DerivedMultisigAddress[];
  m: number;
  n: number;
  scriptType: MultisigScriptType;
  network: 'mainnet' | 'testnet';
}

// BIP-67: Lexicographic ordering of pubkeys for deterministic multisig
function sortPubkeysLexicographically(pubkeys: Uint8Array[]): Uint8Array[] {
  return [...pubkeys].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  });
}

// Convert Uint8Array to hex string
function toHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Get pubkey at specific derivation index from an xpub
function getPubkeyAtIndex(
  xpub: string,
  chain: 0 | 1,
  index: number,
  customPath?: string
): Uint8Array {
  const bip32 = BIP32Factory(ecc);
  const trimmed = xpub.trim();
  const prefix = getXpubPrefix(trimmed);
  const prefixInfo = PREFIX_TO_BIP[prefix];
  const network = prefixInfo.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const depth = getKeyDepth(trimmed);
  
  const convertedKey = convertToXpub(trimmed, prefix);
  let node = bip32.fromBase58(convertedKey, network);
  
  if (customPath) {
    // Parse custom path like "0" or "0/0" and derive
    const parts = customPath.split('/').filter(p => p.length > 0);
    for (const part of parts) {
      const idx = parseInt(part.replace("'", ""), 10);
      if (!isNaN(idx)) {
        node = node.derive(idx);
      }
    }
    // Then derive chain and index
    node = node.derive(chain).derive(index);
  } else {
    // Standard derivation based on depth
    if (depth === 4) {
      // Already at chain level
      node = node.derive(index);
    } else if (depth === 3 || depth === 0 || depth === 1) {
      // Account level or Electrum style
      node = node.derive(chain).derive(index);
    } else {
      throw new Error(`XPUB at depth ${depth} requires a custom derivation path`);
    }
  }
  
  return node.publicKey;
}

// Create multisig script and address
function createMultisigAddress(
  pubkeys: Uint8Array[],
  m: number,
  scriptType: MultisigScriptType,
  network: bitcoin.Network
): { address: string; redeemScript?: string; witnessScript?: string } {
  // Sort pubkeys lexicographically (BIP-67)
  const sortedPubkeys = sortPubkeysLexicographically(pubkeys);
  
  // Create multisig payment
  const p2ms = bitcoin.payments.p2ms({
    m,
    pubkeys: sortedPubkeys,
    network,
  });
  
  if (!p2ms.output) {
    throw new Error('Failed to create multisig script');
  }
  
  let address: string;
  let redeemScript: string | undefined;
  let witnessScript: string | undefined;
  
  switch (scriptType) {
    case 'p2sh': {
      // Legacy P2SH multisig (3xxx addresses)
      const p2sh = bitcoin.payments.p2sh({
        redeem: p2ms,
        network,
      });
      address = p2sh.address!;
      redeemScript = toHex(p2ms.output);
      break;
    }
    
    case 'p2wsh': {
      // Native SegWit P2WSH (bc1qxxx... longer addresses)
      const p2wsh = bitcoin.payments.p2wsh({
        redeem: p2ms,
        network,
      });
      address = p2wsh.address!;
      witnessScript = toHex(p2ms.output);
      break;
    }
    
    case 'p2sh-p2wsh': {
      // Nested SegWit P2SH-P2WSH (3xxx addresses but SegWit internally)
      const p2wsh = bitcoin.payments.p2wsh({
        redeem: p2ms,
        network,
      });
      const p2sh = bitcoin.payments.p2sh({
        redeem: p2wsh,
        network,
      });
      address = p2sh.address!;
      redeemScript = p2wsh.output ? toHex(p2wsh.output) : undefined;
      witnessScript = toHex(p2ms.output);
      break;
    }
    
    default:
      throw new Error(`Unknown script type: ${scriptType}`);
  }
  
  return { address, redeemScript, witnessScript };
}

export async function deriveMultisigAddresses(
  config: MultisigConfig,
  chain: 0 | 1,
  startIndex: number = 0,
  endIndex: number = 19
): Promise<DerivedMultisigAddress[]> {
  const { xpubs, m, scriptType } = config;
  const n = xpubs.length;
  
  if (m < 1 || m > n) {
    throw new Error(`Invalid threshold: ${m} of ${n}. M must be between 1 and N.`);
  }
  
  if (n < 2 || n > 15) {
    throw new Error(`Invalid number of signers: ${n}. Must be between 2 and 15.`);
  }
  
  if (endIndex < startIndex) {
    throw new Error('End index must be greater than or equal to start index');
  }
  
  if (endIndex - startIndex > 500) {
    throw new Error('Maximum 500 addresses can be derived at once');
  }
  
  // Determine network from first xpub
  const firstPrefix = getXpubPrefix(xpubs[0].xpub.trim());
  const networkType = PREFIX_TO_BIP[firstPrefix].network;
  const network = networkType === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  
  const chainType: ChainType = chain === 0 ? 'receive' : 'change';
  const chainLabel = chain === 0 ? 'Receive Address (External)' : 'Change Address (Internal)';
  const addresses: DerivedMultisigAddress[] = [];
  
  for (let i = startIndex; i <= endIndex; i++) {
    // Collect pubkeys from all xpubs at this index
    const pubkeys: Uint8Array[] = [];
    for (const xpubEntry of xpubs) {
      const pubkey = getPubkeyAtIndex(xpubEntry.xpub, chain, i, xpubEntry.derivationPath);
      pubkeys.push(pubkey);
    }
    
    // Create multisig address with sorted pubkeys
    const { address, redeemScript, witnessScript } = createMultisigAddress(
      pubkeys,
      m,
      scriptType,
      network
    );
    
    addresses.push({
      index: i,
      address,
      redeemScript,
      witnessScript,
      chainType,
      chainLabel,
      pubkeys: sortPubkeysLexicographically(pubkeys).map(p => toHex(p)),
    });
  }
  
  return addresses;
}

export async function deriveMultisigDualChain(
  config: MultisigConfig,
  receiveStart: number = 0,
  receiveEnd: number = 19,
  changeStart: number = 0,
  changeEnd: number = 19
): Promise<MultisigDualChainResult> {
  const firstPrefix = getXpubPrefix(config.xpubs[0].xpub.trim());
  const networkType = PREFIX_TO_BIP[firstPrefix].network;
  
  const [receive, change] = await Promise.all([
    deriveMultisigAddresses(config, 0, receiveStart, receiveEnd),
    deriveMultisigAddresses(config, 1, changeStart, changeEnd),
  ]);
  
  return {
    receive,
    change,
    m: config.m,
    n: config.xpubs.length,
    scriptType: config.scriptType,
    network: networkType,
  };
}

export function getMultisigScriptTypeDescription(scriptType: MultisigScriptType): string {
  switch (scriptType) {
    case 'p2sh':
      return 'Legacy P2SH - Addresses starting with 3 (higher fees)';
    case 'p2wsh':
      return 'Native SegWit P2WSH - Addresses starting with bc1q (lowest fees)';
    case 'p2sh-p2wsh':
      return 'Nested SegWit P2SH-P2WSH - Addresses starting with 3 (compatible, medium fees)';
    default:
      return 'Unknown script type';
  }
}

export function validateMultisigXpubs(xpubs: string[]): { valid: boolean; error?: string } {
  if (xpubs.length < 2) {
    return { valid: false, error: 'Multisig requires at least 2 xpubs' };
  }
  
  if (xpubs.length > 15) {
    return { valid: false, error: 'Maximum 15 xpubs supported for multisig' };
  }
  
  // Validate each xpub
  for (let i = 0; i < xpubs.length; i++) {
    const result = validateExtendedPublicKey(xpubs[i]);
    if (!result.valid) {
      return { valid: false, error: `Xpub #${i + 1}: ${result.error}` };
    }
  }
  
  // Check all xpubs are on same network
  const networks = xpubs.map(x => {
    const prefix = getXpubPrefix(x.trim());
    return PREFIX_TO_BIP[prefix].network;
  });
  
  if (new Set(networks).size > 1) {
    return { valid: false, error: 'All xpubs must be on the same network (mainnet or testnet)' };
  }
  
  return { valid: true };
}
