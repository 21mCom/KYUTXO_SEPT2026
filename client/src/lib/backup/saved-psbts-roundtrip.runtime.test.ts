// @vitest-environment jsdom
//
// Round-trip regression guard for the `savedPsbts` table (unsigned PSBTs from
// the watch-only builder, Dexie v37). Unit coverage exists for
// `restoreSavedPsbtRows`, but this file proves the FULL pipeline — a real v3
// backup zip produced by `exportBackup` fed back through `restoreV3Backup` —
// actually carries saved PSBTs across a wipe:
//   1. REPLACE mode: 2 saved PSBTs survive export -> vault wipe -> restore with
//      every persisted field intact (base64 bytes, name, inputs/outputs, fees),
//      compared by deep equality (ids excluded; restore assigns fresh ones).
//   2. MERGE mode: restoring the SAME backup's inline data over a vault that
//      already contains those PSBTs (plus one extra local PSBT) dedupes by
//      psbtBase64 — nothing doubles and the local-only PSBT survives.
//
// The merge scenario drives the REAL zip bytes through `restoreV3Backup` with
// the real `restoreMode: "merge"` option (merge never clears; inline tables
// restore via `restoreInlineTables(data, "merge")`), so the parsed
// inline payload is exactly what the exporter wrote into the archive.
//
// The backup is UNENCRYPTED so no WebCrypto subtle support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db, type SavedPsbt } from "@/lib/database";
import { exportBackup, type AttachmentFileIO } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";

import { clearAllRecords } from "@/lib/data/record-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import {
  clearParticipants,
  clearTransactions,
} from "@/lib/data/transaction-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import {
  clearUtxoLineage,
  clearCustodySegments,
} from "@/lib/data/lineage-crud";
import { clearNodeSettings } from "@/lib/data/node-settings-crud";
import {
  savePsbt,
  getAllSavedPsbts,
  clearSavedPsbts,
  type NewSavedPsbt,
} from "@/lib/data/saved-psbts-crud";

// No attachment files in this test; the export just sees an empty store.
const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [];
  },
  async read() {
    return null;
  },
};
const attachmentWriter: AttachmentFileWriter = {
  async write() {},
};

// ---- fully-populated seed PSBTs (every optional + required field set) -------

const PSBT_A: NewSavedPsbt = {
  name: "Cold storage sweep",
  psbtBase64: "cHNidP8BAHECAAAAAdaKZW4tR0FBTUEA",
  destinationAddress: "bc1qdesta000000000000000000000000000000000",
  changeAddress: "bc1qchangea00000000000000000000000000000000",
  feeRateSatsPerVb: 12.5,
  feeSats: 1_763,
  estimatedVbytes: 141,
  totalInputSats: 250_000,
  sendAmountSats: 200_000,
  changeSats: 48_237,
  inputs: [
    {
      txid: "a".repeat(64),
      vout: 0,
      address: "bc1qinputa000000000000000000000000000000000",
      amountSats: 150_000,
      scriptType: "P2WPKH",
      derivationPath: "m/84'/0'/0'/0/5",
      hasDerivationInfo: true,
      hasScript: false,
    },
    {
      txid: "b".repeat(64),
      vout: 2,
      address: "bc1qinputa200000000000000000000000000000000",
      amountSats: 100_000,
      scriptType: "P2SH-P2WSH",
      hasScript: true,
    },
  ],
  outputs: [
    {
      address: "bc1qdesta000000000000000000000000000000000",
      amountSats: 200_000,
      isChange: false,
    },
    {
      address: "bc1qchangea00000000000000000000000000000000",
      amountSats: 48_237,
      isChange: true,
    },
  ],
};

const PSBT_B: NewSavedPsbt = {
  name: "Exchange withdrawal consolidation",
  psbtBase64: "cHNidP8BAHECAAAAAdaKZW4tR0ZaZkIA",
  destinationAddress: "bc1qdestb000000000000000000000000000000000",
  // No changeAddress / no change output.
  feeRateSatsPerVb: 3,
  feeSats: 330,
  estimatedVbytes: 110,
  totalInputSats: 75_000,
  sendAmountSats: 74_670,
  changeSats: 0,
  inputs: [
    {
      txid: "c".repeat(64),
      vout: 1,
      address: "bc1qinputb000000000000000000000000000000000",
      amountSats: 75_000,
      scriptType: "P2TR",
    },
  ],
  outputs: [
    {
      address: "bc1qdestb000000000000000000000000000000000",
      amountSats: 74_670,
      isChange: false,
    },
  ],
};

// A PSBT that exists ONLY in the live vault (never exported) so the merge test
// can prove local-only rows survive a merge restore.
const PSBT_LOCAL_ONLY: NewSavedPsbt = {
  ...PSBT_B,
  name: "Local only",
  psbtBase64: "cHNidP8BAHECAAAAAdaKZW4tTE9DQUwA",
};

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await clearUtxoLineage({ skipNotification: true });
  await clearCustodySegments({ skipNotification: true });
  await clearNodeSettings({ skipNotification: true });
  await clearSavedPsbts({ skipNotification: true });
  await db.tags.clear();
  await db.categories.clear();
  await db.owners.clear();
  await db.walletNames.clear();
  await db.seedNames.clear();
  await db.walletSoftware.clear();
}

async function exportToBlob(): Promise<Blob> {
  const sink = new MemorySink();
  await exportBackup({
    sink: sink as BackupSink,
    encrypted: false,
    batchSize: 25,
    attachmentIO,
  });
  const blob = sink.blob as Blob;
  expect(blob).toBeInstanceOf(Blob);
  return blob;
}

// Persisted-field view for order/id-independent deep equality. createdAt and
// updatedAt are stamped by savePsbt (and preserved by restore), so they are
// compared against the live pre-export rows rather than the seed literals.
function stripId(rows: SavedPsbt[]): Omit<SavedPsbt, "id">[] {
  return rows.map(({ id, ...rest }) => rest);
}
function sortByBase64<T extends { psbtBase64: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.psbtBase64.localeCompare(b.psbtBase64));
}

describe("saved PSBTs backup round-trip", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("replace restore carries both saved PSBTs across a real backup zip with every field intact", async () => {
    await savePsbt(PSBT_A);
    await savePsbt(PSBT_B);
    const beforeExport = sortByBase64(stripId(await getAllSavedPsbts()));

    const blob = await exportToBlob();

    // Wipe the table (restore also clears, but prove the rows can ONLY have
    // come from the backup).
    await clearSavedPsbts({ skipNotification: true });
    expect(await getAllSavedPsbts()).toHaveLength(0);

    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
    });

    const restored = sortByBase64(stripId(await getAllSavedPsbts()));
    expect(restored).toHaveLength(2);
    expect(restored).toEqual(beforeExport);

    // Spot-check the fields a user would lose silently if restore coerced them.
    const a = restored.find((p) => p.psbtBase64 === PSBT_A.psbtBase64)!;
    expect(a.name).toBe("Cold storage sweep");
    expect(a.inputs).toHaveLength(2);
    expect(a.inputs[0].derivationPath).toBe("m/84'/0'/0'/0/5");
    expect(a.inputs[1].hasScript).toBe(true);
    expect(a.outputs[1].isChange).toBe(true);
    expect(a.feeSats).toBe(1_763);
    expect(a.feeRateSatsPerVb).toBe(12.5);
    const b = restored.find((p) => p.psbtBase64 === PSBT_B.psbtBase64)!;
    expect(b.changeAddress).toBeUndefined();
    expect(b.changeSats).toBe(0);
    expect(b.totalInputSats).toBe(75_000);
  });

  it("merge restore of the same backup dedupes by psbtBase64 and keeps local-only PSBTs", async () => {
    await savePsbt(PSBT_A);
    await savePsbt(PSBT_B);
    const blob = await exportToBlob();

    // The vault still holds both exported PSBTs; add one that was never
    // exported. A correct merge keeps all three and adds nothing.
    await savePsbt(PSBT_LOCAL_ONLY);
    const beforeMerge = sortByBase64(stripId(await getAllSavedPsbts()));
    expect(beforeMerge).toHaveLength(3);

    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      // Real merge mode: never clears, restores inline tables in merge mode.
      restoreMode: "merge",
    });

    const afterMerge = sortByBase64(stripId(await getAllSavedPsbts()));
    expect(afterMerge).toEqual(beforeMerge);
    expect(afterMerge.map((p) => p.name).sort()).toEqual([
      "Cold storage sweep",
      "Exchange withdrawal consolidation",
      "Local only",
    ]);

    // Merging the identical backup a second time is still a no-op.
    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
    });
    expect(sortByBase64(stripId(await getAllSavedPsbts()))).toEqual(beforeMerge);
  });
});
