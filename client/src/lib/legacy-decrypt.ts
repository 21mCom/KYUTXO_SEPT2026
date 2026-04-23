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
}

interface TableConfig {
  name: string;
  table: any;
}

function getTableConfigs(): TableConfig[] {
  return [
    { name: 'Records', table: db.records },
    { name: 'Attachments', table: db.attachments },
    { name: 'Tags', table: db.tags },
    { name: 'Categories', table: db.categories },
    { name: 'Owners', table: db.owners },
    { name: 'Wallet Names', table: db.walletNames },
    { name: 'Seed Names', table: db.seedNames },
    { name: 'Wallet Software', table: db.walletSoftware },
    { name: 'Record Origins', table: db.recordOrigins },
    { name: 'Transaction Participants', table: db.transactionParticipants },
    { name: 'Derivation Templates', table: db.derivationTemplates },
    { name: 'UTXO Lineage', table: db.utxoLineage },
    { name: 'Custody Segments', table: db.custodySegments },
    { name: 'Lineage Snapshots', table: db.lineageSnapshots },
    { name: 'Evidence', table: db.evidence },
    { name: 'Evidence Attachments', table: db.evidenceAttachments },
  ];
}

export async function hasLegacyEncryptedRecords(): Promise<boolean> {
  const configs = getTableConfigs();
  for (const config of configs) {
    try {
      let found = false;
      await config.table.each((item: any) => {
        if (item._legacyEncryptedPayload) {
          found = true;
          return false;
        }
      });
      if (found) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function collectLegacyIds(table: any): Promise<number[]> {
  const ids: number[] = [];
  await table.each((item: any) => {
    if (item._legacyEncryptedPayload) {
      ids.push(item.id);
    }
  });
  return ids;
}

export async function decryptLegacyRecords(
  key: CryptoKey,
  onProgress?: (progress: LegacyDecryptProgress) => void
): Promise<LegacyDecryptResult> {
  const configs = getTableConfigs();
  let totalDecrypted = 0;
  let totalFailed = 0;

  for (let tableIdx = 0; tableIdx < configs.length; tableIdx++) {
    const config = configs[tableIdx];

    let legacyIds: number[];
    try {
      legacyIds = await collectLegacyIds(config.table);
    } catch {
      continue;
    }

    if (legacyIds.length === 0) continue;

    const tableTotal = legacyIds.length;

    for (let i = 0; i < legacyIds.length; i += BATCH_SIZE) {
      const batchIds = legacyIds.slice(i, i + BATCH_SIZE);
      const items = await config.table.bulkGet(batchIds);
      const updatedBatch: any[] = [];

      for (const item of items) {
        if (!item || !item._legacyEncryptedPayload) continue;

        try {
          const decryptedJson = await decrypt(item._legacyEncryptedPayload, key);
          const sensitiveData = JSON.parse(decryptedJson);

          const restored = { ...item, ...sensitiveData };
          delete restored._legacyEncryptedPayload;
          delete restored.isEncrypted;
          delete restored.encryptedPayload;
          updatedBatch.push(restored);
        } catch {
          totalFailed++;
        }
      }

      if (updatedBatch.length > 0) {
        await config.table.bulkPut(updatedBatch);
        totalDecrypted += updatedBatch.length;
      }

      if (onProgress) {
        onProgress({
          tableName: config.name,
          tableIndex: tableIdx,
          tableCount: configs.length,
          current: Math.min(i + BATCH_SIZE, tableTotal),
          total: tableTotal,
          failed: totalFailed,
        });
      }

      await new Promise(r => setTimeout(r, 0));
    }
  }

  return { totalDecrypted, totalFailed };
}
