import type { ParsedRecord, DuplicateInfo } from './types';
import type { Record as DBRecord, AddressImportance } from '../database';
import { findRecordByInputString, isEncryptionReady } from '../encryptionFacade';
import { IMPORTANCE_TIERS } from '../provenance';

// Determine if the incoming importance should upgrade the existing one
// Returns the new importance if it should be upgraded, or undefined if no change
export function shouldUpgradeImportance(
  existingImportance: AddressImportance | undefined,
  incomingImportance: AddressImportance | undefined
): AddressImportance | undefined {
  if (!incomingImportance) return undefined;
  
  const existingTier = IMPORTANCE_TIERS[existingImportance || 'pending-review'];
  const incomingTier = IMPORTANCE_TIERS[incomingImportance];
  
  // Only upgrade, never downgrade
  if (incomingTier > existingTier) {
    return incomingImportance;
  }
  
  return undefined;
}

// Check if a record is verified - verified records should never be downgraded
export function isVerified(record: DBRecord | null | undefined): boolean {
  return record?.addressImportance === 'verified';
}

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
    incomingImportance?: AddressImportance;
    markAsVerified?: boolean;
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
  
  // Handle importance upgrading - NEVER downgrade verified addresses
  let newImportance: AddressImportance | undefined;
  
  // If markAsVerified is explicitly set AND this is an input address, mark as verified
  if (options.markAsVerified && isInput) {
    newImportance = shouldUpgradeImportance(existing.addressImportance, 'verified');
  } else if (options.incomingImportance) {
    // Otherwise, try to upgrade based on incoming importance
    newImportance = shouldUpgradeImportance(existing.addressImportance, options.incomingImportance);
  }
  
  const result: Partial<DBRecord> = {
    tags: mergedTags,
    categories: mergedCategories,
    label: mergedLabel,
    notes: mergedNotes || undefined,
    amount: existing.amount ?? incoming.amount,
    date: existing.date ?? incoming.date,
    source: mergedSource,
    walletSoftware: existing.walletSoftware || options.walletSoftware,
  };
  
  // Only include addressImportance if it should be upgraded
  if (newImportance) {
    result.addressImportance = newImportance;
  }
  
  return result;
}

export function createNewRecordData(
  parsed: ParsedRecord,
  options: {
    defaultTags: string[];
    defaultCategories: string[];
    sourceName: string;
    walletSoftware?: string;
    defaultImportance?: AddressImportance;
    markAsVerified?: boolean;
    owner?: string;
    walletName?: string;
  }
): Omit<DBRecord, 'id' | 'createdAt' | 'updatedAt'> {
  // Only apply tags/categories to input addresses (addresses you control)
  const isInput = parsed.isInputAddress === true || parsed.direction === 'incoming';
  
  // Determine importance level
  let importance: AddressImportance | undefined;
  if (options.markAsVerified && isInput) {
    // If markAsVerified is set for input addresses, use verified
    importance = 'verified';
  } else if (isInput && options.defaultImportance) {
    // For input addresses, use the provided default importance
    importance = options.defaultImportance;
  } else if (!isInput) {
    // Output addresses (not controlled by user) default to pending-review
    importance = 'pending-review';
  } else {
    // Fallback
    importance = options.defaultImportance || 'wallet-import';
  }
  
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
    addressImportance: importance,
    owner: isInput ? options.owner : 'Unknown',
    walletName: isInput ? options.walletName : undefined,
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
