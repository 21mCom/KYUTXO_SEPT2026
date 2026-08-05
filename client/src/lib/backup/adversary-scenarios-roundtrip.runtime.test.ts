// @vitest-environment jsdom
//
// Round-trip regression guard for the `adversaryScenarios` table (Privacy
// Audit "what if they knew?" scenarios, Dexie v39). Proves the FULL pipeline —
// a real v3 backup zip produced by `exportBackup` fed back through
// `restoreV3Backup` — carries scenarios across a wipe:
//   1. REPLACE mode: 2 scenarios survive export -> vault wipe -> restore with
//      every persisted field intact (ids excluded; restore assigns fresh ones).
//   2. MERGE mode: restoring the SAME backup's inline data over a vault that
//      already contains a scenario with the same (name, counterparty)
//      identity dedupes — nothing doubles and the local-only scenario
//      survives. Merging the identical backup twice is a no-op.
//
// The backup is UNENCRYPTED so no WebCrypto subtle support is required.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db, type AdversaryScenario } from "@/lib/database";
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
  saveAdversaryScenario,
  getAllAdversaryScenarios,
  clearAdversaryScenarios,
  type NewAdversaryScenario,
} from "@/lib/data/adversary-scenarios-crud";

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

const SCENARIO_A: NewAdversaryScenario = {
  name: "Exchange KYC leak",
  counterpartyName: "TestExchange",
  knownAddresses: [
    "bc1qscenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bc1qscenbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ],
  knownTxids: ["a".repeat(64), "b".repeat(64)],
};

const SCENARIO_B: NewAdversaryScenario = {
  name: "Old employer payroll",
  counterpartyName: "ACME Corp",
  knownAddresses: ["bc1qscenccccccccccccccccccccccccccccccccccccc"],
  knownTxids: [],
};

// A scenario that exists ONLY in the live vault (never exported) so the merge
// test can prove local-only rows survive a merge restore.
const SCENARIO_LOCAL_ONLY: NewAdversaryScenario = {
  name: "Merchant refund",
  counterpartyName: "LocalMerchant",
  knownAddresses: ["bc1qscenddddddddddddddddddddddddddddddddddddd"],
  knownTxids: [],
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
  await clearAdversaryScenarios({ skipNotification: true });
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
// updatedAt are stamped by saveAdversaryScenario (and preserved by restore),
// so they are compared against the live pre-export rows.
function stripId(rows: AdversaryScenario[]): Omit<AdversaryScenario, "id">[] {
  return rows.map(({ id, ...rest }) => rest);
}
function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

describe("adversary scenarios backup round-trip", () => {
  beforeEach(async () => {
    await clearEverything();
  });

  it("replace restore carries scenarios across a real backup zip with every field intact", async () => {
    await saveAdversaryScenario(SCENARIO_A);
    await saveAdversaryScenario(SCENARIO_B);
    const beforeExport = sortByName(stripId(await getAllAdversaryScenarios()));

    const blob = await exportToBlob();

    // Wipe the table (restore also clears, but prove the rows can ONLY have
    // come from the backup).
    await clearAdversaryScenarios({ skipNotification: true });
    expect(await getAllAdversaryScenarios()).toHaveLength(0);

    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
    });

    const restored = sortByName(stripId(await getAllAdversaryScenarios()));
    expect(restored).toHaveLength(2);
    expect(restored).toEqual(beforeExport);

    // Spot-check the fields a user would lose silently if restore coerced them.
    const a = restored.find((s) => s.name === SCENARIO_A.name)!;
    expect(a.counterpartyName).toBe("TestExchange");
    expect(a.knownAddresses).toEqual(SCENARIO_A.knownAddresses);
    expect(a.knownTxids).toEqual(SCENARIO_A.knownTxids);
    const b = restored.find((s) => s.name === SCENARIO_B.name)!;
    expect(b.knownTxids).toEqual([]);
  });

  it("merge restore of the same backup dedupes by identity and keeps local-only scenarios", async () => {
    await saveAdversaryScenario(SCENARIO_A);
    await saveAdversaryScenario(SCENARIO_B);
    const blob = await exportToBlob();

    // The vault still holds both exported scenarios; add one that was never
    // exported, and MUTATE one exported scenario locally — a merge must not
    // duplicate or overwrite it.
    await saveAdversaryScenario(SCENARIO_LOCAL_ONLY);
    const beforeMerge = sortByName(stripId(await getAllAdversaryScenarios()));
    expect(beforeMerge).toHaveLength(3);

    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
    });

    const afterMerge = sortByName(stripId(await getAllAdversaryScenarios()));
    expect(afterMerge).toEqual(beforeMerge);
    expect(afterMerge.map((s) => s.name).sort()).toEqual([
      "Exchange KYC leak",
      "Merchant refund",
      "Old employer payroll",
    ]);

    // Merging the identical backup a second time is still a no-op.
    await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
      restoreMode: "merge",
    });
    expect(sortByName(stripId(await getAllAdversaryScenarios()))).toEqual(beforeMerge);
  });
});
