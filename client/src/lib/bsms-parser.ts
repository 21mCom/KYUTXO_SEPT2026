export interface BSMSParseResult {
  success: boolean;
  version?: string;
  descriptor?: string;
  pathRestrictions?: string;
  firstAddress?: string;
  error?: string;
}

export function parseBSMS(content: string): BSMSParseResult {
  const rawLines = content.replace(/^\uFEFF/, '').split('\n').map(line => line.trim());
  
  const contentLines = rawLines.filter(line => !line.startsWith('#'));
  
  const getLine = (index: number): string => contentLines[index] || '';
  
  const line1 = getLine(0);
  if (!line1.toLowerCase().startsWith('bsms')) {
    return {
      success: false,
      error: 'Invalid BSMS file: first line must start with "BSMS"',
    };
  }
  
  const versionMatch = line1.match(/bsms\s+(\d+\.\d+)/i);
  const version = versionMatch ? versionMatch[1] : '1.0';
  
  const descriptor = getLine(1);
  if (!descriptor) {
    return {
      success: false,
      error: 'BSMS file is missing the descriptor on line 2',
    };
  }
  
  const descriptorPatterns = [
    /^wsh\s*\(/i,
    /^sh\s*\(/i,
    /^tr\s*\(/i,
    /^wpkh\s*\(/i,
    /^pkh\s*\(/i,
  ];
  
  const isValidDescriptor = descriptorPatterns.some(pattern => pattern.test(descriptor));
  if (!isValidDescriptor) {
    return {
      success: false,
      error: 'Line 2 does not appear to contain a valid output descriptor',
    };
  }
  
  let pathRestrictions: string | undefined;
  let firstAddress: string | undefined;
  
  const line3 = getLine(2);
  if (line3) {
    if (isValidPathRestriction(line3)) {
      pathRestrictions = line3;
    } else {
      return {
        success: false,
        error: `Line 3 should be a valid path restriction (e.g., "/0/*", "No path restrictions"), but got: ${line3.slice(0, 30)}`,
      };
    }
  }
  
  const line4 = getLine(3);
  if (line4) {
    if (isValidBitcoinAddress(line4)) {
      firstAddress = line4;
    } else {
      return {
        success: false,
        error: `Line 4 should be a valid Bitcoin address for verification, but got: ${line4.slice(0, 20)}...`,
      };
    }
  }
  
  return {
    success: true,
    version,
    descriptor,
    pathRestrictions,
    firstAddress,
  };
}

function isValidPathRestriction(str: string): boolean {
  const lower = str.toLowerCase();
  if (lower === 'no path restrictions') return true;
  if (/^\/[0-9*,<>;\/]+$/.test(str)) return true;
  if (/^[0-9*,<>;\/]+$/.test(str)) return true;
  if (str === '') return true;
  return false;
}

function isValidBitcoinAddress(str: string): boolean {
  if (str.match(/^bc1q[a-z0-9]{38,59}$/i)) return true;
  if (str.match(/^bc1p[a-z0-9]{58}$/i)) return true;
  if (str.match(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/)) return true;
  if (str.match(/^tb1[a-z0-9]{38,62}$/i)) return true;
  if (str.match(/^[mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/)) return true;
  return false;
}

export function isBSMSFile(content: string, filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.endsWith('.bsms')) {
    return true;
  }
  
  const firstLine = content.trim().split('\n')[0]?.trim().toLowerCase() || '';
  return firstLine.startsWith('bsms');
}

export function detectBSMSOrDescriptor(content: string, filename: string): 'bsms' | 'descriptor' | 'json' | 'unknown' {
  const trimmed = content.trim();
  
  if (isBSMSFile(content, filename)) {
    return 'bsms';
  }
  
  if (trimmed.startsWith('{')) {
    return 'json';
  }
  
  const descriptorPatterns = [
    /^wsh\s*\(/i,
    /^sh\s*\(/i,
    /^tr\s*\(/i,
    /^wpkh\s*\(/i,
    /^pkh\s*\(/i,
  ];
  
  if (descriptorPatterns.some(pattern => pattern.test(trimmed))) {
    return 'descriptor';
  }
  
  return 'unknown';
}
