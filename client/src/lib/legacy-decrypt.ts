import { decrypt } from './crypto';
import { db } from './database';

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
}

interface TableConfig {
  name: string;
  table: any;
  sensitiveFields: string[];
}

function getTableConfigs(): TableConfig[] {
  return [
    {
      name: 'Records',
      table: db.records,
      sensitiveFields: ['inputString', 'label', 'notes', 'seedName', 'walletSoftware', 'owner', 'walletName', 'source', 'customFields', 'costBasisUsd'],
    },
    {
      name: 'Attachments',
      table: db.attachments,
      sensitiveFields: ['filename', 'objectStoragePath'],
    },
    {
      name: 'Tags',
      table: db.tags,
      sensitiveFields: ['name'],
    },
    {
      name: 'Categories',
      table: db.categories,
      sensitiveFields: ['name'],
    },
    {
      name: 'Owners',
      table: db.owners,
      sensitiveFields: ['name'],
    },
    {
      name: 'Wallet Names',
      table: db.walletNames,
      sensitiveFields: ['name'],
    },
    {
      name: 'Seed Names',
      table: db.seedNames,
      sensitiveFields: ['name'],
    },
    {
      name: 'Wallet Software',
      table: db.walletSoftware,
      sensitiveFields: ['name'],
    },
    {
      name: 'Record Origins',
      table: db.recordOrigins,
      sensitiveFields: ['label', 'notes', 'seedName', 'walletSoftware', 'owner', 'walletName', 'source', 'xpub', 'derivationPath'],
    },
    {
      name: 'Transaction Participants',
      table: db.transactionParticipants,
      sensitiveFields: ['address', 'amount', 'prevTxid', 'prevVout', 'scriptType'],
    },
    {
      name: 'Derivation Templates',
      table: db.derivationTemplates,
      sensitiveFields: ['xpub', 'notes', 'owner', 'walletName', 'seedName'],
    },
    {
      name: 'UTXO Lineage',
      table: db.utxoLineage,
      sensitiveFields: [],
    },
    {
      name: 'Custody Segments',
      table: db.custodySegments,
      sensitiveFields: [],
    },
    {
      name: 'Lineage Snapshots',
      table: db.lineageSnapshots,
      sensitiveFields: [],
    },
    {
      name: 'Evidence',
      table: db.evidence,
      sensitiveFields: ['title', 'notes', 'partiesInvolved', 'source'],
    },
    {
      name: 'Evidence Attachments',
      table: db.evidenceAttachments,
      sensitiveFields: ['filename', 'objectStoragePath'],
    },
  ];
}

export async function hasLegacyEncryptedRecords(): Promise<boolean> {
  const configs = getTableConfigs();
  for (const config of configs) {
    const firstLegacy = await config.table
      .filter((item: any) => !!item._legacyEncryptedPayload)
      .limit(1)
      .toArray();
    if (firstLegacy.length > 0) return true;
  }
  return false;
}

export async function decryptLegacyRecords(
  key: CryptoKey,
  onProgress?: (progress: LegacyDecryptProgress) => void
): Promise<LegacyDecryptResult> {
  const configs = getTableConfigs();
  let totalDecrypted = 0;
  let totalFailed = 0;
  const tableErrors: string[] = [];

  for (let tableIdx = 0; tableIdx < configs.length; tableIdx++) {
    const config = configs[tableIdx];

    let lastProcessedId = 0;
    let tableDecrypted = 0;
    let tableFailed = 0;
    let hasMore = true;

    while (hasMore) {
      let chunk: any[];
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

      lastProcessedId = chunk[chunk.length - 1].id;

      const legacyItems = chunk.filter((item: any) => !!item._legacyEncryptedPayload);

      if (legacyItems.length > 0) {
        const updatedBatch: any[] = [];

        for (const item of legacyItems) {
          try {
            const decryptedJson = await decrypt(item._legacyEncryptedPayload, key);
            const sensitiveData = JSON.parse(decryptedJson);

            const restored = { ...item };

            for (const field of config.sensitiveFields) {
              if (field in sensitiveData) {
                restored[field] = sensitiveData[field];
              }
            }

            if (config.sensitiveFields.length === 0) {
              Object.assign(restored, sensitiveData);
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
            await config.table.bulkPut(updatedBatch);
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
          tableIndex: tableIdx,
          tableCount: configs.length,
          current: tableDecrypted + tableFailed,
          total: tableDecrypted + tableFailed,
          failed: tableFailed,
        });
      }

      if (chunk.length < BATCH_SIZE) {
        hasMore = false;
      }

      await new Promise(r => setTimeout(r, 0));
    }

    totalDecrypted += tableDecrypted;
    totalFailed += tableFailed;
  }

  return { totalDecrypted, totalFailed, tableErrors };
}
