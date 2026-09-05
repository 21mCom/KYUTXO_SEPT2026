import { decrypt } from './crypto';
import { getVaultRepository } from './repository';
import type { VaultRows, VaultTableName } from './repository';
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
  /**
   * Which stage of the one-time migration this progress belongs to. Absent /
   * 'decrypt' = restoring plaintext; 'verify' = the independent post-decrypt
   * re-scan that confirms no row is still locked. The overlay renders a
   * distinct heading for the verify stage so a long re-scan on a big vault
   * doesn't look like a stalled decrypt at 100%.
   */
  phase?: 'decrypt' | 'verify';
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
  table: VaultTableName;
  // Historical list of the columns that were encrypted for this table. The
  // restore loop no longer uses it to decide which fields to write back — it now
  // restores every field found in the decrypted payload. Retained only as
  // documentation and as a reference for the recovery audit.
  sensitiveFields: readonly string[];
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
      table: 'records',
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
      table: 'attachments',
      sensitiveFields: ['filename', 'objectStoragePath'] as (keyof Attachment)[],
    },
    {
      name: 'Tags',
      table: 'tags',
      sensitiveFields: ['name'] as (keyof Tag)[],
    },
    {
      name: 'Categories',
      table: 'categories',
      sensitiveFields: ['name'] as (keyof Category)[],
    },
    {
      name: 'Owners',
      table: 'owners',
      sensitiveFields: ['name'] as (keyof Owner)[],
    },
    {
      name: 'Wallet Names',
      table: 'walletNames',
      sensitiveFields: ['name'] as (keyof WalletName)[],
    },
    {
      name: 'Seed Names',
      table: 'seedNames',
      sensitiveFields: ['name'] as (keyof SeedName)[],
    },
    {
      name: 'Wallet Software',
      table: 'walletSoftware',
      sensitiveFields: ['name'] as (keyof WalletSoftware)[],
    },
    {
      name: 'Record Origins',
      table: 'recordOrigins',
      sensitiveFields: ['label', 'notes', 'seedName', 'walletSoftware', 'owner', 'walletName', 'source', 'xpub', 'derivationPath'] as (keyof RecordOrigin)[],
    },
    {
      name: 'Transaction Participants',
      table: 'transactionParticipants',
      sensitiveFields: ['address', 'amount', 'prevTxid', 'prevVout', 'scriptType'] as (keyof TransactionParticipant)[],
    },
    {
      name: 'Derivation Templates',
      table: 'derivationTemplates',
      sensitiveFields: ['xpub', 'notes', 'owner', 'walletName', 'seedName'] as (keyof DerivationTemplate)[],
    },
    {
      name: 'Evidence',
      table: 'evidence',
      sensitiveFields: ['title', 'notes', 'partiesInvolved', 'source'] as (keyof Evidence)[],
    },
    {
      name: 'Evidence Attachments',
      table: 'evidenceAttachments',
      sensitiveFields: ['filename', 'objectStoragePath'] as (keyof EvidenceAttachment)[],
    },
  ];
}

export function getTotalTableCount(): number {
  return getTableConfigs().length;
}

// ---------------------------------------------------------------------------
// Recovery-state helpers
// ---------------------------------------------------------------------------

/**
 * The literal string that a record's plaintext field holds while its real value
 * is still locked inside `_legacyEncryptedPayload`. The v29 DB migration blanked
 * this out of most record metadata fields but NOT `inputString`, so affected
 * rows keep `inputString === '[encrypted]'`.
 */
export const ENCRYPTED_PLACEHOLDER = '[encrypted]';

export function isEncryptedPlaceholder(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().toLowerCase() === ENCRYPTED_PLACEHOLDER
  );
}

function isBlankValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

/**
 * A row is "unrecovered" when ANY of its historical sensitive fields is still
 * locked. There are two different "locked" signals, because the v29 migration
 * left fields in two different states:
 *
 *  - The SENTINEL field (the first of the table's sensitiveFields) is locked
 *    when it is blank OR holds the literal "[encrypted]" placeholder. The
 *    migration guaranteed this field always carried a value, so a blank here is
 *    a reliable "never recovered" marker.
 *  - Any OTHER sensitive field is locked only when it holds the literal
 *    "[encrypted]" placeholder. A blank in these fields is NOT a locked signal —
 *    they are optional and legitimately empty on many records.
 *
 * Checking every field (not just the sentinel) is what catches rows that an
 * older one-field recovery left half-restored: the sentinel was repopulated, but
 * other fields like owner / walletName / label still show "[encrypted]". When
 * the field list is unknown we err on the side of treating the row as
 * unrecovered — a leftover marker is harmless, lost data is not.
 */
function isRowUnrecovered(
  row: globalThis.Record<string, unknown>,
  sensitiveFields: readonly string[] | undefined,
): boolean {
  if (!sensitiveFields || sensitiveFields.length === 0) return true;
  const sentinelValue = row[sensitiveFields[0]];
  if (isBlankValue(sentinelValue) || isEncryptedPlaceholder(sentinelValue)) {
    return true;
  }
  for (let i = 1; i < sensitiveFields.length; i++) {
    if (isEncryptedPlaceholder(row[sensitiveFields[i]])) {
      return true;
    }
  }
  return false;
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

async function readLegacyPage<T>(table: VaultTableName, afterId: number): Promise<LegacyRecord<T>[]> {
  return (await getVaultRepository().list(table, {
    // Every legacy-migrated table has an auto-increment numeric primary key;
    // start strictly after zero. This keeps the browser adapter on its
    // keyset/index path as well as matching protected-store paging.
    cursor: afterId,
    limit: BATCH_SIZE,
  })).rows as unknown as LegacyRecord<T>[];
}

async function countLegacyRows(table: VaultTableName): Promise<number> {
  return getVaultRepository().count(table);
}

async function saveLegacyRows<T>(table: VaultTableName, rows: LegacyRecord<T>[]): Promise<void> {
  await getVaultRepository().bulkPut(table, rows as unknown as VaultRows[typeof table][]);
}

export async function hasLegacyEncryptedRecords(alreadyCompletedTables?: string[]): Promise<boolean> {
  const configs = getTableConfigs();
  const completed = new Set(alreadyCompletedTables ?? []);
  for (const config of configs) {
    if (completed.has(config.name)) continue;
    let lastId = 0;
    for (;;) {
      const rows = await withDbRetry(() => readLegacyPage(config.table, lastId), `Probe ${config.name}`);
      if (!rows.length) break;
      if (rows.some(item => !!item._legacyEncryptedPayload)) return true;
      lastId = (rows[rows.length - 1] as { id: number }).id;
      if (rows.length < BATCH_SIZE) break;
    }
  }
  return false;
}

export interface UnrecoveredScanProgress {
  tableName: string;
  tableIndex: number;
  tableCount: number;
  /**
   * Rows walked so far in the current table. Emitted per scanned batch so a
   * large-vault verification scan shows moving numbers instead of appearing
   * stuck on the last decrypt state.
   */
  rowsScanned?: number;
}

/**
 * A pointer to a single row that is still locked: the table it lives in and its
 * primary key. The locked value itself can never be surfaced (it is exactly the
 * data we failed to decrypt), so the table name + id are the only stable,
 * offline identifiers we can show the user to confirm which records to recover.
 */
export interface LockedRecordRef {
  tableName: string;
  id: number;
}

/**
 * Cap on how many individual locked-record identifiers we collect during a scan.
 * The count is always exact; only the enumerated list is bounded so a vault with
 * tens of thousands of locked rows can't blow up memory or the download size.
 */
export const MAX_LOCKED_RECORD_REFS = 10000;

export interface UnrecoveredScanResult {
  /**
   * Rows still locked that CAN be recovered: they still carry an encrypted
   * payload, so re-running restore will repair them. This is the number that
   * gates "is recovery complete?".
   */
  totalUnrecovered: number;
  /**
   * Rows still locked whose encrypted payload is MISSING. Their original values
   * are genuinely unrecoverable — a restore cannot help them. Surfaced so the
   * user is told the truth instead of these rows being silently treated as fine.
   */
  totalUnrecoverable: number;
  perTable: { tableName: string; unrecovered: number; unrecoverable: number }[];
  /** Identifiers of the still-locked rows, capped at MAX_LOCKED_RECORD_REFS. */
  lockedRecords: LockedRecordRef[];
  /** True when more locked rows exist than were collected into lockedRecords. */
  lockedRecordsTruncated: boolean;
}

/**
 * Full scan that counts rows still holding locked plaintext: a row is locked
 * when its sentinel field is blank/"[encrypted]" OR ANY other sensitive field
 * still shows the "[encrypted]" placeholder (an older one-field recovery left
 * it half-restored). Locked rows are split two ways:
 *   - recoverable (totalUnrecovered): still carry an encrypted payload, so a
 *     re-run of restore can repair them. This is what gates "is recovery
 *     complete?" and what marker-stripping must never touch.
 *   - unrecoverable (totalUnrecoverable): the payload is missing, so the
 *     original values are genuinely gone — surfaced honestly rather than
 *     silently treated as fine.
 *
 * Alongside the count it collects identifiers (table name + id) for the
 * recoverable locked rows, up to MAX_LOCKED_RECORD_REFS, so callers can tell
 * the user exactly which records stayed locked rather than just how many.
 */
export async function countUnrecoveredLegacyRows(
  onProgress?: (progress: UnrecoveredScanProgress) => void,
  signal?: AbortSignal,
): Promise<UnrecoveredScanResult> {
  const configs = getTableConfigs();
  const perTable: { tableName: string; unrecovered: number; unrecoverable: number }[] = [];
  const lockedRecords: LockedRecordRef[] = [];
  let lockedRecordsTruncated = false;
  let totalUnrecovered = 0;
  let totalUnrecoverable = 0;

  for (let i = 0; i < configs.length; i++) {
    if (signal?.aborted) break;
    const config = configs[i];
    const sensitiveFields = config.sensitiveFields as readonly string[];
    onProgress?.({ tableName: config.name, tableIndex: i, tableCount: configs.length });

    let unrecovered = 0;
    let unrecoverable = 0;
    let lastProcessedId = 0;
    let rowsScanned = 0;
    let hasMore = true;

    while (hasMore) {
      if (signal?.aborted) break;
      const chunk = await withDbRetry(
        () => readLegacyPage(config.table, lastProcessedId),
        `Scan ${config.name}`,
      );

      if (chunk.length === 0) break;
      lastProcessedId = (chunk[chunk.length - 1] as { id: number }).id;
      rowsScanned += chunk.length;
      onProgress?.({
        tableName: config.name,
        tableIndex: i,
        tableCount: configs.length,
        rowsScanned,
      });

      for (const item of chunk) {
        const row = item as unknown as globalThis.Record<string, unknown>;
        // Only count a row as locked when it is unambiguously a legacy row:
        // it carries a legacy marker key OR still holds an "[encrypted]"
        // placeholder in a sensitive field. Modern, never-encrypted rows
        // legitimately have blank sentinel fields (e.g. address-less
        // transactionParticipants, blank-inputString records from blockchain
        // sync), and must never be reported as "missing original encrypted
        // data." But a payload-less row that kept an "[encrypted]" field is a
        // genuine (unrecoverable) legacy row and must still be counted. This
        // check mirrors the one in hasUnrecoveredLegacyData.
        if (!isDefinitelyLegacyRow(row, sensitiveFields)) continue;
        if (!isRowUnrecovered(row, sensitiveFields)) continue;
        // Whether it can be repaired depends on the encrypted payload still
        // being present — that is the only source the restore reads from.
        if (row._legacyEncryptedPayload) {
          unrecovered++;
          if (lockedRecords.length < MAX_LOCKED_RECORD_REFS) {
            lockedRecords.push({ tableName: config.name, id: (row as { id: number }).id });
          } else {
            lockedRecordsTruncated = true;
          }
        } else {
          // Locked but no payload: the original values are genuinely gone. Report
          // honestly instead of treating the row as fine.
          unrecoverable++;
        }
      }

      if (chunk.length < BATCH_SIZE) hasMore = false;
      await new Promise(r => setTimeout(r, 0));
    }

    perTable.push({ tableName: config.name, unrecovered, unrecoverable });
    totalUnrecovered += unrecovered;
    totalUnrecoverable += unrecoverable;
  }

  return { totalUnrecovered, totalUnrecoverable, perTable, lockedRecords, lockedRecordsTruncated };
}

/**
 * Early-exit probe: returns true as soon as a single unrecovered legacy row is
 * found. Used to gate destructive actions (e.g. password change) without paying
 * for a full count.
 */
export async function hasUnrecoveredLegacyData(signal?: AbortSignal): Promise<boolean> {
  const configs = getTableConfigs();
  for (const config of configs) {
    if (signal?.aborted) break;
    const sensitiveFields = config.sensitiveFields as readonly string[];
    let lastProcessedId = 0;
    let hasMore = true;

    while (hasMore) {
      if (signal?.aborted) break;
      const chunk = await withDbRetry(
        () => readLegacyPage(config.table, lastProcessedId),
        `Probe ${config.name}`,
      );

      if (chunk.length === 0) break;
      lastProcessedId = (chunk[chunk.length - 1] as { id: number }).id;

      for (const item of chunk) {
        const row = item as unknown as globalThis.Record<string, unknown>;
        if (isDefinitelyLegacyRow(row, sensitiveFields) && isRowUnrecovered(row, sensitiveFields)) {
          return true;
        }
      }

      if (chunk.length < BATCH_SIZE) hasMore = false;
      await new Promise(r => setTimeout(r, 0));
    }
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
      totalRows = await withDbRetry(() => countLegacyRows(config.table), `Audit count ${config.name}`);
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
          () => readLegacyPage(config.table, lastProcessedId),
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
    const sensitiveFields = config.sensitiveFields as readonly string[];

    // Fast, indexed row count for the progress denominator. The old code used
    // `.filter(...).count()`, which forces a full-table scan and aborts on very
    // large tables (5GB+). A failure here must NOT skip the table — fall back to
    // indeterminate progress and let the batched walk below do the real work.
    let tableTotal = 0;
    try {
      tableTotal = await withDbRetry(() => countLegacyRows(config.table), `Count ${config.name}`);
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
          () => readLegacyPage(config.table, lastProcessedId),
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

      // Only restore rows that are STILL locked: they have a payload AND at
      // least one sensitive field still showing the "[encrypted]" placeholder
      // (or a blank sentinel). Decrypt intentionally keeps the marker after a
      // successful recovery, so a recovered row carries its payload forever. If
      // we blindly re-applied that payload on a later run (login resume or the
      // manual "Restore Locked Data" action) we would silently roll back any
      // edits the user made to an already-recovered row. Checking every field
      // (not just the sentinel) is what lets a row that an older one-field
      // recovery left half-restored get picked up here instead of skipped.
      const legacyItems = chunk.filter(item => {
        if (!item._legacyEncryptedPayload) return false;
        return isRowUnrecovered(
          item as unknown as globalThis.Record<string, unknown>,
          sensitiveFields,
        );
      });

      if (legacyItems.length > 0) {
        const updatedBatch: LegacyRecord<{ id?: number }>[] = [];

        for (const item of legacyItems) {
          try {
            const decryptedJson = await decrypt(item._legacyEncryptedPayload!, key);
            const sensitiveData = JSON.parse(decryptedJson) as globalThis.Record<string, unknown>;

            // How many fields we overwrite from the payload depends on whether
            // this row was ever recovered before:
            //
            //  - Fully-locked row (sentinel still blank/"[encrypted]"): never
            //    recovered, so restore EVERY field in the payload. This is the
            //    original first-migration behaviour and is safe — a row that has
            //    never been unlocked carries no user edits to roll back. (The old
            //    whitelist silently dropped fields it didn't list, e.g. amount,
            //    date, cachedBalanceSats; restoring all keys fixed that.)
            //  - Partially-recovered row (sentinel already holds plaintext but
            //    some other field is still "[encrypted]"): an older one-field
            //    recovery left it half-restored. Refill ONLY the fields currently
            //    at the "[encrypted]" placeholder, so we never roll back a user's
            //    edit or overwrite a legitimately-empty optional field.
            //
            // Either way we skip the row id (the primary key must never change)
            // and the legacy marker keys (housekeeping, not real schema).
            const itemRow = item as unknown as globalThis.Record<string, unknown>;
            const sentinelField = sensitiveFields[0];
            const sentinelLocked =
              !sentinelField ||
              isBlankValue(itemRow[sentinelField]) ||
              isEncryptedPlaceholder(itemRow[sentinelField]);
            const restored = { ...item };

            for (const fieldKey of Object.keys(sensitiveData)) {
              if (fieldKey === 'id') continue;
              if ((LEGACY_MARKER_KEYS_TO_STRIP as readonly string[]).includes(fieldKey)) continue;
              // On a partially-recovered row, only the literal "[encrypted]"
              // placeholder marks a field as still locked; leave everything else
              // (good values, legitimately-empty optionals) exactly as it is.
              if (!sentinelLocked && !isEncryptedPlaceholder(itemRow[fieldKey])) continue;
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
              () => saveLegacyRows(config.table, updatedBatch),
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
  // Marker rows that were intentionally KEPT because the row is still
  // unrecovered (its payload is the only copy of the data). Stripping these
  // would cause permanent data loss, so they are skipped.
  rowsSkippedUnsafe: number;
}

export interface StripMarkersResult {
  totalCleaned: number;
  totalBefore: number;
  totalRemaining: number;
  totalSkippedUnsafe: number;
  tableResults: StripMarkersTableResult[];
  tableErrors: string[];
  verificationErrors: string[];
}

const LEGACY_MARKER_KEYS_TO_STRIP = ['_legacyEncryptedPayload', 'isEncrypted', 'encryptedPayload'] as const;

function hasAnyLegacyMarker(row: globalThis.Record<string, unknown>): boolean {
  for (const key of LEGACY_MARKER_KEYS_TO_STRIP) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the row is unambiguously a legacy row: it either carries a legacy
 * marker key, or it still holds the literal "[encrypted]" placeholder in one of
 * its sensitive fields. The placeholder is a definitive signal on its own —
 * modern, never-encrypted rows never write that literal string — so a row that
 * has lost its marker keys/payload but kept an "[encrypted]" field is still a
 * genuine (and unrecoverable) legacy row, not a false positive from a blank
 * sentinel. This keeps the blank-sentinel guard (which exists only to avoid
 * counting modern rows that legitimately have blank sentinels) from hiding
 * payload-less placeholder rows.
 */
function isDefinitelyLegacyRow(
  row: globalThis.Record<string, unknown>,
  sensitiveFields: readonly string[] | undefined,
): boolean {
  if (hasAnyLegacyMarker(row)) return true;
  if (sensitiveFields) {
    for (const field of sensitiveFields) {
      if (isEncryptedPlaceholder(row[field])) return true;
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
      chunk = await readLegacyPage(config.table, lastProcessedId);
    } catch (err) {
      throw new Error(
        `Failed to read ${config.name} during verification: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (chunk.length === 0) break;
    lastProcessedId = (chunk[chunk.length - 1] as { id: number }).id;
    count += chunk.filter(item => hasAnyLegacyMarker(item as unknown as globalThis.Record<string, unknown>)).length;
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
  let totalSkippedUnsafe = 0;
  const tableResults: StripMarkersTableResult[] = [];
  const tableErrors: string[] = [];
  const verificationErrors: string[] = [];

  // Phase 1: strip markers
  for (let i = 0; i < configs.length; i++) {
    if (signal?.aborted) break;
    const config = configs[i];
    const sensitiveFields = config.sensitiveFields as readonly string[];
    let rowsBefore = 0;
    let rowsCleaned = 0;
    let rowsSkippedUnsafe = 0;
    let lastProcessedId = 0;
    let hasMore = true;

    while (hasMore) {
      if (signal?.aborted) break;

      let chunk: LegacyRecord<{ id?: number }>[];
      try {
        chunk = await readLegacyPage(config.table, lastProcessedId);
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
        hasAnyLegacyMarker(item as unknown as globalThis.Record<string, unknown>),
      );

      rowsBefore += markerItems.length;

      // Safety: never strip a marker from a row whose data is still locked —
      // that means a blank/"[encrypted]" sentinel OR any other sensitive field
      // still at the "[encrypted]" placeholder. The encrypted payload is the
      // only copy of those values, so we keep the markers and report the row so
      // the user can run a restore first. Checking every field (not just the
      // sentinel) is what stops a half-restored row from having its only copy
      // silently deleted.
      const safeItems = markerItems.filter(
        item =>
          !isRowUnrecovered(
            item as unknown as globalThis.Record<string, unknown>,
            sensitiveFields,
          ),
      );
      rowsSkippedUnsafe += markerItems.length - safeItems.length;

      if (safeItems.length > 0) {
        const cleanedBatch = safeItems.map(item => {
          const cleaned = { ...item } as globalThis.Record<string, unknown>;
          for (const key of LEGACY_MARKER_KEYS_TO_STRIP) {
            delete cleaned[key];
          }
          return cleaned;
        });

        try {
          await saveLegacyRows(config.table, cleanedBatch);
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

    tableResults.push({ tableName: config.name, rowsBefore, rowsCleaned, rowsRemaining: 0, rowsSkippedUnsafe });
    totalCleaned += rowsCleaned;
    totalBefore += rowsBefore;
    totalSkippedUnsafe += rowsSkippedUnsafe;
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

  return { totalCleaned, totalBefore, totalRemaining, totalSkippedUnsafe, tableResults, tableErrors, verificationErrors };
}
