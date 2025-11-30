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
import { myceliumAdapter } from './adapters/mycelium';
import { checkForDuplicates, mergeRecordData, createNewRecordData } from './merge-utils';
import { createRecord, updateRecord, isEncryptionReady } from '../encryptionFacade';

const adapters: WalletAdapter[] = [
  trezorAdapter,
  sparrowAdapter,
  myceliumAdapter,
];

export function getWalletName(walletType: WalletType): string {
  switch (walletType) {
    case 'trezor': return 'Trezor Suite';
    case 'sparrow': return 'Sparrow Wallet';
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
          markAsVerified: options.markInputsAsVerified,
          owner: options.owner,
          walletName: options.walletName,
          privateKeyStatus: options.privateKeyStatus,
        });
        
        await createRecord(newRecordData);
        result.newRecords++;
      } else if (existingRecord?.id) {
        const mergedData = mergeRecordData(existingRecord, parsedRecord, {
          defaultTags: options.defaultTags,
          defaultCategories: options.defaultCategories,
          sourceName: options.sourceName,
          walletSoftware: options.walletSoftware,
          markAsVerified: options.markInputsAsVerified,
          owner: options.owner,
          walletName: options.walletName,
          privateKeyStatus: options.privateKeyStatus,
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
