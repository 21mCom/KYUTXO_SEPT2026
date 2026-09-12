// Canonical record identifiers (Task #1861): CRUD boundary + one-time repair.
//
// Covers:
//   - createRecord / updateRecord store inputString in canonical form (trimmed,
//     bech32/txid lowercased) with a matching inputStringLower.
//   - The record-crud lookup helpers match canonically stored rows against
//     padded / differently-cased query keys.
//   - repairCanonicalInputStrings normalizes existing rows, bumps updatedAt
//     (engine-mirror freshness fingerprint), SKIPS rows whose canonical key
//     collides with another record (reported, never merged), and is safe to
//     re-run.
//
// Corrupt rows are seeded via direct table writes (this file is allow-listed
// in check-crud-guards.js) because the CRUD layer itself now canonicalizes —
// the corruption emulates rows written before this change or restored
// verbatim from an old backup.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, type Record as DbRecord } from '../database';
import {
  createRecord,
  updateRecord,
  clearAllRecords,
  findRecordByInputString,
  getRecordsByInputString,
  getRecordsByInputStrings,
  repairCanonicalInputStrings,
} from './record-crud';

const BECH32 = 'bc1qcanonical0000000000000000000000000000001';
const TXID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const BASE58 = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

function seedManual(inputString: string): Promise<number> {
  return createRecord({
    type: 'address',
    inputString,
    label: '',
    notes: '',
    tags: [],
    source: 'manual',
  } as any);
}

// Seed a row exactly the way a pre-canonicalization build (or a verbatim
// restore of an old backup) stored it: inputString verbatim, inputStringLower
// the verbatim lowercase.
async function seedLegacyVerbatim(inputString: string, updatedAt = 1_000_000): Promise<number> {
  const now = Date.now();
  return (await db.records.add({
    type: 'address',
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: '',
    notes: '',
    tags: [],
    categories: [],
    owner: 'Pending Review',
    source: 'manual',
    addressImportance: 'manual',
    createdAt: now,
    updatedAt,
  } as unknown as DbRecord)) as number;
}

describe('CRUD canonical boundary', () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  it('createRecord stores padded uppercase bech32 in canonical form', async () => {
    const id = await seedManual(`  ${BECH32.toUpperCase()}  `);
    const row = await db.records.get(id);
    expect(row?.inputString).toBe(BECH32);
    expect(row?.inputStringLower).toBe(BECH32.toLowerCase());
  });

  it('createRecord stores uppercase-hex txids lowercased but base58 verbatim', async () => {
    const txId = await createRecord({
      type: 'transaction',
      inputString: TXID.toUpperCase(),
      label: '',
      notes: '',
      tags: [],
      source: 'manual',
    } as any);
    expect((await db.records.get(txId))?.inputString).toBe(TXID);

    const base58Id = await seedManual(` ${BASE58} `);
    expect((await db.records.get(base58Id))?.inputString).toBe(BASE58);
  });

  it('updateRecord canonicalizes inputString changes', async () => {
    const id = await seedManual(BECH32);
    await updateRecord(id, { inputString: ` ${TXID.toUpperCase()} ` });
    const row = await db.records.get(id);
    expect(row?.inputString).toBe(TXID);
    expect(row?.inputStringLower).toBe(TXID.toLowerCase());
  });

  it('lookup helpers match canonically stored rows against padded/cased keys', async () => {
    const id = await seedManual(BECH32);
    expect((await findRecordByInputString(`  ${BECH32.toUpperCase()} `))?.id).toBe(id);
    expect((await getRecordsByInputString(BECH32.toUpperCase())).map((r) => r.id)).toEqual([id]);
    expect(
      (await getRecordsByInputStrings([` ${BECH32.toUpperCase()}`, 'bc1qother000000000000000000000000000000009'])).map((r) => r.id),
    ).toEqual([id]);
  });
});

describe('repairCanonicalInputStrings', () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  it('normalizes legacy verbatim rows and re-stamps the search key', async () => {
    const id = await seedLegacyVerbatim(`  ${BECH32.toUpperCase()}  `);
    const result = await repairCanonicalInputStrings();
    expect(result).toMatchObject({ scanned: 1, fixed: 1, skippedCollisions: 0, ok: true });

    const row = await db.records.get(id);
    expect(row?.inputString).toBe(BECH32);
    expect(row?.inputStringLower).toBe(BECH32.toLowerCase());
    // updatedAt must move so the engine mirror's freshness fingerprint
    // (count, maxId, maxUpdatedAt) observes the repair.
    expect(row?.updatedAt).toBeGreaterThan(1_000_000);
  });

  it('skips rows whose canonical key collides with another record — never merges', async () => {
    const canonicalId = await seedLegacyVerbatim(BECH32);
    const paddedId = await seedLegacyVerbatim(`  ${BECH32.toUpperCase()}  `);

    const result = await repairCanonicalInputStrings();
    expect(result).toMatchObject({ scanned: 2, fixed: 0, skippedCollisions: 1, ok: true });

    // Both rows left exactly as they were: the collision is reported, not merged.
    expect((await db.records.get(canonicalId))?.inputString).toBe(BECH32);
    expect((await db.records.get(paddedId))?.inputString).toBe(`  ${BECH32.toUpperCase()}  `);
  });

  it('is re-runnable: a second pass is a no-op', async () => {
    await seedLegacyVerbatim(` ${BECH32.toUpperCase()} `);
    await seedLegacyVerbatim(` ${TXID.toUpperCase()} `);

    const first = await repairCanonicalInputStrings();
    expect(first).toMatchObject({ fixed: 2, skippedCollisions: 0, ok: true });

    const second = await repairCanonicalInputStrings();
    expect(second).toMatchObject({ scanned: 2, fixed: 0, skippedCollisions: 0, ok: true });
  });

  it('leaves canonical rows untouched (no updatedAt churn)', async () => {
    const id = await seedLegacyVerbatim(BECH32);
    const result = await repairCanonicalInputStrings();
    expect(result).toMatchObject({ scanned: 1, fixed: 0, skippedCollisions: 0, ok: true });
    expect((await db.records.get(id))?.updatedAt).toBe(1_000_000);
  });
});
