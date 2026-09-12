import type { ParsedRecord, DuplicateInfo, VaultMetadata } from './types';
import type { Record as DBRecord, AddressImportance } from '../database';
import { getVaultRepository } from '../repository';
import { IMPORTANCE_TIERS } from '../provenance';
import { expandLabelTokens } from '../label-tokens';
import { isUserCuratedImportance } from '../db-types';
import { canonicalizeRecordIdentifier } from '../bitcoin';
import {
  computeExistingRecordMerge,
  type MetadataFieldKey,
} from '../descriptor-import-utils';

export type { MetadataFieldKey };

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
  const BATCH_SIZE = 500;
  const lookupMap = new Map<string, DBRecord>();
  const repository = getVaultRepository();
  // Canonicalize lookup keys: stored identifiers are canonical, so an
  // uppercase/padded pasted address must still match its existing record.
  const uniqueInputs = [...new Set(parsedRecords.map(r => canonicalizeRecordIdentifier(r.inputString)))];

  for (let i = 0; i < uniqueInputs.length; i += BATCH_SIZE) {
    const batch = uniqueInputs.slice(i, i + BATCH_SIZE);
    // `inputStringLower` is the canonical, indexed identity. Named repository
    // queries retain the old case-insensitive duplicate semantics without
    // leaking a Dexie collection/query builder into packaged renderers.
    const matches = await Promise.all(batch.map((input) =>
      repository.queryRecords({
        name: 'records.byInputStringLower',
        value: input,
        limit: BATCH_SIZE,
      }),
    ));
    for (const found of matches) {
      for (const r of found) {
        if (r.inputString) {
          lookupMap.set(r.inputString.trim().toLowerCase(), r);
        }
      }
    }
  }

  return parsedRecords.map(parsedRecord => {
    const normalizedInput = parsedRecord.inputString.trim().toLowerCase();
    const existingRecord = lookupMap.get(normalizedInput) || null;
    return {
      parsedRecord,
      existingRecord,
      isNew: existingRecord === null,
      willMerge: existingRecord !== null,
    };
  });
}

export interface MergeRecordReport {
  data: Partial<DBRecord>;
  /** User entered a value but the record's existing value was kept. */
  keptFields: MetadataFieldKey[];
  /** User's entry filled a previously blank field. */
  appliedFields: MetadataFieldKey[];
}

/**
 * Merge policy for an existing record, PLUS a report of which user-entered
 * scalar fields were kept-as-existing vs applied — the same transparency
 * contract Descriptor Import uses (computeExistingRecordMerge), so the UI can
 * tell the user instead of silently dropping their input.
 *
 * walletName is deliberately NOT part of the kept/applied report: an explicit
 * wallet-file import is authoritative for walletName (re-attribution), and
 * that move is already surfaced separately via reattributedRecords.
 */
export function mergeRecordDataWithReport(
  existing: DBRecord,
  incoming: ParsedRecord,
  options: {
    defaultTags: string[];
    defaultCategories: string[];
    sourceName: string;
    walletSoftware?: string;
    seedName?: string;
    incomingImportance?: AddressImportance;
    markAsVerified?: boolean;
    owner?: string;
    walletName?: string;
    privateKeyStatus?: string;
    vault?: VaultMetadata;
  }
): MergeRecordReport {
  // Only apply tags/categories/wallet metadata to input addresses
  // (addresses you control)
  const isInput = incoming.isInputAddress === true || incoming.direction === 'incoming';

  // Shared merge policy (same as Descriptor Import): tags/categories are
  // unioned, scalar metadata keeps the existing value, and the user is told
  // which of their entries were kept-as-existing vs applied.
  const scalarMerge = computeExistingRecordMerge(
    {
      owner: existing.owner,
      seedName: existing.seedName,
      walletSoftware: existing.walletSoftware,
      tags: existing.tags || [],
      categories: existing.categories || [],
    },
    {
      owner: isInput ? options.owner : undefined,
      seedName: isInput ? options.seedName : undefined,
      walletSoftware: isInput ? options.walletSoftware : undefined,
      tags: isInput ? (options.defaultTags || []) : [],
      categories: isInput ? (options.defaultCategories || []) : [],
    },
  );

  const mergedTags = scalarMerge.tags;
  const mergedCategories = scalarMerge.categories;
  
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
  } else if (options.incomingImportance && isInput && !isUserCuratedImportance(existing.addressImportance)) {
    // An explicit import of a user-controlled (input) address promotes
    // discovery-tier rows (blockchain-discovered / pending-review) to the
    // curated incoming tier — otherwise a re-attributed address would still
    // be filtered out of the curated wallet/balance surfaces. Already-curated
    // rows keep their tier: an xpub-derived row must NOT be re-labelled by a
    // later wallet-file import (vault summaries key off xpub-derived).
    newImportance = options.incomingImportance;
  }
  
  const result: Partial<DBRecord> = {
    tags: mergedTags,
    categories: mergedCategories,
    label: mergedLabel,
    notes: mergedNotes || undefined,
    amount: existing.amount ?? incoming.amount,
    date: existing.date ?? incoming.date,
    source: mergedSource,
    // Only apply wallet-origin metadata to input addresses (user-controlled)
    // Third-party outputs should not inherit seed/wallet info.
    // Scalars come from the shared merge policy: existing values win.
    walletSoftware: scalarMerge.fields.walletSoftware,
    seedName: scalarMerge.fields.seedName,
    owner: scalarMerge.fields.owner,
    // An explicit import into a named wallet is authoritative: the incoming
    // walletName wins over any inherited one (sync stamps the parent wallet's
    // name on auto-created counterparty rows). Without an explicit walletName
    // the existing attribution is preserved.
    walletName: isInput && options.walletName ? options.walletName : existing.walletName,
    privateKeyStatus: existing.privateKeyStatus || (isInput ? options.privateKeyStatus : undefined),
  };
  
  // Only include addressImportance if it should be upgraded
  if (newImportance) {
    result.addressImportance = newImportance;
  }
  
  // Apply vault metadata if not already set (only for input addresses)
  if (isInput && options.vault?.isVaultXpub && !existing.vault?.isVaultXpub) {
    result.vault = {
      isVaultXpub: options.vault.isVaultXpub,
      vaultName: options.vault.vaultName,
      m: options.vault.m,
      n: options.vault.n,
      vaultNotes: options.vault.vaultNotes,
    };
  }

  return {
    data: result,
    keptFields: scalarMerge.keptFields,
    appliedFields: scalarMerge.appliedFields,
  };
}

/** Back-compat wrapper: merge data only, without the kept/applied report. */
export function mergeRecordData(
  existing: DBRecord,
  incoming: ParsedRecord,
  options: Parameters<typeof mergeRecordDataWithReport>[2],
): Partial<DBRecord> {
  return mergeRecordDataWithReport(existing, incoming, options).data;
}

export function createNewRecordData(
  parsed: ParsedRecord,
  options: {
    defaultTags: string[];
    defaultCategories: string[];
    sourceName: string;
    walletSoftware?: string;
    seedName?: string;
    defaultImportance?: AddressImportance;
    markAsVerified?: boolean;
    owner?: string;
    walletName?: string;
    privateKeyStatus?: string;
    labelPrefix?: string;
    vault?: VaultMetadata;
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
  
  // Build the label, optionally prepending a prefix with token expansion
  let finalLabel = parsed.label || `Imported ${parsed.type}`;
  if (options.labelPrefix) {
    const expandedPrefix = expandLabelTokens(options.labelPrefix, {
      index: 0, // No sequential numbering for wallet imports
      totalCount: 1,
      walletName: options.walletName,
      recordId: parsed.inputString, // Use address/txid as the record ID
    });
    finalLabel = `${expandedPrefix}${finalLabel}`;
  }
  
  const result: Omit<DBRecord, 'id' | 'createdAt' | 'updatedAt'> = {
    type: parsed.type,
    inputString: parsed.inputString,
    label: finalLabel,
    notes: parsed.notes,
    amount: parsed.amount,
    date: parsed.date,
    tags: isInput ? (options.defaultTags || []) : [],
    categories: isInput ? (options.defaultCategories || []) : [],
    source: options.sourceName,
    // Only apply wallet-origin metadata to input addresses (user-controlled)
    // Third-party outputs should not inherit seed/wallet/derivation info
    walletSoftware: isInput ? options.walletSoftware : undefined,
    seedName: isInput ? options.seedName : undefined,
    derivationPath: isInput ? parsed.derivationPath : undefined,
    addressImportance: importance,
    owner: isInput ? options.owner : 'Unknown',
    walletName: isInput ? options.walletName : undefined,
    privateKeyStatus: isInput ? options.privateKeyStatus : undefined,
  };
  
  // Apply vault metadata (only for input addresses)
  if (isInput && options.vault?.isVaultXpub) {
    result.vault = {
      isVaultXpub: options.vault.isVaultXpub,
      vaultName: options.vault.vaultName,
      m: options.vault.m,
      n: options.vault.n,
      vaultNotes: options.vault.vaultNotes,
    };
  }
  
  return result;
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
