import type { 
  WalletAdapter, 
  DetectionResult, 
  ParseResult, 
  ParsedRecord,
  ImportOptions,
  ImportResult,
  DuplicateInfo,
  WalletType,
  FileFormat
} from './types';
import { trezorAdapter } from './adapters/trezor';
import { sparrowAdapter } from './adapters/sparrow';
import { bip329Adapter } from './adapters/bip329';
import { myceliumAdapter } from './adapters/mycelium';
import { checkForDuplicates, mergeRecordData, createNewRecordData } from './merge-utils';
import { createRecord, updateRecord, isEncryptionReady } from '../encryptionFacade';

const PRIVATE_KEY_PATTERNS = [
  /xprv[a-zA-Z0-9]{100,}/i,
  /[5KL][1-9A-HJ-NP-Za-km-z]{50,52}/,
  /"wif"\s*:/i,
  /"privateKey"\s*:/i,
  /"private_key"\s*:/i,
  /"seed"\s*:\s*"[a-f0-9]{64,}"/i,
  /"mnemonic"\s*:/i,
  /-----BEGIN.*PRIVATE KEY-----/i,
];

export function scanForPrivateKeys(content: string): { hasPrivateKeys: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  for (const pattern of PRIVATE_KEY_PATTERNS) {
    if (pattern.test(content)) {
      if (pattern.source.includes('xprv')) {
        warnings.push('File appears to contain extended private keys (xprv)');
      } else if (pattern.source.includes('wif') || pattern.source.includes('5KL')) {
        warnings.push('File appears to contain WIF private keys');
      } else if (pattern.source.includes('mnemonic')) {
        warnings.push('File appears to contain mnemonic seed phrases');
      } else if (pattern.source.includes('seed')) {
        warnings.push('File appears to contain raw seed data');
      } else if (pattern.source.includes('privateKey') || pattern.source.includes('private_key')) {
        warnings.push('File appears to contain private key data');
      } else {
        warnings.push('File appears to contain private key material');
      }
    }
  }
  
  return { 
    hasPrivateKeys: warnings.length > 0, 
    warnings: Array.from(new Set(warnings))
  };
}

const adapters: WalletAdapter[] = [
  bip329Adapter,
  trezorAdapter,
  sparrowAdapter,
  myceliumAdapter,
];

export function getWalletName(walletType: WalletType): string {
  switch (walletType) {
    case 'trezor': return 'Trezor Suite';
    case 'sparrow': return 'Sparrow Wallet';
    case 'sparrow-bip329': return 'BIP-329 Labels (Sparrow)';
    case 'mycelium': return 'Mycelium';
    default: return 'Unknown Wallet';
  }
}

export function detectWalletType(content: string, filename: string): DetectionResult {
  let bestResult: DetectionResult = { 
    walletType: 'unknown', 
    fileFormat: 'csv', 
    confidence: 0 
  };
  
  for (const adapter of adapters) {
    const result = adapter.detectFormat(content, filename);
    if (result.confidence > bestResult.confidence) {
      bestResult = result;
    }
  }
  
  if (bestResult.walletType === 'unknown') {
    if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
      bestResult.fileFormat = 'json';
    } else {
      bestResult.fileFormat = 'csv';
    }
    bestResult.message = 'Could not automatically detect wallet type. Please select manually.';
  }
  
  return bestResult;
}

export function parseFile(
  content: string, 
  walletType: WalletType, 
  fileFormat: FileFormat
): ParseResult {
  const adapter = adapters.find(a => a.walletType === walletType);
  
  if (!adapter) {
    return {
      success: false,
      records: [],
      walletType,
      fileFormat,
      errors: [`No adapter found for wallet type: ${walletType}`],
    };
  }
  
  try {
    return adapter.parse(content, fileFormat);
  } catch (e) {
    return {
      success: false,
      records: [],
      walletType,
      fileFormat,
      errors: [`Parse error: ${e instanceof Error ? e.message : 'Unknown error'}`],
    };
  }
}

export async function analyzeRecords(
  records: ParsedRecord[]
): Promise<DuplicateInfo[]> {
  return checkForDuplicates(records);
}

export async function executeImport(
  duplicateInfos: DuplicateInfo[],
  options: ImportOptions,
  onProgress?: (current: number, total: number, status: string) => void
): Promise<ImportResult> {
  const result: ImportResult = {
    newRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    failedRecords: 0,
    errors: [],
  };
  
  if (!isEncryptionReady()) {
    result.errors.push('Encryption not ready. Please login first.');
    return result;
  }
  
  const total = duplicateInfos.length;
  
  for (let i = 0; i < duplicateInfos.length; i++) {
    const info = duplicateInfos[i];
    const { parsedRecord, existingRecord, isNew } = info;
    
    onProgress?.(i + 1, total, `Processing ${parsedRecord.type}: ${parsedRecord.inputString.substring(0, 20)}...`);
    
    try {
      if (isNew) {
        const newRecordData = createNewRecordData(parsedRecord, {
          defaultTags: options.defaultTags,
          defaultCategories: options.defaultCategories,
          sourceName: options.sourceName,
          walletSoftware: options.walletSoftware,
          seedName: options.seedName,
          markAsVerified: options.markInputsAsVerified,
          owner: options.owner,
          walletName: options.walletName,
          privateKeyStatus: options.privateKeyStatus,
          labelPrefix: options.labelPrefix,
          vault: options.vault,
        });
        
        await createRecord(newRecordData);
        result.newRecords++;
      } else if (existingRecord?.id) {
        const mergedData = mergeRecordData(existingRecord, parsedRecord, {
          defaultTags: options.defaultTags,
          defaultCategories: options.defaultCategories,
          sourceName: options.sourceName,
          walletSoftware: options.walletSoftware,
          seedName: options.seedName,
          markAsVerified: options.markInputsAsVerified,
          owner: options.owner,
          walletName: options.walletName,
          privateKeyStatus: options.privateKeyStatus,
          vault: options.vault,
        });
        
        await updateRecord(existingRecord.id, mergedData);
        result.updatedRecords++;
      } else {
        result.skippedRecords++;
      }
    } catch (e) {
      result.failedRecords++;
      const errorMsg = e instanceof Error ? e.message : 'Unknown error';
      result.errors.push(`Failed to import ${parsedRecord.inputString}: ${errorMsg}`);
    }
  }
  
  return result;
}

export function getSupportedWallets(): { type: WalletType; name: string; formats: FileFormat[] }[] {
  return adapters.map(adapter => ({
    type: adapter.walletType,
    name: adapter.name,
    formats: adapter.getSupportedFormats(),
  }));
}

export { 
  type WalletType, 
  type FileFormat, 
  type ParsedRecord, 
  type ImportOptions, 
  type ImportResult,
  type DuplicateInfo,
  type DetectionResult,
  type ParseResult,
};
