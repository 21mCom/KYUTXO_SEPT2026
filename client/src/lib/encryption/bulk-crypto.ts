import { db } from '../database';
import type { Record, Attachment, Tag, Category, Owner, WalletName, SeedName, WalletSoftware, RecordOrigin, DerivationTemplate, Evidence, EvidenceAttachment, TransactionParticipant } from '../database';
import {
  encryptRecord, decryptRecord,
  encryptAttachment, decryptAttachment,
  encryptTag, decryptTag,
  encryptCategory, decryptCategory,
  encryptOwner, decryptOwner,
  encryptWalletName, decryptWalletName,
  encryptSeedName, decryptSeedName,
  encryptWalletSoftware, decryptWalletSoftware,
  encryptRecordOrigin, decryptRecordOrigin,
  encryptDerivationTemplate, decryptDerivationTemplate,
  encryptEvidence, decryptEvidence,
  encryptEvidenceAttachment, decryptEvidenceAttachment,
  encryptParticipant, decryptParticipant,
} from '../dbEncryption';
import { vaultDb } from '../vault';

export type DbDecryptionState = 'encrypted' | 'decrypting' | 'decrypted' | 'encrypting';

export interface BulkCryptoProgress {
  phase: 'decrypt' | 'encrypt';
  tableName: string;
  tableIndex: number;
  tableCount: number;
  current: number;
  total: number;
  failed: number;
}

export async function getDbDecryptionState(): Promise<DbDecryptionState> {
  const settings = await vaultDb.vault.get('main');
  return (settings as any)?.dbDecryptionState ?? 'encrypted';
}

export async function setDbDecryptionState(state: DbDecryptionState): Promise<void> {
  await vaultDb.vault.update('main', { dbDecryptionState: state } as any);
}

interface TableConfig<T> {
  name: string;
  table: any;
  encryptFn: (item: T, key: CryptoKey) => Promise<T>;
  decryptFn: (item: T, key: CryptoKey) => Promise<T>;
}

function getTableConfigs(): TableConfig<any>[] {
  return [
    { name: 'Records', table: db.records, encryptFn: encryptRecord, decryptFn: decryptRecord },
    { name: 'Transaction Participants', table: db.transactionParticipants, encryptFn: encryptParticipant, decryptFn: decryptParticipant },
    { name: 'Tags', table: db.tags, encryptFn: encryptTag, decryptFn: decryptTag },
    { name: 'Categories', table: db.categories, encryptFn: encryptCategory, decryptFn: decryptCategory },
    { name: 'Owners', table: db.owners, encryptFn: encryptOwner, decryptFn: decryptOwner },
    { name: 'Wallet Names', table: db.walletNames, encryptFn: encryptWalletName, decryptFn: decryptWalletName },
    { name: 'Seed Names', table: db.seedNames, encryptFn: encryptSeedName, decryptFn: decryptSeedName },
    { name: 'Wallet Software', table: db.walletSoftware, encryptFn: encryptWalletSoftware, decryptFn: decryptWalletSoftware },
    { name: 'Attachments', table: db.attachments, encryptFn: encryptAttachment, decryptFn: decryptAttachment },
    { name: 'Evidence Attachments', table: db.evidenceAttachments, encryptFn: encryptEvidenceAttachment, decryptFn: decryptEvidenceAttachment },
    { name: 'Record Origins', table: db.recordOrigins, encryptFn: encryptRecordOrigin, decryptFn: decryptRecordOrigin },
    { name: 'Derivation Templates', table: db.derivationTemplates, encryptFn: encryptDerivationTemplate, decryptFn: decryptDerivationTemplate },
    { name: 'Evidence', table: db.evidence, encryptFn: encryptEvidence, decryptFn: decryptEvidence },
  ];
}

const BATCH_SIZE = 500;

export async function bulkDecryptDatabase(
  key: CryptoKey,
  onProgress?: (progress: BulkCryptoProgress) => void
): Promise<{ totalDecrypted: number; totalFailed: number }> {
  await setDbDecryptionState('decrypting');

  const configs = getTableConfigs();
  let totalDecrypted = 0;
  let totalFailed = 0;

  for (let tableIdx = 0; tableIdx < configs.length; tableIdx++) {
    const config = configs[tableIdx];
    const encrypted = await config.table.where('isEncrypted').equals(1).toArray();

    if (encrypted.length === 0) continue;

    for (let i = 0; i < encrypted.length; i += BATCH_SIZE) {
      const batch = encrypted.slice(i, i + BATCH_SIZE);
      const decryptedBatch: any[] = [];

      for (const item of batch) {
        try {
          if (item.isEncrypted && item.encryptedPayload) {
            const dec = await config.decryptFn(item, key);
            dec.isEncrypted = false;
            dec.encryptedPayload = undefined;
            decryptedBatch.push(dec);
          } else {
            decryptedBatch.push(item);
          }
        } catch (error) {
          console.error(`[BulkDecrypt] Failed ${config.name} id=${item.id}:`, error);
          totalFailed++;
        }
      }

      if (decryptedBatch.length > 0) {
        await config.table.bulkPut(decryptedBatch);
        totalDecrypted += decryptedBatch.length;
      }

      if (onProgress) {
        onProgress({
          phase: 'decrypt',
          tableName: config.name,
          tableIndex: tableIdx,
          tableCount: configs.length,
          current: Math.min(i + BATCH_SIZE, encrypted.length),
          total: encrypted.length,
          failed: totalFailed,
        });
      }

      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (totalFailed > 0) {
    console.warn(`[BulkDecrypt] Completed with ${totalFailed} failures. These records remain encrypted in DB.`);
  }
  await setDbDecryptionState('decrypted');
  return { totalDecrypted, totalFailed };
}

export async function bulkEncryptDatabase(
  key: CryptoKey,
  onProgress?: (progress: BulkCryptoProgress) => void
): Promise<{ totalEncrypted: number; totalFailed: number }> {
  await setDbDecryptionState('encrypting');

  const configs = getTableConfigs();
  let totalEncrypted = 0;
  let totalFailed = 0;

  for (let tableIdx = 0; tableIdx < configs.length; tableIdx++) {
    const config = configs[tableIdx];
    const plaintext = await config.table.filter((r: any) => !r.isEncrypted).toArray();

    if (plaintext.length === 0) continue;

    for (let i = 0; i < plaintext.length; i += BATCH_SIZE) {
      const batch = plaintext.slice(i, i + BATCH_SIZE);
      const encryptedBatch: any[] = [];

      for (const item of batch) {
        try {
          const enc = await config.encryptFn(item, key);
          encryptedBatch.push(enc);
        } catch (error) {
          console.error(`[BulkEncrypt] Failed ${config.name} id=${item.id}:`, error);
          totalFailed++;
        }
      }

      if (encryptedBatch.length > 0) {
        await config.table.bulkPut(encryptedBatch);
        totalEncrypted += encryptedBatch.length;
      }

      if (onProgress) {
        onProgress({
          phase: 'encrypt',
          tableName: config.name,
          tableIndex: tableIdx,
          tableCount: configs.length,
          current: Math.min(i + BATCH_SIZE, plaintext.length),
          total: plaintext.length,
          failed: totalFailed,
        });
      }

      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (totalFailed > 0) {
    console.warn(`[BulkEncrypt] Completed with ${totalFailed} failures. These records remain plaintext in DB.`);
  }
  await setDbDecryptionState('encrypted');
  return { totalEncrypted, totalFailed };
}
