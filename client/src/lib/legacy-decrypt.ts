import { decrypt } from './crypto';
import { db } from './database';
import type { Table } from 'dexie';
import type {
  Record,
  Attachment,
  Tag,
  Category,
  Owner,
  WalletName,
  SeedName,
  WalletSoftware,
  RecordOrigin,
  TransactionParticipant,
  DerivationTemplate,
  Evidence,
  EvidenceAttachment,
} from './db-types';

const BATCH_SIZE = 500;

export interface LegacyDecryptProgress {
  tableName: string;
  tableIndex: number;
  tableCount: number;
  current: number;
  total: number;
  failed: number;
}

export interface LegacyDecryptResult {
  totalDecrypted: number;
  totalFailed: number;
  tableErrors: string[];
  completedTableNames: string[];
}

type LegacyRecord<T> = T & {
  _legacyEncryptedPayload?: string;
  isEncrypted?: boolean;
  encryptedPayload?: string;
};

interface TableConfig<T> {
  name: string;
  table: Table<T>;
  sensitiveFields: (keyof T)[];
}

export interface LegacyDecryptTableConfig {
  name: string;
  table: Table<{ id?: number } & { [key: string]: unknown }>;
  sensitiveFields: string[];
}

export function getLegacyDecryptTableConfigs(): LegacyDecryptTableConfig[] {
  return getTableConfigs().map((c) => ({
    name: c.name,
    table: c.table as unknown as Table<{ id?: number } & { [key: string]: unknown }>,
    sensitiveFields: (c.sensitiveFields as unknown[]).map(String),
  }));
}

function getTableConfigs(): TableConfig<LegacyRecord<
  Record | Attachment | Tag | Category | Owner | WalletName |
  SeedName | WalletSoftware | RecordOrigin | TransactionParticipant |
  DerivationTemplate | Evidence | EvidenceAttachment
>>[] {
  return [
    {
      name: 'Records',
      table: db.records as Table<LegacyRecord<Record>>,
      sensitiveFields: ['inputString', 'label', 'notes', 'seedName', 'walletSoftware', 'owner', 'walletName', 'source', 'customFields', 'costBasisUsd'] as (keyof Record)[],
    },
    {
      name: 'Attachments',
      table: db.attachments as Table<LegacyRecord<Attachment>>,
      sensitiveFields: ['filename', 'objectStoragePath'] as (keyof Attachment)[],
    },
    {
      name: 'Tags',
      table: db.tags as Table<LegacyRecord<Tag>>,
      sensitiveFields: ['name'] as (keyof Tag)[],
    },
    {
      name: 'Categories',
      table: db.categories as Table<LegacyRecord<Category>>,
      sensitiveFields: ['name'] as (keyof Category)[],
    },
    {
      name: 'Owners',
      table: db.owners as Table<LegacyRecord<Owner>>,
      sensitiveFields: ['name'] as (keyof Owner)[],
    },
    {
      name: 'Wallet Names',
      table: db.walletNames as Table<LegacyRecord<WalletName>>,
      sensitiveFields: ['name'] as (keyof WalletName)[],
    },
    {
      name: 'Seed Names',
      table: db.seedNames as Table<LegacyRecord<SeedName>>,
      sensitiveFields: ['name'] as (keyof SeedName)[],
    },
    {
      name: 'Wallet Software',
      table: db.walletSoftware as Table<LegacyRecord<WalletSoftware>>,
      sensitiveFields: ['name'] as (keyof WalletSoftware)[],
    },
    {
      name: 'Record Origins',
      table: db.recordOrigins as Table<LegacyRecord<RecordOrigin>>,
      sensitiveFields: ['label', 'notes', 'seedName', 'walletSoftware', 'owner', 'walletName', 'source', 'xpub', 'derivationPath'] as (keyof RecordOrigin)[],
    },
    {
      name: 'Transaction Participants',
      table: db.transactionParticipants as Table<LegacyRecord<TransactionParticipant>>,
      sensitiveFields: ['address', 'amount', 'prevTxid', 'prevVout', 'scriptType'] as (keyof TransactionParticipant)[],
    },
    {
      name: 'Derivation Templates',
      table: db.derivationTemplates as Table<LegacyRecord<DerivationTemplate>>,
      sensitiveFields: ['xpub', 'notes', 'owner', 'walletName', 'seedName'] as (keyof DerivationTemplate)[],
    },
    {
      name: 'Evidence',
      table: db.evidence as Table<LegacyRecord<Evidence>>,
      sensitiveFields: ['title', 'notes', 'partiesInvolved', 'source'] as (keyof Evidence)[],
    },
    {
      name: 'Evidence Attachments',
      table: db.evidenceAttachments as Table<LegacyRecord<EvidenceAttachment>>,
      sensitiveFields: ['filename', 'objectStoragePath'] as (keyof EvidenceAttachment)[],
    },
  ];
}

export function getTotalTableCount(): number {
  return getTableConfigs().length;
}

export async function hasLegacyEncryptedRecords(alreadyCompletedTables?: string[]): Promise<boolean> {
  const configs = getTableConfigs();
  const completed = new Set(alreadyCompletedTables ?? []);
  for (const config of configs) {
    if (completed.has(config.name)) continue;
    const firstLegacy = await config.table
      .filter((item: LegacyRecord<{ id?: number }>) => !!item._legacyEncryptedPayload)
      .limit(1)
      .toArray();
    if (firstLegacy.length > 0) return true;
  }
  return false;
}

export async function decryptLegacyRecords(
  key: CryptoKey,
  onProgress?: (progress: LegacyDecryptProgress) => void,
  options?: {
    alreadyCompletedTables?: string[];
    onTableComplete?: (tableName: string) => Promise<void> | void;
  },
): Promise<LegacyDecryptResult> {
  const allConfigs = getTableConfigs();
  const totalTableCount = allConfigs.length;
  const alreadyCompleted = new Set(options?.alreadyCompletedTables ?? []);
  const remainingConfigs = allConfigs.filter(c => !alreadyCompleted.has(c.name));
  const skippedCount = alreadyCompleted.size;

  let totalDecrypted = 0;
  let totalFailed = 0;
  const tableErrors: string[] = [];
  const completedTableNames: string[] = [];

  for (let i = 0; i < remainingConfigs.length; i++) {
    const config = remainingConfigs[i];

    let tableTotal: number;
    try {
      tableTotal = await config.table
        .filter((item: LegacyRecord<{ id?: number }>) => !!item._legacyEncryptedPayload)
        .count();
    } catch (err) {
      const msg = `Failed to count ${config.name}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[LegacyDecrypt] ${msg}`);
      tableErrors.push(msg);
      continue;
    }

    if (tableTotal === 0) {
      completedTableNames.push(config.name);
      await options?.onTableComplete?.(config.name);
      continue;
    }

    let lastProcessedId = 0;
    let tableDecrypted = 0;
    let tableFailed = 0;
    let hasMore = true;

    while (hasMore) {
      let chunk: LegacyRecord<{ id?: number }>[];
      try {
        chunk = await config.table
          .where('id')
          .above(lastProcessedId)
          .limit(BATCH_SIZE)
          .toArray();
      } catch (err) {
        const msg = `Failed to read ${config.name}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[LegacyDecrypt] ${msg}`);
        tableErrors.push(msg);
        break;
      }

      if (chunk.length === 0) {
        hasMore = false;
        break;
      }

      lastProcessedId = (chunk[chunk.length - 1] as { id: number }).id;

      const legacyItems = chunk.filter(item => !!item._legacyEncryptedPayload);

      if (legacyItems.length > 0) {
        const updatedBatch: LegacyRecord<{ id?: number }>[] = [];

        for (const item of legacyItems) {
          try {
            const decryptedJson = await decrypt(item._legacyEncryptedPayload!, key);
            const sensitiveData = JSON.parse(decryptedJson) as globalThis.Record<string, unknown>;

            const restored = { ...item };

            for (const field of config.sensitiveFields) {
              const fieldStr = field as string;
              if (fieldStr in sensitiveData) {
                (restored as globalThis.Record<string, unknown>)[fieldStr] = sensitiveData[fieldStr];
              }
            }

            delete restored._legacyEncryptedPayload;
            delete restored.isEncrypted;
            delete restored.encryptedPayload;
            updatedBatch.push(restored);
          } catch {
            tableFailed++;
          }
        }

        if (updatedBatch.length > 0) {
          try {
            await config.table.bulkPut(updatedBatch as Parameters<typeof config.table.bulkPut>[0]);
            tableDecrypted += updatedBatch.length;
          } catch (err) {
            const msg = `Failed to write ${config.name}: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[LegacyDecrypt] ${msg}`);
            tableErrors.push(msg);
            tableFailed += updatedBatch.length;
          }
        }
      }

      if (onProgress) {
        onProgress({
          tableName: config.name,
          tableIndex: skippedCount + i,
          tableCount: totalTableCount,
          current: tableDecrypted + tableFailed,
          total: tableTotal,
          failed: tableFailed,
        });
      }

      if (chunk.length < BATCH_SIZE) {
        hasMore = false;
      }

      await new Promise(r => setTimeout(r, 0));
    }

    if (tableFailed === 0) {
      completedTableNames.push(config.name);
      await options?.onTableComplete?.(config.name);
    }

    totalDecrypted += tableDecrypted;
    totalFailed += tableFailed;
  }

  return { totalDecrypted, totalFailed, tableErrors, completedTableNames };
}

// ---------------------------------------------------------------------------
// Strip stale legacy marker fields
// ---------------------------------------------------------------------------

export interface StripMarkersProgress {
  tableName: string;
  tableIndex: number;
  tableCount: number;
  rowsCleaned: number;
  phase: "strip" | "verify";
}

export interface StripMarkersTableResult {
  tableName: string;
  rowsBefore: number;
  rowsCleaned: number;
  rowsRemaining: number;
}

export interface StripMarkersResult {
  totalCleaned: number;
  totalBefore: number;
  totalRemaining: number;
  tableResults: StripMarkersTableResult[];
  tableErrors: string[];
  verificationErrors: string[];
}

const LEGACY_MARKER_KEYS_TO_STRIP = ['_legacyEncryptedPayload', 'isEncrypted', 'encryptedPayload'] as const;

function hasAnyLegacyMarker(row: Record<string, unknown>): boolean {
  for (const key of LEGACY_MARKER_KEYS_TO_STRIP) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return true;
    }
  }
  return false;
}

async function countRowsWithMarkers(
  config: ReturnType<typeof getTableConfigs>[number],
  signal?: AbortSignal,
): Promise<number> {
  let count = 0;
  let lastProcessedId = 0;
  let hasMore = true;

  while (hasMore) {
    if (signal?.aborted) break;
    let chunk: LegacyRecord<{ id?: number }>[];
    try {
      chunk = await config.table
        .where('id')
        .above(lastProcessedId)
        .limit(BATCH_SIZE)
        .toArray();
    } catch (err) {
      throw new Error(
        `Failed to read ${config.name} during verification: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (chunk.length === 0) break;
    lastProcessedId = (chunk[chunk.length - 1] as { id: number }).id;
    count += chunk.filter(item => hasAnyLegacyMarker(item as unknown as Record<string, unknown>)).length;
    if (chunk.length < BATCH_SIZE) hasMore = false;
    await new Promise(r => setTimeout(r, 0));
  }

  return count;
}

export async function stripLegacyMarkers(
  onProgress?: (progress: StripMarkersProgress) => void,
  signal?: AbortSignal,
): Promise<StripMarkersResult> {
  const configs = getTableConfigs();
  const tableCount = configs.length;
  let totalCleaned = 0;
  let totalBefore = 0;
  let totalRemaining = 0;
  const tableResults: StripMarkersTableResult[] = [];
  const tableErrors: string[] = [];
  const verificationErrors: string[] = [];

  // Phase 1: strip markers
  for (let i = 0; i < configs.length; i++) {
    if (signal?.aborted) break;
    const config = configs[i];
    let rowsBefore = 0;
    let rowsCleaned = 0;
    let lastProcessedId = 0;
    let hasMore = true;

    while (hasMore) {
      if (signal?.aborted) break;

      let chunk: LegacyRecord<{ id?: number }>[];
      try {
        chunk = await config.table
          .where('id')
          .above(lastProcessedId)
          .limit(BATCH_SIZE)
          .toArray();
      } catch (err) {
        const msg = `Failed to read ${config.name}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[StripMarkers] ${msg}`);
        tableErrors.push(msg);
        break;
      }

      if (chunk.length === 0) {
        hasMore = false;
        break;
      }

      lastProcessedId = (chunk[chunk.length - 1] as { id: number }).id;

      const markerItems = chunk.filter(item =>
        hasAnyLegacyMarker(item as unknown as Record<string, unknown>),
      );

      rowsBefore += markerItems.length;

      if (markerItems.length > 0) {
        const cleanedBatch = markerItems.map(item => {
          const cleaned = { ...item } as Record<string, unknown>;
          for (const key of LEGACY_MARKER_KEYS_TO_STRIP) {
            delete cleaned[key];
          }
          return cleaned;
        });

        try {
          await config.table.bulkPut(cleanedBatch as Parameters<typeof config.table.bulkPut>[0]);
          rowsCleaned += cleanedBatch.length;
        } catch (err) {
          const msg = `Failed to write ${config.name}: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`[StripMarkers] ${msg}`);
          tableErrors.push(msg);
        }
      }

      onProgress?.({
        tableName: config.name,
        tableIndex: i,
        tableCount,
        rowsCleaned,
        phase: "strip",
      });

      if (chunk.length < BATCH_SIZE) {
        hasMore = false;
      }

      await new Promise(r => setTimeout(r, 0));
    }

    tableResults.push({ tableName: config.name, rowsBefore, rowsCleaned, rowsRemaining: 0 });
    totalCleaned += rowsCleaned;
    totalBefore += rowsBefore;
  }

  // Phase 2: verification — count any remaining marker rows
  for (let i = 0; i < configs.length; i++) {
    if (signal?.aborted) break;
    const config = configs[i];

    onProgress?.({
      tableName: config.name,
      tableIndex: i,
      tableCount,
      rowsCleaned: tableResults[i]?.rowsCleaned ?? 0,
      phase: "verify",
    });

    try {
      const remaining = await countRowsWithMarkers(config, signal);
      if (tableResults[i]) {
        tableResults[i].rowsRemaining = remaining;
      }
      totalRemaining += remaining;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[StripMarkers] ${msg}`);
      verificationErrors.push(msg);
      // rowsRemaining stays 0 but verification for this table is incomplete;
      // callers must check verificationErrors to determine if the count is trustworthy.
    }

    await new Promise(r => setTimeout(r, 0));
  }

  return { totalCleaned, totalBefore, totalRemaining, tableResults, tableErrors, verificationErrors };
}
