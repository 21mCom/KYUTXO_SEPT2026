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
  // Historical list of the columns that were encrypted for this table. The
  // restore loop no longer uses it to decide which fields to write back — it now
  // restores every field found in the decrypted payload. Retained only as
  // documentation and as a reference for the recovery audit.
  sensitiveFields: (keyof T)[];
  // Runs after the decrypted fields are restored onto a row. Used to
  // recompute derived/index columns (e.g. inputStringLower) that depend on a
  // restored field — without this, indexed lookups silently miss the row.
  postProcess?: (restored: globalThis.Record<string, unknown>) => void;
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
      // inputStringLower backs case-insensitive / fast inputString lookups. It
      // must be re-derived from the restored plaintext inputString: the v30
      // migration only set it while records were still encrypted (empty
      // inputString), so without this every decrypted record would be unfindable
      // via the inputStringLower index.
      postProcess: (restored) => {
        const inputString = restored.inputString;
        restored.inputStringLower =
          typeof inputString === 'string' ? inputString.toLowerCase() : '';
      },
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

const ABORT_RETRY_ATTEMPTS = 5;

/**
 * Detects transient IndexedDB failures that are worth retrying. Large vaults
 * (5GB+) regularly hit transaction aborts when several heavy operations run at
 * once; these resolve on a short backoff.
 */
function isRetryableDbError(err: unknown): boolean {
  const name = (err as { name?: string } | null | undefined)?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return (
    name === 'AbortError' ||
    name === 'TransactionInactiveError' ||
    name === 'UnknownError' ||
    /abort|transaction.*(inactive|finished)|timed? ?out/i.test(message)
  );
}

/**
 * Runs an IndexedDB operation with bounded exponential backoff on transient
 * abort errors. Non-retryable errors are rethrown immediately. All operations
 * passed here must be idempotent (keyset reads, bulkPut of the same rows).
 */
async function withDbRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempts = ABORT_RETRY_ATTEMPTS,
): Promise<T> {
  let delay = 150;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryableDbError(err)) throw err;
      console.warn(
        `[LegacyDecrypt] ${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 2000);
    }
  }
}

export async function hasLegacyEncryptedRecords(alreadyCompletedTables?: string[]): Promise<boolean> {
  const configs = getTableConfigs();
  const completed = new Set(alreadyCompletedTables ?? []);
  for (const config of configs) {
    if (completed.has(config.name)) continue;
    const firstLegacy = await withDbRetry(
      () =>
        config.table
          .filter((item: LegacyRecord<{ id?: number }>) => !!item._legacyEncryptedPayload)
          .limit(1)
          .toArray(),
      `Probe ${config.name}`,
    );
    if (firstLegacy.length > 0) return true;
  }
  return false;
}

export interface LegacyAuditTableResult {
  tableName: string;
  totalRows: number;
  encryptedRows: number;
  sampledRows: number;
  fieldNames: string[];
  decryptFailures: number;
  alreadyMigrated: boolean;
}

export interface LegacyAuditResult {
  tables: LegacyAuditTableResult[];
}

/**
 * READ-ONLY diagnostic. For each table it counts how many rows still carry an
 * encrypted payload, decrypts a small sample, and reports the field NAMES found
 * inside (never the values) plus whether the table was already marked migrated.
 * This lets the user confirm exactly what is recoverable for their own vault
 * BEFORE running any destructive migration. It writes nothing.
 */
export async function auditLegacyPayloads(
  key: CryptoKey,
  options?: { sampleSize?: number; alreadyCompletedTables?: string[] },
): Promise<LegacyAuditResult> {
  const sampleSize = Math.max(0, options?.sampleSize ?? 5);
  const alreadyCompleted = new Set(options?.alreadyCompletedTables ?? []);
  const configs = getTableConfigs();
  const tables: LegacyAuditTableResult[] = [];

  for (const config of configs) {
    let totalRows = 0;
    try {
      totalRows = await withDbRetry(() => config.table.count(), `Audit count ${config.name}`);
    } catch {
      totalRows = 0;
    }

    let encryptedRows = 0;
    const samples: string[] = [];
    let lastProcessedId = 0;
    let hasMore = true;

    while (hasMore) {
      let chunk: LegacyRecord<{ id?: number }>[];
      try {
        chunk = await withDbRetry(
          () =>
            config.table
              .where('id')
              .above(lastProcessedId)
              .limit(BATCH_SIZE)
              .toArray(),
          `Audit read ${config.name}`,
        );
      } catch {
        break;
      }

      if (chunk.length === 0) break;
      lastProcessedId = (chunk[chunk.length - 1] as { id: number }).id;

      for (const item of chunk) {
        if (item._legacyEncryptedPayload) {
          encryptedRows++;
          if (samples.length < sampleSize) {
            samples.push(item._legacyEncryptedPayload);
          }
        }
      }

      if (chunk.length < BATCH_SIZE) hasMore = false;
      await new Promise(r => setTimeout(r, 0));
    }

    const fieldNameSet = new Set<string>();
    let decryptFailures = 0;
    for (const payload of samples) {
      try {
        const decryptedJson = await decrypt(payload, key);
        const data = JSON.parse(decryptedJson) as globalThis.Record<string, unknown>;
        for (const fieldKey of Object.keys(data)) {
          if (fieldKey === 'id') continue;
          if ((LEGACY_MARKER_KEYS_TO_STRIP as readonly string[]).includes(fieldKey)) continue;
          fieldNameSet.add(fieldKey);
        }
      } catch {
        decryptFailures++;
      }
    }

    tables.push({
      tableName: config.name,
      totalRows,
      encryptedRows,
      sampledRows: samples.length,
      fieldNames: Array.from(fieldNameSet).sort(),
      decryptFailures,
      alreadyMigrated: alreadyCompleted.has(config.name),
    });
  }

  return { tables };
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

    // Fast, indexed row count for the progress denominator. The old code used
    // `.filter(...).count()`, which forces a full-table scan and aborts on very
    // large tables (5GB+). A failure here must NOT skip the table — fall back to
    // indeterminate progress and let the batched walk below do the real work.
    let tableTotal = 0;
    try {
      tableTotal = await withDbRetry(() => config.table.count(), `Count ${config.name}`);
    } catch (err) {
      console.warn(
        `[LegacyDecrypt] Could not pre-count ${config.name}, continuing with indeterminate progress:`,
        err instanceof Error ? err.message : err,
      );
      tableTotal = 0;
    }

    let lastProcessedId = 0;
    let tableProcessed = 0;
    let tableDecrypted = 0;
    let tableFailed = 0;
    let tableReadFailed = false;
    let hasMore = true;

    while (hasMore) {
      let chunk: LegacyRecord<{ id?: number }>[];
      try {
        chunk = await withDbRetry(
          () =>
            config.table
              .where('id')
              .above(lastProcessedId)
              .limit(BATCH_SIZE)
              .toArray(),
          `Read ${config.name}`,
        );
      } catch (err) {
        const msg = `Failed to read ${config.name}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[LegacyDecrypt] ${msg}`);
        tableErrors.push(msg);
        tableReadFailed = true;
        break;
      }

      if (chunk.length === 0) {
        hasMore = false;
        break;
      }

      lastProcessedId = (chunk[chunk.length - 1] as { id: number }).id;
      tableProcessed += chunk.length;

      const legacyItems = chunk.filter(item => !!item._legacyEncryptedPayload);

      if (legacyItems.length > 0) {
        const updatedBatch: LegacyRecord<{ id?: number }>[] = [];

        for (const item of legacyItems) {
          try {
            const decryptedJson = await decrypt(item._legacyEncryptedPayload!, key);
            const sensitiveData = JSON.parse(decryptedJson) as globalThis.Record<string, unknown>;

            // Restore EVERY field present in the decrypted payload, not just a
            // fixed whitelist. The old whitelist silently dropped any encrypted
            // field that was not listed (e.g. amount, date, addressImportance,
            // cachedBalanceSats), leaving those columns permanently at their
            // defaults. We skip only the row id (the primary key must never
            // change) and the legacy marker keys (housekeeping, not real schema).
            const restored = { ...item };

            for (const fieldKey of Object.keys(sensitiveData)) {
              if (fieldKey === 'id') continue;
              if ((LEGACY_MARKER_KEYS_TO_STRIP as readonly string[]).includes(fieldKey)) continue;
              (restored as globalThis.Record<string, unknown>)[fieldKey] = sensitiveData[fieldKey];
            }

            config.postProcess?.(restored as globalThis.Record<string, unknown>);

            // Intentionally KEEP the encrypted markers in place here. They are
            // the only recoverable source of the original values, so deleting
            // them at decrypt time turned any partial/failed migration into
            // permanent data loss. The markers are removed later by the
            // separate, user-initiated strip step, run only once the restore has
            // been verified.
            updatedBatch.push(restored);
          } catch {
            tableFailed++;
          }
        }

        if (updatedBatch.length > 0) {
          try {
            await withDbRetry(
              () => config.table.bulkPut(updatedBatch as Parameters<typeof config.table.bulkPut>[0]),
              `Write ${config.name}`,
            );
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
          current: tableProcessed,
          total: tableTotal,
          failed: tableFailed,
        });
      }

      if (chunk.length < BATCH_SIZE) {
        hasMore = false;
      }

      await new Promise(r => setTimeout(r, 0));
    }

    // Only mark a table complete if it was fully scanned (no permanent read
    // failure) AND every encrypted row decrypted successfully. The previous
    // code marked a table complete even after a mid-table read break, which
    // could permanently skip rows that were never decrypted.
    if (!tableReadFailed && tableFailed === 0) {
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
