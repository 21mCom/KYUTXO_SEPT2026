import type { 
  WalletAdapter, 
  DetectionResult, 
  ParseResult, 
  ParsedRecord, 
  FileFormat 
} from '../types';

interface BIP329Record {
  type: 'tx' | 'addr' | 'pubkey' | 'input' | 'output' | 'xpub';
  ref: string;
  label?: string;
  origin?: string;
  spendable?: string;
}

function parseJsonLines(content: string): BIP329Record[] {
  const records: BIP329Record[] = [];
  const lines = content.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type && parsed.ref) {
        records.push(parsed as BIP329Record);
      }
    } catch {
      continue;
    }
  }
  
  return records;
}

function isBIP329Format(content: string): boolean {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return false;
  
  let validCount = 0;
  const checkLines = lines.slice(0, Math.min(5, lines.length));
  
  for (const line of checkLines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type && parsed.ref && 
          ['tx', 'addr', 'pubkey', 'input', 'output', 'xpub'].includes(parsed.type)) {
        validCount++;
      }
    } catch {
      continue;
    }
  }
  
  return validCount >= Math.min(2, checkLines.length);
}

export const bip329Adapter: WalletAdapter = {
  name: 'BIP-329 Labels (Sparrow)',
  walletType: 'sparrow-bip329',
  
  detectFormat(content: string, filename: string): DetectionResult {
    const lowerFilename = filename.toLowerCase();
    
    if (lowerFilename.endsWith('.jsonl')) {
      if (isBIP329Format(content)) {
        return { walletType: 'sparrow-bip329', fileFormat: 'jsonl', confidence: 0.95 };
      }
      return { walletType: 'sparrow-bip329', fileFormat: 'jsonl', confidence: 0.7 };
    }
    
    if (isBIP329Format(content)) {
      return { walletType: 'sparrow-bip329', fileFormat: 'jsonl', confidence: 0.9 };
    }
    
    return { walletType: 'unknown', fileFormat: 'json', confidence: 0 };
  },
  
  parse(content: string, fileFormat: FileFormat): ParseResult {
    const records: ParsedRecord[] = [];
    const errors: string[] = [];
    
    try {
      const bip329Records = parseJsonLines(content);
      
      if (bip329Records.length === 0) {
        errors.push('No valid BIP-329 records found in file');
        return { success: false, records: [], walletType: 'sparrow-bip329', fileFormat: 'jsonl', errors };
      }
      
      for (const record of bip329Records) {
        const label = record.label || '';
        
        switch (record.type) {
          case 'tx':
            records.push({
              type: 'transaction',
              inputString: record.ref,
              label: label || 'BIP-329 Transaction',
              source: 'BIP-329 Import',
              originalData: record as unknown as { [key: string]: unknown },
            });
            break;
            
          case 'addr':
            records.push({
              type: 'address',
              inputString: record.ref,
              label: label || 'BIP-329 Address',
              source: 'BIP-329 Import',
              isInputAddress: true,
              originalData: record as unknown as { [key: string]: unknown },
            });
            break;
            
          case 'output':
          case 'input':
            const [txid, indexStr] = record.ref.split(':');
            if (txid && txid.length >= 64) {
              records.push({
                type: 'transaction',
                inputString: txid,
                label: label || `BIP-329 ${record.type === 'output' ? 'Output' : 'Input'}`,
                notes: `${record.type} index: ${indexStr || 'unknown'}${record.spendable ? `, spendable: ${record.spendable}` : ''}`,
                source: 'BIP-329 Import',
                originalData: record as unknown as { [key: string]: unknown },
              });
            }
            break;
            
          case 'xpub':
          case 'pubkey':
            break;
        }
      }
      
      const txCount = records.filter(r => r.type === 'transaction').length;
      const addrCount = records.filter(r => r.type === 'address').length;
      
      if (records.length === 0) {
        errors.push('No importable records found (only xpub/pubkey entries)');
        return { success: false, records: [], walletType: 'sparrow-bip329', fileFormat: 'jsonl', errors };
      }
      
      return { 
        success: true, 
        records, 
        walletType: 'sparrow-bip329', 
        fileFormat: 'jsonl', 
        errors 
      };
    } catch (e) {
      errors.push(`Failed to parse BIP-329 file: ${e instanceof Error ? e.message : 'Unknown error'}`);
      return { success: false, records: [], walletType: 'sparrow-bip329', fileFormat: 'jsonl', errors };
    }
  },
  
  getSupportedFormats(): FileFormat[] {
    return ['jsonl'];
  },
};
