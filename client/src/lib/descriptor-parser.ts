import { MultisigScriptType, MultisigXpubEntry } from './xpub';

export interface DescriptorKey {
  fingerprint: string;
  derivationPath: string;
  xpub: string;
  chainPath: string;
}

export interface ParsedDescriptor {
  scriptType: MultisigScriptType;
  threshold: number;
  keys: DescriptorKey[];
  network: 'mainnet' | 'testnet';
  isMultisig: boolean;
  isSortedMulti: boolean;
  rawDescriptor: string;
  label?: string;
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

function detectScriptType(descriptor: string): MultisigScriptType {
  const clean = descriptor.toLowerCase().trim();
  
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
    let chainPath = match[4] || '/*';
    chainPath = chainPath.replace(/<0;1>/g, '0').replace(/<1;0>/g, '1');
    
    return {
      fingerprint: match[1].toLowerCase(),
      derivationPath: match[2],
      xpub: match[3],
      chainPath: chainPath,
    };
  }
  
  const simpleKeyRegex = new RegExp(`^\\[([a-fA-F0-9]{8})\\](${xpubPattern})(\\/.*)?$`);
  const simpleMatch = trimmed.match(simpleKeyRegex);
  
  if (simpleMatch) {
    let chainPath = simpleMatch[3] || '/*';
    chainPath = chainPath.replace(/<0;1>/g, '0').replace(/<1;0>/g, '1');
    
    return {
      fingerprint: simpleMatch[1].toLowerCase(),
      derivationPath: '',
      xpub: simpleMatch[2],
      chainPath: chainPath,
    };
  }
  
  const xpubOnlyRegex = new RegExp(`^(${xpubPattern})(\\/.*)?$`);
  const xpubMatch = trimmed.match(xpubOnlyRegex);
  
  if (xpubMatch) {
    let chainPath = xpubMatch[2] || '/*';
    chainPath = chainPath.replace(/<0;1>/g, '0').replace(/<1;0>/g, '1');
    
    return {
      fingerprint: '00000000',
      derivationPath: '',
      xpub: xpubMatch[1],
      chainPath: chainPath,
    };
  }
  
  return null;
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

export function parseDescriptor(descriptorInput: string): DescriptorParseResult {
  try {
    const descriptor = descriptorInput.trim();
    
    if (!descriptor) {
      return { success: false, error: 'Descriptor is empty' };
    }
    
    const scriptType = detectScriptType(descriptor);
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
    
    return {
      success: true,
      descriptor: {
        scriptType,
        threshold: parsed.threshold,
        keys: parsed.keys,
        network,
        isMultisig: parsed.keys.length >= 2,
        isSortedMulti: parsed.isSorted,
        rawDescriptor: descriptor,
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
    let derivationPath = '';
    if (key.chainPath && key.chainPath !== '/*' && key.chainPath !== '/<0;1>/*') {
      const cleanPath = key.chainPath.replace(/^\//, '').replace(/\/\*$/, '').replace(/\/<0;1>$/, '');
      if (cleanPath && !cleanPath.includes('<') && !cleanPath.includes(';')) {
        derivationPath = cleanPath;
      }
    }
    
    return {
      xpub: key.xpub,
      derivationPath,
    };
  });
}

export function getDescriptorSummary(parsed: ParsedDescriptor): string {
  const scriptNames: Record<MultisigScriptType, string> = {
    'p2wsh': 'Native SegWit (bc1q...)',
    'p2sh': 'Legacy (3...)',
    'p2sh-p2wsh': 'Nested SegWit (3...)',
  };
  
  return `${parsed.threshold}-of-${parsed.keys.length} ${parsed.isSortedMulti ? 'sortedmulti' : 'multi'} ${scriptNames[parsed.scriptType]}`;
}
