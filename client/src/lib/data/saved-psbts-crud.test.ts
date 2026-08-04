import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  savePsbt,
  getAllSavedPsbts,
  renameSavedPsbt,
  deleteSavedPsbt,
  clearSavedPsbts,
  restoreSavedPsbtRows,
} from './saved-psbts-crud';
import type { NewSavedPsbt } from './saved-psbts-crud';

const BASE64_A = 'cHNidP8BAAoCAAAAAQE=';
const BASE64_B = 'cHNidP8BAAoCAAAAAQI=';

function makePsbt(overrides: Partial<NewSavedPsbt> = {}): NewSavedPsbt {
  return {
    name: 'Test PSBT',
    psbtBase64: BASE64_A,
    destinationAddress: 'bc1qdest',
    feeRateSatsPerVb: 2,
    feeSats: 282,
    estimatedVbytes: 141,
    totalInputSats: 100_000,
    sendAmountSats: 99_718,
    changeSats: 0,
    inputs: [
      {
        txid: 'a'.repeat(64),
        vout: 0,
        address: 'bc1qinput',
        amountSats: 100_000,
        scriptType: 'P2WPKH',
      },
    ],
    outputs: [{ address: 'bc1qdest', amountSats: 99_718, isChange: false }],
    ...overrides,
  };
}

beforeEach(async () => {
  await clearSavedPsbts();
});

describe('saved-psbts-crud', () => {
  it('saves a PSBT and lists it newest-first', async () => {
    const id1 = await savePsbt(makePsbt({ name: 'First' }));
    // Ensure a different createdAt ordering key.
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await savePsbt(makePsbt({ name: 'Second', psbtBase64: BASE64_B }));
    expect(id1).not.toBe(id2);

    const all = await getAllSavedPsbts();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe('Second');
    expect(all[1].name).toBe('First');
    expect(all[1].inputs[0].scriptType).toBe('P2WPKH');
    expect(all[1].createdAt).toBeGreaterThan(0);
  });

  it('falls back to a default name for blank names', async () => {
    await savePsbt(makePsbt({ name: '   ' }));
    const all = await getAllSavedPsbts();
    expect(all[0].name).toBe('Untitled PSBT');
  });

  it('renames a saved PSBT', async () => {
    const id = await savePsbt(makePsbt());
    await renameSavedPsbt(id, 'Renamed');
    const all = await getAllSavedPsbts();
    expect(all[0].name).toBe('Renamed');
    expect(all[0].updatedAt).toBeGreaterThanOrEqual(all[0].createdAt);
  });

  it('deletes a saved PSBT', async () => {
    const id = await savePsbt(makePsbt());
    await deleteSavedPsbt(id);
    expect(await getAllSavedPsbts()).toHaveLength(0);
  });

  it('restores rows in replace mode with fresh ids', async () => {
    const written = await restoreSavedPsbtRows(
      [
        { id: 99, ...makePsbt({ name: 'From backup' }) },
        { id: 100, ...makePsbt({ name: 'Second', psbtBase64: BASE64_B }) },
      ],
      'replace',
    );
    expect(written).toBe(2);
    const all = await getAllSavedPsbts();
    // Fresh autoincrement ids, not the backup ids.
    expect(all.map((p) => p.id)).not.toContain(99);
    expect(all.map((p) => p.id)).not.toContain(100);
  });

  it('skips duplicates and unusable rows in merge mode', async () => {
    await savePsbt(makePsbt({ name: 'Existing' }));
    const written = await restoreSavedPsbtRows(
      [
        makePsbt({ name: 'Same bytes' }), // duplicate psbtBase64 -> skipped
        makePsbt({ name: 'New bytes', psbtBase64: BASE64_B }),
        { name: 'No bytes' }, // missing psbtBase64 -> skipped
        'garbage',
      ],
      'merge',
    );
    expect(written).toBe(1);
    const all = await getAllSavedPsbts();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.name).sort()).toEqual(['Existing', 'New bytes']);
  });

  it('restore with no rows is a no-op', async () => {
    expect(await restoreSavedPsbtRows(undefined, 'replace')).toBe(0);
    expect(await restoreSavedPsbtRows([], 'merge')).toBe(0);
  });

  it('persists and restores an OP_RETURN data output with its evidence reference', async () => {
    const dataOutput = {
      payloadHex: '9f4b2c7aa1e3d05f6b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c',
      isNotarization: true,
      evidenceId: 7,
      evidenceAttachmentId: 42,
      evidenceTitle: 'Purchase agreement',
      evidenceFilename: 'agreement.pdf',
    };
    const withData = makePsbt({
      outputs: [
        { address: 'bc1qdest', amountSats: 99_718, isChange: false },
        { address: 'OP_RETURN', amountSats: 0, isChange: false, dataOutput },
      ],
    });

    await savePsbt(withData);
    const saved = await getAllSavedPsbts();
    expect(saved[0].outputs[1]).toEqual({
      address: 'OP_RETURN',
      amountSats: 0,
      isChange: false,
      dataOutput,
    });

    // Restore (replace) preserves the data output verbatim.
    await clearSavedPsbts();
    const written = await restoreSavedPsbtRows([withData], 'replace');
    expect(written).toBe(1);
    const restored = await getAllSavedPsbts();
    expect(restored[0].outputs[1].dataOutput).toEqual(dataOutput);
  });

  it('remaps evidence references on restore and drops references whose target is gone', async () => {
    // Evidence ids change on restore (clear() never resets key generation), so
    // a notarization reference restored verbatim would dangle — or point at an
    // unrelated row. The restore must rewrite it through the evidence restore's
    // id maps.
    const withRefs = makePsbt({
      outputs: [
        {
          address: 'OP_RETURN',
          amountSats: 0,
          isChange: false,
          dataOutput: {
            payloadHex: 'ab'.repeat(32),
            isNotarization: true,
            evidenceId: 7,
            evidenceAttachmentId: 42,
            evidenceTitle: 'Agreement',
            evidenceFilename: 'agreement.pdf',
          },
        },
      ],
    });
    const remap = {
      evidenceIdMap: new Map([[7, 101]]),
      evidenceAttachmentIdMap: new Map([[42, 202]]),
    };
    await restoreSavedPsbtRows([withRefs], 'replace', undefined, undefined, remap);
    let rows = await getAllSavedPsbts();
    expect(rows[0].outputs[0].dataOutput).toEqual({
      payloadHex: 'ab'.repeat(32),
      isNotarization: true,
      evidenceId: 101,
      evidenceAttachmentId: 202,
      evidenceTitle: 'Agreement',
      evidenceFilename: 'agreement.pdf',
    });

    // A reference whose target the restore did not carry is DROPPED, never left
    // dangling (a stale numeric id could collide with an unrelated live row).
    await clearSavedPsbts();
    await restoreSavedPsbtRows(
      [withRefs],
      'replace',
      undefined,
      undefined,
      { evidenceIdMap: new Map(), evidenceAttachmentIdMap: new Map() },
    );
    rows = await getAllSavedPsbts();
    expect(rows[0].outputs[0].dataOutput).toEqual({
      payloadHex: 'ab'.repeat(32),
      isNotarization: true,
      evidenceId: undefined,
      evidenceAttachmentId: undefined,
      evidenceTitle: 'Agreement',
      evidenceFilename: 'agreement.pdf',
    });
  });
});
