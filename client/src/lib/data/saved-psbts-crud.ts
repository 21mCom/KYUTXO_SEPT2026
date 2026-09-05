import { db, notifyDbChange, type SavedPsbt } from '../database';
import { getVaultRepository, ProtectedVaultRepository } from '../repository';

// All writes to db.savedPsbts go through this module (mirrors the other
// lightweight CRUD modules like dust-flags-crud).

export type NewSavedPsbt = Omit<SavedPsbt, 'id' | 'createdAt' | 'updatedAt'>;

/** Persist a built unsigned PSBT with its decoded components. Returns the id. */
export async function savePsbt(input: NewSavedPsbt): Promise<number> {
  const now = Date.now();
  const row = {
    ...input,
    name: input.name.trim() || 'Untitled PSBT',
    createdAt: now,
    updatedAt: now,
  };
  const repository = getVaultRepository();
  const id = repository.kind === 'protected' ? await repository.add('savedPsbts', row) : await db.savedPsbts.add(row);
  notifyDbChange('savedPsbts');
  return id as number;
}

/** All saved PSBTs, newest first. */
export async function getAllSavedPsbts(): Promise<SavedPsbt[]> {
  const repository = getVaultRepository();
  const rows = repository instanceof ProtectedVaultRepository
    ? await repository.query<SavedPsbt>('savedPsbts', 'savedPsbts.byCreatedAt', 'desc')
    : await db.savedPsbts.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function renameSavedPsbt(id: number, name: string): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.update('savedPsbts', id, { name: name.trim() || 'Untitled PSBT', updatedAt: Date.now() });
  else await db.savedPsbts.update(id, { name: name.trim() || 'Untitled PSBT', updatedAt: Date.now() });
  notifyDbChange('savedPsbts');
}

export async function deleteSavedPsbt(id: number): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.delete('savedPsbts', id);
  else await db.savedPsbts.delete(id);
  notifyDbChange('savedPsbts');
}

export interface SavedPsbtWriteOptions {
  skipNotification?: boolean;
}

export async function clearSavedPsbts(options?: SavedPsbtWriteOptions): Promise<void> {
  const repository = getVaultRepository();
  if (repository.kind === 'protected') await repository.clear('savedPsbts');
  else await db.savedPsbts.clear();
  if (!options?.skipNotification) {
    notifyDbChange('savedPsbts');
  }
}

export type SavedPsbtRestoreMode = 'merge' | 'replace';

/**
 * Backup-id -> live-id maps produced by restoreEvidenceRows. Notarization
 * data outputs reference evidence/attachment ids, which CHANGE on restore
 * (fresh autoincrement ids); the references must be remapped through these
 * maps or they would dangle — or worse, collide with unrelated live rows.
 */
export interface SavedPsbtEvidenceRefRemap {
  evidenceIdMap: Map<number, number>;
  evidenceAttachmentIdMap: Map<number, number>;
}

/**
 * Restore saved-PSBT rows from a backup. SINGLE source of truth for the backup
 * restore path (v3 inline tables).
 *
 * The backup `id` is always stripped (every row gets a fresh autoincrement id).
 * Inputs reference txids (stable across restores), but notarization data
 * outputs reference evidence/attachment ids: when `remapEvidenceRefs` is
 * provided those references are rewritten through the restore's id maps, and
 * references whose target no longer exists are DROPPED (the payload and
 * filename/title hints are kept so the output stays inspectable). In MERGE
 * mode a row whose PSBT bytes already exist in the vault is skipped so merging
 * the same backup twice can't duplicate entries. Rows missing psbtBase64 are
 * skipped (a PSBT without its bytes is useless).
 *
 * Returns the number of rows actually written.
 */
export async function restoreSavedPsbtRows(
  rows: any[] | undefined,
  restoreMode: SavedPsbtRestoreMode,
  options?: SavedPsbtWriteOptions,
  // Optional collector: every freshly inserted row's id is pushed here, so a
  // cancelled merge can undo exactly the rows this restore added.
  collect?: { insertedIds?: number[] },
  remapEvidenceRefs?: SavedPsbtEvidenceRefRemap,
): Promise<number> {
  if (!rows || rows.length === 0) return 0;

  const seen = new Set<string>();
  if (restoreMode === 'merge') {
    const repository = getVaultRepository();
    const existing = repository instanceof ProtectedVaultRepository
      ? await repository.query<SavedPsbt>('savedPsbts', 'savedPsbts.byCreatedAt', 'desc')
      : await db.savedPsbts.toArray();
    for (const e of existing) seen.add(e.psbtBase64);
  }

  const now = Date.now();
  const toAdd: SavedPsbt[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const { id, ...d } = r;
    if (typeof d.psbtBase64 !== 'string' || d.psbtBase64.length === 0) continue;
    if (seen.has(d.psbtBase64)) continue;
    seen.add(d.psbtBase64);
    toAdd.push({
      name: typeof d.name === 'string' && d.name.trim() ? d.name : 'Untitled PSBT',
      psbtBase64: d.psbtBase64,
      destinationAddress: typeof d.destinationAddress === 'string' ? d.destinationAddress : '',
      changeAddress: typeof d.changeAddress === 'string' ? d.changeAddress : undefined,
      feeRateSatsPerVb: typeof d.feeRateSatsPerVb === 'number' ? d.feeRateSatsPerVb : 0,
      feeSats: typeof d.feeSats === 'number' ? d.feeSats : 0,
      estimatedVbytes: typeof d.estimatedVbytes === 'number' ? d.estimatedVbytes : 0,
      totalInputSats: typeof d.totalInputSats === 'number' ? d.totalInputSats : 0,
      sendAmountSats: typeof d.sendAmountSats === 'number' ? d.sendAmountSats : 0,
      changeSats: typeof d.changeSats === 'number' ? d.changeSats : 0,
      inputs: Array.isArray(d.inputs) ? d.inputs : [],
      outputs: Array.isArray(d.outputs)
        ? d.outputs.map((o: any) => {
            if (!o?.dataOutput || !remapEvidenceRefs) return o;
            const data = o.dataOutput;
            return {
              ...o,
              dataOutput: {
                ...data,
                // Remap through the restore's id maps; a reference whose target
                // no longer exists is dropped rather than left dangling (a
                // stale numeric id could point at an unrelated live row).
                evidenceId:
                  typeof data.evidenceId === 'number'
                    ? remapEvidenceRefs.evidenceIdMap.get(data.evidenceId)
                    : undefined,
                evidenceAttachmentId:
                  typeof data.evidenceAttachmentId === 'number'
                    ? remapEvidenceRefs.evidenceAttachmentIdMap.get(data.evidenceAttachmentId)
                    : undefined,
              },
            };
          })
        : [],
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : now,
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : now,
    });
  }

  if (toAdd.length > 0) {
    const repository = getVaultRepository();
    const newIds = repository instanceof ProtectedVaultRepository
      ? await repository.saveBatch('savedPsbts', toAdd)
      : await db.savedPsbts.bulkAdd(toAdd, { allKeys: true });
    if (collect?.insertedIds) {
      for (const id of newIds) collect.insertedIds.push(id as number);
    }
    if (!options?.skipNotification) {
      notifyDbChange('savedPsbts');
    }
  }
  return toAdd.length;
}
