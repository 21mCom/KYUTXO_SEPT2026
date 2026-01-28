import { MultisigScriptType, MultisigXpubEntry, DescriptorScriptType } from './xpub';

export interface DescriptorKey {
  fingerprint: string;
  derivationPath: string;
  xpub: string;
  chainPath: string;
  rawChainPath: string; // Original chain path before normalization (preserves <0;1>)
}

export type DescriptorChainType = 'receive-only' | 'change-only' | 'dual-chain';

export interface ParsedDescriptor {
  scriptType: DescriptorScriptType;
  threshold: number;
  keys: DescriptorKey[];
  network: 'mainnet' | 'testnet';
  isMultisig: boolean;
  isSortedMulti: boolean;
  isTaproot: boolean;
  rawDescriptor: string;
  label?: string;
  chainType: DescriptorChainType; // Which chain(s) this descriptor supports
}

export interface SparrowExport {
  label: string;
  descriptor: string;
  blockheight?: number;
}

export interface DescriptorParseResult {
  success: boolean;
  descriptor?: ParsedDescriptor;
  error?: string;
}

const XPUB_PREFIXES_MAINNET = ['xpub', 'ypub', 'zpub', 'Xpub', 'Ypub', 'Zpub'];
const XPUB_PREFIXES_TESTNET = ['tpub', 'upub', 'vpub', 'Tpub', 'Upub', 'Vpub'];

function detectNetwork(xpub: string): 'mainnet' | 'testnet' {
  for (const prefix of XPUB_PREFIXES_MAINNET) {
    if (xpub.startsWith(prefix)) return 'mainnet';
  }
  for (const prefix of XPUB_PREFIXES_TESTNET) {
    if (xpub.startsWith(prefix)) return 'testnet';
  }
  return 'mainnet';
}

function removeChecksum(descriptor: string): string {
  const hashIndex = descriptor.lastIndexOf('#');
  if (hashIndex !== -1) {
    return descriptor.substring(0, hashIndex);
  }
  return descriptor;
}

function detectScriptType(descriptor: string): DescriptorScriptType {
  const clean = descriptor.toLowerCase().trim();
  
  if (clean.startsWith('tr(')) {
    return 'p2tr';
  }
  if (clean.startsWith('sh(wsh(')) {
    return 'p2sh-p2wsh';
  }
  if (clean.startsWith('wsh(')) {
    return 'p2wsh';
  }
  if (clean.startsWith('sh(')) {
    return 'p2sh';
  }
  
  return 'p2wsh';
}

function parseKeyExpression(keyExpr: string): DescriptorKey | null {
  const trimmed = keyExpr.trim();
  
  const xpubPattern = '[xyztuXYZTU]pub[a-zA-Z0-9]+';
  
  const keyRegex = new RegExp(`^\\[([a-fA-F0-9]{8})\\/([^\\]]+)\\](${xpubPattern})(\\/.*)?$`);
  const match = trimmed.match(keyRegex);
  
  if (match) {
    const rawChainPath = match[4] || '/*';
    // Normalize for derivation: replace <0;1> with 0 for receive chain
    let chainPath = rawChainPath.replace(/<0;1>/g, '0').replace(/<1;0>/g, '1');
    
    return {
      fingerprint: match[1].toLowerCase(),
      derivationPath: match[2],
      xpub: match[3],
      chainPath: chainPath,
      rawChainPath: rawChainPath,
    };
  }
  
  const simpleKeyRegex = new RegExp(`^\\[([a-fA-F0-9]{8})\\](${xpubPattern})(\\/.*)?$`);
  const simpleMatch = trimmed.match(simpleKeyRegex);
  
  if (simpleMatch) {
    const rawChainPath = simpleMatch[3] || '/*';
    let chainPath = rawChainPath.replace(/<0;1>/g, '0').replace(/<1;0>/g, '1');
    
    return {
      fingerprint: simpleMatch[1].toLowerCase(),
      derivationPath: '',
      xpub: simpleMatch[2],
      chainPath: chainPath,
      rawChainPath: rawChainPath,
    };
  }
  
  const xpubOnlyRegex = new RegExp(`^(${xpubPattern})(\\/.*)?$`);
  const xpubMatch = trimmed.match(xpubOnlyRegex);
  
  if (xpubMatch) {
    const rawChainPath = xpubMatch[2] || '/*';
    let chainPath = rawChainPath.replace(/<0;1>/g, '0').replace(/<1;0>/g, '1');
    
    return {
      fingerprint: '00000000',
      derivationPath: '',
      xpub: xpubMatch[1],
      chainPath: chainPath,
      rawChainPath: rawChainPath,
    };
  }
  
  return null;
}

// Detect which chain(s) a descriptor supports based on the chainPath
function detectChainType(rawChainPath: string): DescriptorChainType {
  // <0;1> or <1;0> means dual-chain (both receive and change)
  if (rawChainPath.includes('<0;1>') || rawChainPath.includes('<1;0>')) {
    return 'dual-chain';
  }
  // /* alone (no explicit chain) typically means dual-chain
  if (rawChainPath === '/*') {
    return 'dual-chain';
  }
  // /0/* means receive only (external chain)
  if (rawChainPath.includes('/0/') || rawChainPath === '/0/*') {
    return 'receive-only';
  }
  // /1/* means change only (internal chain)
  if (rawChainPath.includes('/1/') || rawChainPath === '/1/*') {
    return 'change-only';
  }
  // Default to dual-chain if unclear
  return 'dual-chain';
}

function extractMultisigContent(descriptor: string): string {
  let content = removeChecksum(descriptor);
  
  if (/^sh\(wsh\(/i.test(content)) {
    content = content.replace(/^sh\(wsh\(/i, '');
    if (content.endsWith('))')) {
      content = content.slice(0, -2);
    }
  } else if (/^wsh\(/i.test(content)) {
    content = content.replace(/^wsh\(/i, '');
    if (content.endsWith(')')) {
      content = content.slice(0, -1);
    }
  } else if (/^sh\(/i.test(content)) {
    content = content.replace(/^sh\(/i, '');
    if (content.endsWith(')')) {
      content = content.slice(0, -1);
    }
  }
  
  return content;
}

function parseMultisigContent(content: string): { threshold: number; keys: DescriptorKey[]; isSorted: boolean } | null {
  const sortedMultiMatch = content.match(/^sortedmulti\((\d+),(.+)\)$/i);
  const multiMatch = content.match(/^multi\((\d+),(.+)\)$/i);
  
  const match = sortedMultiMatch || multiMatch;
  const isSorted = !!sortedMultiMatch;
  
  if (!match) {
    return null;
  }
  
  const threshold = parseInt(match[1], 10);
  const keysString = match[2];
  
  const keyExpressions: string[] = [];
  let depth = 0;
  let current = '';
  
  for (const char of keysString) {
    if (char === '[') {
      depth++;
      current += char;
    } else if (char === ']') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      if (current.trim()) {
        keyExpressions.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    keyExpressions.push(current.trim());
  }
  
  const keys: DescriptorKey[] = [];
  for (const expr of keyExpressions) {
    const key = parseKeyExpression(expr);
    if (key) {
      keys.push(key);
    }
  }
  
  if (keys.length === 0) {
    return null;
  }
  
  return { threshold, keys, isSorted };
}

function extractTaprootContent(descriptor: string): string {
  let content = removeChecksum(descriptor);
  
  if (/^tr\(/i.test(content)) {
    content = content.replace(/^tr\(/i, '');
    if (content.endsWith(')')) {
      content = content.slice(0, -1);
    }
  }
  
  return content;
}

function parseTaprootContent(content: string): { key: DescriptorKey } | null {
  const trimmed = content.trim();
  
  const key = parseKeyExpression(trimmed);
  if (key) {
    return { key };
  }
  
  return null;
}

export function parseDescriptor(descriptorInput: string): DescriptorParseResult {
  try {
    const descriptor = descriptorInput.trim();
    
    if (!descriptor) {
      return { success: false, error: 'Descriptor is empty' };
    }
    
    const scriptType = detectScriptType(descriptor);
    
    if (scriptType === 'p2tr') {
      const content = extractTaprootContent(descriptor);
      const parsed = parseTaprootContent(content);
      
      if (!parsed) {
        return { 
          success: false, 
          error: 'Could not parse taproot descriptor. Expected format: tr([fp/path]xpub/chain/*)' 
        };
      }
      
      const network = detectNetwork(parsed.key.xpub);
      const chainType = detectChainType(parsed.key.rawChainPath);
      
      return {
        success: true,
        descriptor: {
          scriptType,
          threshold: 1,
          keys: [parsed.key],
          network,
          isMultisig: false,
          isSortedMulti: false,
          isTaproot: true,
          rawDescriptor: descriptor,
          chainType,
        },
      };
    }
    
    const content = extractMultisigContent(descriptor);
    const parsed = parseMultisigContent(content);
    
    if (!parsed) {
      return { 
        success: false, 
        error: 'Could not parse multisig content. Expected format: sortedmulti(M, [fp/path]xpub, ...)' 
      };
    }
    
    if (parsed.keys.length < 2) {
      return { 
        success: false, 
        error: `Need at least 2 keys for multisig, found ${parsed.keys.length}` 
      };
    }
    
    if (parsed.threshold < 1 || parsed.threshold > parsed.keys.length) {
      return { 
        success: false, 
        error: `Invalid threshold: ${parsed.threshold} of ${parsed.keys.length}` 
      };
    }
    
    const network = detectNetwork(parsed.keys[0].xpub);
    
    const networks = parsed.keys.map(k => detectNetwork(k.xpub));
    if (new Set(networks).size > 1) {
      return { 
        success: false, 
        error: 'All keys must be on the same network (mainnet or testnet)' 
      };
    }
    
    // Detect chain type from the first key's rawChainPath
    // (all keys in a descriptor should have the same chain path pattern)
    const chainType = detectChainType(parsed.keys[0].rawChainPath);
    
    return {
      success: true,
      descriptor: {
        scriptType,
        threshold: parsed.threshold,
        keys: parsed.keys,
        network,
        isMultisig: parsed.keys.length >= 2,
        isSortedMulti: parsed.isSorted,
        isTaproot: false,
        rawDescriptor: descriptor,
        chainType,
      },
    };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown parsing error' 
    };
  }
}

export function parseSparrowExport(content: string): { export?: SparrowExport; error?: string } {
  try {
    const json = JSON.parse(content);
    
    if (json.descriptor && typeof json.descriptor === 'string') {
      return {
        export: {
          label: json.label || json.name || 'Imported Wallet',
          descriptor: json.descriptor,
          blockheight: json.blockheight,
        },
      };
    }
    
    if (json.recv_descriptor || json.receiving_descriptor) {
      const descriptor = json.recv_descriptor || json.receiving_descriptor;
      return {
        export: {
          label: json.label || json.name || 'Imported Wallet',
          descriptor,
          blockheight: json.blockheight,
        },
      };
    }
    
    if (json.external_descriptor || json.external) {
      const descriptor = json.external_descriptor || json.external;
      return {
        export: {
          label: json.label || json.name || 'Imported Wallet',
          descriptor,
          blockheight: json.blockheight,
        },
      };
    }
    
    const topLevelDescriptor = Object.values(json).find(
      v => typeof v === 'string' && (v as string).includes('multi(')
    );
    
    if (topLevelDescriptor) {
      return {
        export: {
          label: 'Imported Wallet',
          descriptor: topLevelDescriptor as string,
        },
      };
    }
    
    return { error: 'Could not find a descriptor in this file. Expected a Sparrow wallet export with a "descriptor" field.' };
  } catch (e) {
    const trimmed = content.trim();
    if (trimmed.includes('sortedmulti(') || trimmed.includes('multi(')) {
      return {
        export: {
          label: 'Imported Descriptor',
          descriptor: trimmed,
        },
      };
    }
    
    return { error: 'Invalid JSON format and not a raw descriptor' };
  }
}

export function descriptorKeysToXpubEntries(keys: DescriptorKey[]): MultisigXpubEntry[] {
  return keys.map(key => {
    // The chainPath contains the derivation from the xpub to addresses
    // Standard patterns are: /0/*, /1/*, /<0;1>/*, /*
    // These indicate chain (0=receive, 1=change) and index derivation
    // We should NOT include the chain component (0 or 1) as a derivationPath
    // because deriveMultisigAddresses already handles chain derivation
    
    // Detect if xpub is already at chain level (chainPath is /* with no chain component)
    // In this case, we should skip chain derivation and only derive index
    const rawPath = key.rawChainPath || key.chainPath || '/*';
    const isChainLevel = rawPath === '/*';
    
    // Only extract extra path segments if there are any BEFORE the chain/index
    // For example, if chainPath is "/custom/0/*", extract "custom"
    // But for standard "/0/*", "/1/*", "/<0;1>/*", "/*" - return empty derivationPath
    
    let derivationPath = '';
    if (key.chainPath) {
      // Remove leading slash and trailing wildcard patterns
      let cleaned = key.chainPath
        .replace(/^\//, '')  // Remove leading /
        .replace(/\/\*$/, '') // Remove trailing /*
        .replace(/<0;1>$/, '') // Remove trailing <0;1>
        .replace(/<1;0>$/, ''); // Remove trailing <1;0>
      
      // If what remains is just "0", "1", or empty, it's a standard chain path
      // No extra derivation needed
      if (cleaned === '0' || cleaned === '1' || cleaned === '' || cleaned.includes('<')) {
        derivationPath = '';
      } else {
        // There's something extra - might be like "custom/0" or similar
        // Extract just the non-chain parts
        const parts = cleaned.split('/');
        // Check if last part is a chain indicator
        const lastPart = parts[parts.length - 1];
        if (lastPart === '0' || lastPart === '1' || lastPart.includes('<')) {
          // Remove the chain part, keep the rest
          parts.pop();
          derivationPath = parts.join('/');
        } else {
          // No chain indicator, use the whole thing
          // This is unusual but handle it
          derivationPath = cleaned;
        }
      }
    }
    
    return {
      xpub: key.xpub,
      derivationPath,
      skipChainDerivation: isChainLevel,
    };
  });
}

export function getDescriptorSummary(parsed: ParsedDescriptor): string {
  const scriptNames: Record<DescriptorScriptType, string> = {
    'p2wsh': 'Native SegWit (bc1q...)',
    'p2sh': 'Legacy (3...)',
    'p2sh-p2wsh': 'Nested SegWit (3...)',
    'p2tr': 'Taproot (bc1p...)',
  };
  
  if (parsed.isTaproot) {
    return `Taproot Singlesig ${scriptNames[parsed.scriptType]}`;
  }
  
  return `${parsed.threshold}-of-${parsed.keys.length} ${parsed.isSortedMulti ? 'sortedmulti' : 'multi'} ${scriptNames[parsed.scriptType]}`;
}
