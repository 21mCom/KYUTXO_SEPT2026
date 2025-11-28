import type { ParsedRecord, DuplicateInfo } from './types';
import type { Record as DBRecord } from '../database';
import { findRecordByInputString, isEncryptionReady } from '../encryptionFacade';

export async function checkForDuplicates(
  parsedRecords: ParsedRecord[]
): Promise<DuplicateInfo[]> {
  const results: DuplicateInfo[] = [];
  
  if (!isEncryptionReady()) {
    return parsedRecords.map(record => ({
      parsedRecord: record,
      existingRecord: null,
      isNew: true,
      willMerge: false,
    }));
  }
  
  const checkedInputStrings = new Map<string, DBRecord | null>();
  
  for (const parsedRecord of parsedRecords) {
    const normalizedInput = parsedRecord.inputString.trim().toLowerCase();
    
    let existingRecord: DBRecord | null = null;
    
    if (checkedInputStrings.has(normalizedInput)) {
      existingRecord = checkedInputStrings.get(normalizedInput) || null;
    } else {
      try {
        const found = await findRecordByInputString(parsedRecord.inputString);
        existingRecord = found || null;
        checkedInputStrings.set(normalizedInput, existingRecord);
      } catch (e) {
        console.error('Error checking for duplicate:', e);
        checkedInputStrings.set(normalizedInput, null);
      }
    }
    
    results.push({
      parsedRecord,
      existingRecord,
      isNew: existingRecord === null,
      willMerge: existingRecord !== null,
    });
  }
  
  return results;
}

export function mergeRecordData(
  existing: DBRecord,
  incoming: ParsedRecord,
  options: {
    defaultTags: string[];
    defaultCategories: string[];
    sourceName: string;
    walletSoftware?: string;
  }
): Partial<DBRecord> {
  const existingTags = existing.tags || [];
  const existingCategories = existing.categories || [];
  
  // Only apply tags/categories to input addresses (addresses you control)
  const isInput = incoming.isInputAddress === true || incoming.direction === 'incoming';
  const incomingTags = isInput ? (options.defaultTags || []) : [];
  const incomingCategories = isInput ? (options.defaultCategories || []) : [];
  
  const mergedTags = Array.from(new Set([...existingTags, ...incomingTags]));
  const mergedCategories = Array.from(new Set([...existingCategories, ...incomingCategories]));
  
  let mergedLabel = existing.label;
  if (incoming.label && incoming.label !== existing.label) {
    if (!existing.label || existing.label.startsWith('From ')) {
      mergedLabel = incoming.label;
    }
  }
  
  let mergedNotes = existing.notes || '';
  if (incoming.notes && !mergedNotes.includes(incoming.notes)) {
    mergedNotes = mergedNotes 
      ? `${mergedNotes}\n\n[${options.sourceName}]: ${incoming.notes}`
      : incoming.notes;
  }
  
  const mergedSource = existing.source 
    ? `${existing.source}; ${options.sourceName}`
    : options.sourceName;
  
  return {
    tags: mergedTags,
    categories: mergedCategories,
    label: mergedLabel,
    notes: mergedNotes || undefined,
    amount: existing.amount ?? incoming.amount,
    date: existing.date ?? incoming.date,
    source: mergedSource,
    walletSoftware: existing.walletSoftware || options.walletSoftware,
  };
}

export function createNewRecordData(
  parsed: ParsedRecord,
  options: {
    defaultTags: string[];
    defaultCategories: string[];
    sourceName: string;
    walletSoftware?: string;
  }
): Omit<DBRecord, 'id' | 'createdAt' | 'updatedAt'> {
  // Only apply tags/categories to input addresses (addresses you control)
  const isInput = parsed.isInputAddress === true || parsed.direction === 'incoming';
  
  return {
    type: parsed.type,
    inputString: parsed.inputString,
    label: parsed.label || `Imported ${parsed.type}`,
    notes: parsed.notes,
    amount: parsed.amount,
    date: parsed.date,
    tags: isInput ? (options.defaultTags || []) : [],
    categories: isInput ? (options.defaultCategories || []) : [],
    source: options.sourceName,
    walletSoftware: options.walletSoftware,
    derivationPath: parsed.derivationPath,
  };
}

export function getImportSummary(duplicateInfos: DuplicateInfo[]): {
  newCount: number;
  mergeCount: number;
  transactionCount: number;
  addressCount: number;
} {
  let newCount = 0;
  let mergeCount = 0;
  let transactionCount = 0;
  let addressCount = 0;
  
  for (const info of duplicateInfos) {
    if (info.isNew) {
      newCount++;
    } else {
      mergeCount++;
    }
    
    if (info.parsedRecord.type === 'transaction') {
      transactionCount++;
    } else {
      addressCount++;
    }
  }
  
  return { newCount, mergeCount, transactionCount, addressCount };
}
