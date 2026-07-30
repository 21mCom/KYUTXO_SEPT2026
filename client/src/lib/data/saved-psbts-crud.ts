import { db, notifyDbChange, type SavedPsbt } from '../database';

// All writes to db.savedPsbts go through this module (mirrors the other
// lightweight CRUD modules like dust-flags-crud).

export type NewSavedPsbt = Omit<SavedPsbt, 'id' | 'createdAt' | 'updatedAt'>;

/** Persist a built unsigned PSBT with its decoded components. Returns the id. */
export async function savePsbt(input: NewSavedPsbt): Promise<number> {
  const now = Date.now();
  const id = await db.savedPsbts.add({
    ...input,
    name: input.name.trim() || 'Untitled PSBT',
    createdAt: now,
    updatedAt: now,
  });
  notifyDbChange('savedPsbts');
  return id as number;
}

/** All saved PSBTs, newest first. */
export async function getAllSavedPsbts(): Promise<SavedPsbt[]> {
  const rows = await db.savedPsbts.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function renameSavedPsbt(id: number, name: string): Promise<void> {
  await db.savedPsbts.update(id, { name: name.trim() || 'Untitled PSBT', updatedAt: Date.now() });
  notifyDbChange('savedPsbts');
}

export async function deleteSavedPsbt(id: number): Promise<void> {
  await db.savedPsbts.delete(id);
  notifyDbChange('savedPsbts');
}

export interface SavedPsbtWriteOptions {
  skipNotification?: boolean;
}

export async function clearSavedPsbts(options?: SavedPsbtWriteOptions): Promise<void> {
  await db.savedPsbts.clear();
  if (!options?.skipNotification) {
    notifyDbChange('savedPsbts');
  }
}

export type SavedPsbtRestoreMode = 'merge' | 'replace';

/**
 * Restore saved-PSBT rows from a backup. SINGLE source of truth for the backup
 * restore path (v3 inline tables).
 *
 * The backup `id` is always stripped (every row gets a fresh autoincrement id);
 * the rows carry no foreign keys into other tables (inputs reference txids,
 * which are stable across restores), so no id remap is needed. In MERGE mode a
 * row whose PSBT bytes already exist in the vault is skipped so merging the
 * same backup twice can't duplicate entries. Rows missing psbtBase64 are
 * skipped (a PSBT without its bytes is useless).
 *
 * Returns the number of rows actually written.
 */
export async function restoreSavedPsbtRows(
  rows: any[] | undefined,
  restoreMode: SavedPsbtRestoreMode,
  options?: SavedPsbtWriteOptions,
): Promise<number> {
  if (!rows || rows.length === 0) return 0;

  const seen = new Set<string>();
  if (restoreMode === 'merge') {
    const existing = await db.savedPsbts.toArray();
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
      outputs: Array.isArray(d.outputs) ? d.outputs : [],
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : now,
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : now,
    });
  }

  if (toAdd.length > 0) {
    await db.savedPsbts.bulkAdd(toAdd);
    if (!options?.skipNotification) {
      notifyDbChange('savedPsbts');
    }
  }
  return toAdd.length;
}
