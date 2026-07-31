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
import { phoenixAdapter } from './adapters/phoenix';
import { walletOfSatoshiAdapter } from './adapters/wallet-of-satoshi';
import { nunchukAdapter } from './adapters/nunchuk';
import { checkForDuplicates, mergeRecordData, createNewRecordData } from './merge-utils';
import { createRecord, updateRecord, createRecordOrigin, captureMergeOrigin } from '../dataFacade';
import { beginBulkOperation, endBulkOperation } from '../database';

export function scanForPrivateKeys(content: string): { hasPrivateKeys: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  // Check for extended private keys (xprv/tprv)
  if (/xprv[a-zA-Z0-9]{100,}/i.test(content) || /tprv[a-zA-Z0-9]{100,}/i.test(content)) {
    warnings.push('File appears to contain extended private keys (xprv/tprv)');
  }
  
  // Check for WIF private keys (start with 5, K, or L followed by 50-52 base58 chars)
  // Only match standalone keys, not as part of other data
  if (/(?:^|[^a-zA-Z0-9])[5KL][1-9A-HJ-NP-Za-km-z]{50,52}(?:$|[^a-zA-Z0-9])/m.test(content)) {
    warnings.push('File appears to contain WIF private keys');
  }
  
  // Check for JSON fields with actual values (not empty/null)
  // "wif": "actualValue" (not "wif": "" or "wif": null)
  if (/"wif"\s*:\s*"[^"]{10,}"/i.test(content)) {
    warnings.push('File appears to contain WIF private keys');
  }
  
  // "privateKey" or "private_key" with actual value
  if (/"private[_]?[kK]ey"\s*:\s*"[^"]{10,}"/i.test(content)) {
    warnings.push('File appears to contain private key data');
  }
  
  // Raw seed data (64+ hex chars as a value)
  if (/"seed"\s*:\s*"[a-f0-9]{64,}"/i.test(content)) {
    warnings.push('File appears to contain raw seed data');
  }
  
  // Mnemonic with actual words (not empty)
  if (/"mnemonic"\s*:\s*"[a-z]{3,}(\s+[a-z]{3,}){11,}"/i.test(content)) {
    warnings.push('File appears to contain mnemonic seed phrases');
  }
  
  // PEM private keys
  if (/-----BEGIN.*PRIVATE KEY-----/.test(content)) {
    warnings.push('File appears to contain private key material');
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
  phoenixAdapter,
  walletOfSatoshiAdapter,
  nunchukAdapter,
];

export function getWalletName(walletType: WalletType): string {
  switch (walletType) {
    case 'trezor': return 'Trezor Suite';
    case 'sparrow': return 'Sparrow Wallet';
    case 'sparrow-bip329': return 'BIP-329 Labels (Sparrow)';
    case 'mycelium': return 'Mycelium';
    case 'phoenix': return 'Phoenix Wallet';
    case 'wallet-of-satoshi': return 'Wallet of Satoshi';
    case 'nunchuk': return 'Nunchuk';
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
  
  const total = duplicateInfos.length;
  
  beginBulkOperation();
  try {
  for (let i = 0; i < duplicateInfos.length; i++) {
    const info = duplicateInfos[i];
    const { parsedRecord, existingRecord, isNew } = info;
    
    onProgress?.(i + 1, total, `Processing ${parsedRecord.type}: ${parsedRecord.inputString.substring(0, 20)}...`);
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    
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
        
        const recordId = await createRecord(newRecordData);
        
        // Create record origin entry to track wallet sync source
        try {
          await createRecordOrigin({
            recordId,
            originType: 'wallet-sync',
            source: options.sourceName,
            label: newRecordData.label,
            notes: newRecordData.notes,
            tags: options.defaultTags,
            categories: options.defaultCategories,
            owner: options.owner,
            walletName: options.walletName,
            seedName: options.seedName,
            walletSoftware: options.walletSoftware,
            privateKeyStatus: options.privateKeyStatus,
          });
        } catch (originError) {
          console.error('[WalletImport] Failed to create record origin:', originError);
          // Don't fail the import if origin creation fails
        }
        
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
        
        // Record the incoming wallet-sync metadata as an origin (backfilling
        // a baseline origin first when the record has none) so differing
        // values surface on the Conflict Resolution page. Non-fatal.
        await captureMergeOrigin(existingRecord, {
          originType: 'wallet-sync',
          source: options.sourceName,
          label: parsedRecord.label,
          notes: parsedRecord.notes,
          tags: options.defaultTags,
          categories: options.defaultCategories,
          owner: options.owner,
          walletName: options.walletName,
          seedName: options.seedName,
          walletSoftware: options.walletSoftware,
          privateKeyStatus: options.privateKeyStatus,
        });
        
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
  } finally {
    endBulkOperation();
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
