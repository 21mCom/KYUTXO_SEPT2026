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
import { checkForDuplicates, mergeRecordDataWithReport, createNewRecordData, type MetadataFieldKey } from './merge-utils';
import {
  createRecord,
  updateRecord,
  createRecordOrigin,
  captureMergeOrigin,
  bulkCreateRecords,
  bulkUpdateRecords,
  bulkAddRecordOrigins,
  type CreateRecordData,
} from '../dataFacade';
import { beginBulkOperation, endBulkOperation, type Record as DBRecord } from '../database';

export function scanForPrivateKeys(content: string): { hasPrivateKeys: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  // Check for extended private keys across all common SLIP-132 prefixes:
  // xprv/tprv (BIP-32), yprv/uprv (P2SH-P2WPKH), zprv/vprv (P2WPKH),
  // Yprv/Uprv/Zprv/Vprv (multisig variants). Case-insensitive to be safe.
  if (/[xtyuzv]prv[a-zA-Z0-9]{100,}/i.test(content)) {
    warnings.push('File appears to contain extended private keys (xprv/yprv/zprv/tprv/uprv/vprv)');
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

// Chunk size for the batched DB phase below. Large enough to collapse
// per-record IndexedDB round-trips (the actual bottleneck — see Task #2122),
// small enough that a single bad chunk falling back to the slow per-record
// path stays bounded, and that a huge import still reports progress.
const IMPORT_WRITE_CHUNK_SIZE = 1000;

interface PendingCreate {
  index: number;
  parsedRecord: ParsedRecord;
  data: CreateRecordData;
}

interface PendingMerge {
  index: number;
  parsedRecord: ParsedRecord;
  existingRecord: DBRecord;
  data: Partial<DBRecord>;
  keptFields: MetadataFieldKey[];
  appliedFields: MetadataFieldKey[];
}

function buildMergeOriginInput(options: ImportOptions, parsedRecord: ParsedRecord) {
  return {
    originType: 'wallet-sync' as const,
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
  };
}

function applyMergeBookkeeping(
  result: ImportResult,
  existingRecord: DBRecord,
  data: Partial<DBRecord>,
  keptFields: MetadataFieldKey[],
  appliedFields: MetadataFieldKey[],
): void {
  for (const key of keptFields) {
    result.keptFieldCounts[key] = (result.keptFieldCounts[key] || 0) + 1;
  }
  for (const key of appliedFields) {
    result.appliedFieldCounts[key] = (result.appliedFieldCounts[key] || 0) + 1;
  }
  const previousWalletName = existingRecord.walletName || undefined;
  if (data.walletName && data.walletName !== previousWalletName) {
    result.reattributedRecords++;
  }
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
    reattributedRecords: 0,
    keptFieldCounts: {},
    appliedFieldCounts: {},
    errors: [],
  };

  const total = duplicateInfos.length;

  beginBulkOperation();
  try {
    // Phase 1: compute every record's new/merged data in memory. This is
    // pure CPU work (no DB access — analyzeRecords already took its snapshot
    // before this function ran), so it can run as one tight loop instead of
    // interleaving with the DB writes below. That interleaving — one
    // createRecord()/updateRecord() IndexedDB round-trip per input row — was
    // the actual large-import bottleneck (Task #2122), not per-record CPU
    // cost inside the CRUD layer.
    const pendingCreates: PendingCreate[] = [];
    const pendingMerges: PendingMerge[] = [];

    for (let i = 0; i < duplicateInfos.length; i++) {
      const info = duplicateInfos[i];
      const { parsedRecord, existingRecord, isNew } = info;

      onProgress?.(i + 1, total, `Processing ${parsedRecord.type}: ${parsedRecord.inputString.substring(0, 20)}...`);
      if (i % 500 === 499) await new Promise(r => setTimeout(r, 0));

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
          pendingCreates.push({ index: i, parsedRecord, data: newRecordData });
        } else if (existingRecord?.id) {
          const { data: mergedData, keptFields, appliedFields } = mergeRecordDataWithReport(existingRecord, parsedRecord, {
            defaultTags: options.defaultTags,
            defaultCategories: options.defaultCategories,
            sourceName: options.sourceName,
            walletSoftware: options.walletSoftware,
            seedName: options.seedName,
            markAsVerified: options.markInputsAsVerified,
            // A wallet-file import is an explicit claim of ownership: promote
            // discovery-tier input rows to the curated wallet-import tier so
            // re-attributed addresses actually count on the wallet surfaces.
            incomingImportance: 'wallet-import',
            owner: options.owner,
            walletName: options.walletName,
            privateKeyStatus: options.privateKeyStatus,
            vault: options.vault,
          });
          pendingMerges.push({ index: i, parsedRecord, existingRecord, data: mergedData, keptFields, appliedFields });
        } else {
          result.skippedRecords++;
        }
      } catch (e) {
        result.failedRecords++;
        const errorMsg = e instanceof Error ? e.message : 'Unknown error';
        result.errors.push(`Failed to import ${parsedRecord.inputString}: ${errorMsg}`);
      }
    }

    // Phase 2a: batch-create every new record. A duplicate input address that
    // appears more than once in the SAME file (rare, but checkForDuplicates
    // only dedupes against records already in the DB) still produces one row
    // per occurrence here, matching the previous serial behavior exactly.
    for (let start = 0; start < pendingCreates.length; start += IMPORT_WRITE_CHUNK_SIZE) {
      const chunk = pendingCreates.slice(start, start + IMPORT_WRITE_CHUNK_SIZE);
      onProgress?.(total, total, `Writing ${chunk.length} new record${chunk.length === 1 ? '' : 's'}...`);
      try {
        const ids = await bulkCreateRecords(chunk.map(c => c.data));
        try {
          const originRows = ids.map((recordId, j) => ({
            recordId,
            ...buildMergeOriginInput(options, chunk[j].parsedRecord),
          }));
          await bulkAddRecordOrigins(originRows, { skipNotification: true });
        } catch (originError) {
          console.error('[WalletImport] Failed to bulk-create record origins:', originError);
          // Don't fail the import if origin creation fails.
        }
        result.newRecords += ids.length;
      } catch (e) {
        // The whole chunk failed to write (e.g. one malformed row) — fall
        // back to the original per-record path for just this chunk so a
        // single bad row can't sink an otherwise-good large import, and so
        // failures are still attributed to the specific record.
        console.error('[WalletImport] Bulk create chunk failed, falling back to per-record inserts:', e);
        for (const c of chunk) {
          try {
            const recordId = await createRecord(c.data);
            try {
              await createRecordOrigin({ recordId, ...buildMergeOriginInput(options, c.parsedRecord) });
            } catch (originError) {
              console.error('[WalletImport] Failed to create record origin:', originError);
            }
            result.newRecords++;
          } catch (e2) {
            result.failedRecords++;
            const errorMsg = e2 instanceof Error ? e2.message : 'Unknown error';
            result.errors.push(`Failed to import ${c.parsedRecord.inputString}: ${errorMsg}`);
          }
        }
      }
    }

    // Phase 2b: batch-update merges. Duplicate input rows that resolve to the
    // SAME existing record (also rare) must still apply in original order —
    // bulkUpdateRecords bases every merge in a batch on one pre-batch read,
    // so those groups are processed sequentially via the original per-record
    // path (which re-reads before each write) to preserve exact behavior;
    // every other (overwhelmingly common) group of size 1 takes the fast path.
    const mergesByExistingId = new Map<number, PendingMerge[]>();
    for (const merge of pendingMerges) {
      const id = merge.existingRecord.id!;
      const group = mergesByExistingId.get(id);
      if (group) group.push(merge);
      else mergesByExistingId.set(id, [merge]);
    }

    const singleMerges: PendingMerge[] = [];
    const duplicateMergeGroups: PendingMerge[][] = [];
    for (const group of mergesByExistingId.values()) {
      if (group.length === 1) singleMerges.push(group[0]);
      else duplicateMergeGroups.push(group);
    }

    for (let start = 0; start < singleMerges.length; start += IMPORT_WRITE_CHUNK_SIZE) {
      const chunk = singleMerges.slice(start, start + IMPORT_WRITE_CHUNK_SIZE);
      onProgress?.(total, total, `Writing ${chunk.length} merged record${chunk.length === 1 ? '' : 's'}...`);
      try {
        await bulkUpdateRecords(
          chunk.map(m => ({ id: m.existingRecord.id!, changes: m.data })),
        );
        for (const m of chunk) {
          applyMergeBookkeeping(result, m.existingRecord, m.data, m.keptFields, m.appliedFields);
          result.updatedRecords++;
        }
        // Origin bookkeeping is per-record (dedup/baseline logic keyed on
        // recordId) but each record in this chunk is distinct, so the reads
        // and writes inside captureMergeOrigin can never collide — safe to
        // run concurrently instead of one DB round-trip at a time.
        await Promise.all(
          chunk.map(m => captureMergeOrigin(m.existingRecord, buildMergeOriginInput(options, m.parsedRecord)))
        );
      } catch (e) {
        console.error('[WalletImport] Bulk update chunk failed, falling back to per-record updates:', e);
        for (const m of chunk) {
          try {
            await updateRecord(m.existingRecord.id!, m.data);
            applyMergeBookkeeping(result, m.existingRecord, m.data, m.keptFields, m.appliedFields);
            await captureMergeOrigin(m.existingRecord, buildMergeOriginInput(options, m.parsedRecord));
            result.updatedRecords++;
          } catch (e2) {
            result.failedRecords++;
            const errorMsg = e2 instanceof Error ? e2.message : 'Unknown error';
            result.errors.push(`Failed to import ${m.parsedRecord.inputString}: ${errorMsg}`);
          }
        }
      }
    }

    // Rare path: two or more input rows resolving to the same existing
    // record. Process exactly like the original serial loop (re-read before
    // each write) so compounding merges land the same way they always have.
    for (const group of duplicateMergeGroups) {
      for (const m of group) {
        try {
          await updateRecord(m.existingRecord.id!, m.data);
          applyMergeBookkeeping(result, m.existingRecord, m.data, m.keptFields, m.appliedFields);
          await captureMergeOrigin(m.existingRecord, buildMergeOriginInput(options, m.parsedRecord));
          result.updatedRecords++;
        } catch (e) {
          result.failedRecords++;
          const errorMsg = e instanceof Error ? e.message : 'Unknown error';
          result.errors.push(`Failed to import ${m.parsedRecord.inputString}: ${errorMsg}`);
        }
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
