// @vitest-environment jsdom
//
// Runtime SCALE GUARD for the v3 streaming backup pipeline. Proves that a full
// export -> restore round-trip:
//   1. never materialises a whole big table into memory (each Dexie `toArray`
//      pulls at most one page), and
//   2. round-trips the data correctly (counts + attachment file bytes survive).
//
// Unlike scale-guards.runtime.test.ts (which mocks a minimal 4-table db), this
// test drives the REAL `@/lib/database` schema over fake-indexeddb so the export
// orchestrator, the inline-table reader/writer, and every CRUD bulk path are all
// exercised end to end. The backup is UNENCRYPTED so the test needs no
// WebCrypto subtle support.
//
// Instrumentation: after seeding we wrap Dexie's Table/Collection `toArray` and
// track the LARGEST single call. A bounded pipeline keeps that max <= the batch
// size; a "load the whole table then slice" regression would blow past it. The
// big tables are seeded far larger than the batch, and the small inline tables
// far smaller, so "max single toArray <= batch" cleanly isolates a whole-table
// load.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Dexie from "dexie";

import { db } from "@/lib/database";
import { exportBackup } from "./export";
import { restoreV3Backup, type AttachmentFileWriter } from "./restore";
import { MemorySink, type BackupSink } from "./sink";
import { blobChunks } from "./zip-stream";
import { type AttachmentFileIO } from "./export";

import {
  bulkCreateRecords,
  clearAllRecords,
  countRecords,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  bulkAddAttachments,
  clearAttachments,
  countAttachments,
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";
import {
  bulkAddParticipants,
  bulkAddTransactions,
  clearParticipants,
  clearTransactions,
  countTransactions,
  countTransactionParticipants,
  type CreateTransactionData,
} from "@/lib/data/transaction-crud";
import {
  bulkAddAddressSyncState,
  clearAddressSyncState,
  countAddressSyncState,
  type CreateAddressSyncStateData,
} from "@/lib/data/address-sync-crud";
import {
  bulkAddUtxoLineage,
  bulkAddCustodySegments,
  clearUtxoLineage,
  clearCustodySegments,
  countUtxoLineage,
  countCustodySegments,
} from "@/lib/data/lineage-crud";
import { restoreTag } from "@/lib/data/vocabulary-crud";
import {
  getAllOwnershipReviewDecisions,
  restoreOwnershipReviewDecision,
} from "@/lib/data/ownership-review-decisions-crud";
import type {
  TransactionParticipant,
  UtxoLineage,
  CustodySegment,
} from "@/lib/database";

// Big tables >> BATCH, inline tables << BATCH, so "max single toArray <= BATCH"
// means no whole big table was ever pulled into memory.
const N_REC = 120;
const N_TX = 200;
const N_PART = 200;
const N_ATT = 150;
const N_SYNC = 80;
const N_LINEAGE = 140;
const N_SEGMENTS = 90;
const N_TAGS = 4;
const N_FILES = 5;
const BATCH = 25;

// ---- toArray instrumentation ----------------------------------------------

let maxToArray = 0;
let tableProto: any;
let collProto: any;
let origTableToArray: any;
let origCollToArray: any;

function resetMax(): void {
  maxToArray = 0;
}

// In-memory attachment store standing in for the file system. listAll/read feed
// the export; write() captures what restore lays back down so we can diff bytes.
const sourceFiles = new Map<string, Uint8Array>();
const restoredFiles = new Map<string, Uint8Array>();

const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [...sourceFiles.keys()];
  },
  async read(relPath) {
    const v = sourceFiles.get(relPath);
    return v ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : null;
  },
};

const attachmentWriter: AttachmentFileWriter = {
  async write(relPath, data) {
    restoredFiles.set(relPath, new Uint8Array(data));
  },
};

beforeAll(async () => {
  // Start from a known-clean slate (a fresh fake-indexeddb may seed defaults).
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await clearUtxoLineage({ skipNotification: true });
  await clearCustodySegments({ skipNotification: true });
  await db.tags.clear();

  // Records first so we can hang dependents off their real ids.
  const recRows: CreateRecordData[] = [];
  for (let i = 1; i <= N_REC; i++) {
    const inputString = `addr-${String(i).padStart(5, "0")}`;
    recRows.push({
      type: "address",
      inputString,
      inputStringLower: inputString,
      label: `r${i}`,
      tags: [],
      categories: [],
      addressImportance: "manual",
    } as unknown as CreateRecordData);
  }
  const recordIds = await bulkCreateRecords(recRows, {
    skipNotification: true,
    skipVocabularySync: true,
  });

  const txRows: CreateTransactionData[] = [];
  for (let i = 0; i < N_TX; i++) {
    txRows.push({
      txid: i.toString(16).padStart(64, "0"),
      blockHeight: Math.floor(i / 3),
      blockTime: 1_231_006_505 + i * 600,
      syncedAt: 1,
      hasOpReturn: false,
    } as unknown as CreateTransactionData);
  }
  await bulkAddTransactions(txRows, { skipNotification: true });

  const partRows: TransactionParticipant[] = [];
  for (let i = 0; i < N_PART; i++) {
    partRows.push({
      txid: (i % N_TX).toString(16).padStart(64, "0"),
      role: i % 2 === 0 ? "input" : "output",
      address: `addr-${String((i % N_REC) + 1).padStart(5, "0")}`,
      recordId: recordIds[i % N_REC],
    } as unknown as TransactionParticipant);
  }
  await bulkAddParticipants(partRows, { skipNotification: true });

  const attRows: CreateAttachmentData[] = [];
  for (let i = 0; i < N_ATT; i++) {
    attRows.push({
      recordId: recordIds[i % N_REC],
      filename: `doc-${i}.pdf`,
      mimeType: "application/pdf",
      size: 1024,
      objectStoragePath: `ab/cd/${i}.pdf`,
    } as unknown as CreateAttachmentData);
  }
  await bulkAddAttachments(attRows, { skipNotification: true });

  const syncRows: CreateAddressSyncStateData[] = [];
  for (let i = 0; i < N_SYNC; i++) {
    syncRows.push({
      address: `addr-${String((i % N_REC) + 1).padStart(5, "0")}`,
      recordId: recordIds[i % N_REC],
      lastSyncedHeight: 100 + i,
      lastSyncedAt: 1000 + i,
      txCount: i,
    } as unknown as CreateAddressSyncStateData);
  }
  await bulkAddAddressSyncState(syncRows, { skipNotification: true });

  // Lineage tables carry no recordId — they relink by txid/vout, so they stream
  // as-is like blockchainTransactions.
  const lineageRows: UtxoLineage[] = [];
  for (let i = 0; i < N_LINEAGE; i++) {
    lineageRows.push({
      spentTxid: (i % N_TX).toString(16).padStart(64, "0"),
      spentVout: i % 4,
      spentAddress: `addr-${String((i % N_REC) + 1).padStart(5, "0")}`,
      spentAmount: 1000 + i,
      consumingTxid: ((i + 1) % N_TX).toString(16).padStart(64, "0"),
      createdTxid: ((i + 1) % N_TX).toString(16).padStart(64, "0"),
      createdVout: (i + 1) % 4,
      createdAddress: `addr-${String(((i + 1) % N_REC) + 1).padStart(5, "0")}`,
      createdAmount: 900 + i,
      spentOwned: i % 2 === 0,
      createdOwned: i % 3 === 0,
      isChange: i % 5 === 0,
      confidence: "high",
      blockTime: 1_231_006_505 + i * 600,
      blockHeight: Math.floor(i / 3),
      createdAt: 1000 + i,
    } as unknown as UtxoLineage);
  }
  await bulkAddUtxoLineage(lineageRows, { skipNotification: true });

  const segmentRows: CustodySegment[] = [];
  for (let i = 0; i < N_SEGMENTS; i++) {
    segmentRows.push({
      segmentId: `seg-${String(i).padStart(6, "0")}`,
      originTxid: (i % N_TX).toString(16).padStart(64, "0"),
      originVout: i % 4,
      originAddress: `addr-${String((i % N_REC) + 1).padStart(5, "0")}`,
      originDate: 1_231_006_505 + i * 600,
      originAmount: 5000 + i,
      currentAmount: 5000 + i,
      status: "active",
      hopCount: i % 3,
      evidenceTxids: [(i % N_TX).toString(16).padStart(64, "0")],
      createdAt: 1000 + i,
      updatedAt: 1000 + i,
    } as unknown as CustodySegment);
  }
  await bulkAddCustodySegments(segmentRows, { skipNotification: true });

  for (let i = 0; i < N_TAGS; i++) {
    await restoreTag({ name: `tag-${i}`, color: "#888888", createdAt: 1000 + i });
  }

  // v44 normalized projection rows are small inline tables, but their foreign
  // keys must still survive the records' fresh-id restore remap.
  const entityId = await db.entities.add({
    naturalKey: "person:roundtrip owner", name: "Roundtrip Owner", kind: "person",
    createdAt: 1, updatedAt: 1,
  });
  const walletId = await db.wallets.add({
    naturalKey: "roundtrip wallet|1||", name: "Roundtrip Wallet", entityId,
    createdAt: 1, updatedAt: 1,
  });
  const counterpartyId = await db.entities.add({
    naturalKey: "counterparty:roundtrip payer", name: "Roundtrip Payer", kind: "counterparty",
    createdAt: 1, updatedAt: 1,
  });
  await db.addressOwnership.add({
    recordId: recordIds[0], state: "assigned", entityId, walletId,
    counterpartyEntityId: counterpartyId, confidence: "manual", createdAt: 1, updatedAt: 1,
  });
  const normalizedTxid = "0".repeat(64);
  await db.transactionMetadata.add({
    txid: normalizedTxid, flowType: "received", categories: ["Income"], counterpartyEntityId: counterpartyId,
    createdAt: 1, updatedAt: 1,
  });
  await db.transactionLegMetadata.add({
    txid: normalizedTxid, legKey: "output:0", direction: "incoming", entityId, walletId,
    categories: ["Income"], hasFlowOverride: true, createdAt: 1, updatedAt: 1,
  });
  // A rejection is durable user evidence even though it changes no ownership
  // row. Its record id must be remapped through the streamed records restore.
  await restoreOwnershipReviewDecision({
    id: "ownership-v1:rejected-roundtrip",
    evidenceFingerprint: "ownership-v1:rejected-roundtrip",
    state: "rejected",
    action: "reject",
    recordIds: [recordIds[0]],
    createdAt: 1,
    updatedAt: 2,
  });

  for (let i = 0; i < N_FILES; i++) {
    sourceFiles.set(`ab/cd/file-${i}.bin`, new Uint8Array([i, i + 1, i + 2, 0xff]));
  }

  // Patch AFTER seeding so the bulk inserts don't pollute the counter. Both
  // prototypes are shared across all tables/collections of this Dexie instance.
  tableProto = Object.getPrototypeOf(db.records);
  collProto = Object.getPrototypeOf(db.records.toCollection());
  origTableToArray = tableProto.toArray;
  origCollToArray = collProto.toArray;
  tableProto.toArray = async function (...args: any[]) {
    const r = await origTableToArray.apply(this, args);
    if (Array.isArray(r)) maxToArray = Math.max(maxToArray, r.length);
    return r;
  };
  collProto.toArray = async function (...args: any[]) {
    const r = await origCollToArray.apply(this, args);
    if (Array.isArray(r)) maxToArray = Math.max(maxToArray, r.length);
    return r;
  };
});

afterAll(() => {
  if (tableProto) tableProto.toArray = origTableToArray;
  if (collProto) collProto.toArray = origCollToArray;
});

// Shared between the two ordered tests below.
const memorySink: MemorySink = new MemorySink();

describe("v3 backup export stays bounded", () => {
  it("never materialises a whole big table while exporting", async () => {
    resetMax();
    await exportBackup({
      sink: memorySink as BackupSink,
      encrypted: false,
      batchSize: BATCH,
      attachmentIO,
    });

    expect(memorySink.blob).toBeInstanceOf(Blob);
    expect((memorySink.blob as Blob).size).toBeGreaterThan(0);
    // The largest single toArray pulled at most one page — proof that no big
    // table was loaded whole. Big tables are >> BATCH, inline tables << BATCH.
    expect(maxToArray).toBeLessThanOrEqual(BATCH);
    expect(maxToArray).toBeLessThan(N_REC);
  });

  it("enumerates attachment filenames in bounded pages with exact progress/counts", async () => {
    const fileCount = BATCH * 3 + 7;
    let largestPageRequested = 0;
    let pageCalls = 0;
    const phases: string[] = [];
    const sink = new MemorySink();

    await exportBackup({
      sink,
      encrypted: false,
      batchSize: BATCH,
      attachmentIO: {
        async listPage(offset, limit) {
          largestPageRequested = Math.max(largestPageRequested, limit);
          pageCalls += 1;
          const length = Math.max(0, Math.min(limit, fileCount - offset));
          return {
            files: Array.from({ length }, (_, index) => `paged/file-${offset + index}.bin`),
            total: fileCount,
          };
        },
        async read() {
          return null;
        },
      },
      onProgress: ({ phase }) => phases.push(phase),
    });

    expect(largestPageRequested).toBe(BATCH);
    expect(pageCalls).toBe(4);
    expect(phases).toContain(`Exporting attachment ${fileCount} of ${fileCount}...`);

    const restored = await restoreV3Backup({
      source: blobChunks(sink.blob as Blob),
      attachmentWriter: { async write() {} },
    });
    expect(restored.manifest.counts.attachmentFiles).toBe(fileCount);
  });
});

describe("v3 backup restore stays bounded and round-trips", () => {
  it("restores every table + attachment bytes without loading a whole table", async () => {
    const blob = memorySink.blob as Blob;
    expect(blob).toBeInstanceOf(Blob);
    // This local-only decision must disappear during a replace restore, proving
    // inline replace clears stale review evidence rather than appending it.
    await restoreOwnershipReviewDecision({
      id: "ownership-v1:stale",
      evidenceFingerprint: "ownership-v1:stale",
      state: "rejected",
      action: "reject",
      recordIds: [1],
      createdAt: 3,
      updatedAt: 3,
    });

    resetMax();
    const result = await restoreV3Backup({
      source: blobChunks(blob),
      attachmentWriter,
    });

    // Restore reads NDJSON line-by-line and bulk-writes; it must never pull a
    // whole big table into memory either.
    expect(maxToArray).toBeLessThanOrEqual(BATCH);
    expect(maxToArray).toBeLessThan(N_REC);

    // Reported counts match what we seeded.
    expect(result.counts.records).toBe(N_REC);
    expect(result.counts.blockchainTransactions).toBe(N_TX);
    expect(result.counts.transactionParticipants).toBe(N_PART);
    expect(result.counts.attachments).toBe(N_ATT);
    expect(result.counts.addressSyncState).toBe(N_SYNC);
    expect(result.counts.utxoLineage).toBe(N_LINEAGE);
    expect(result.counts.custodySegments).toBe(N_SEGMENTS);
    expect(result.counts.attachmentFiles).toBe(N_FILES);

    // The live tables actually hold the restored rows.
    expect(await countRecords()).toBe(N_REC);
    expect(await countTransactions()).toBe(N_TX);
    expect(await countTransactionParticipants()).toBe(N_PART);
    expect(await countAttachments()).toBe(N_ATT);
    expect(await countAddressSyncState()).toBe(N_SYNC);
    expect(await countUtxoLineage()).toBe(N_LINEAGE);
    expect(await countCustodySegments()).toBe(N_SEGMENTS);
    expect(await db.tags.count()).toBe(N_TAGS);
    expect(await db.entities.count()).toBe(2);
    expect(await db.wallets.count()).toBe(1);
    expect(await db.addressOwnership.count()).toBe(1);
    expect(await db.transactionMetadata.count()).toBe(1);
    expect(await db.transactionLegMetadata.count()).toBe(1);
    const decisions = await getAllOwnershipReviewDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: "ownership-v1:rejected-roundtrip",
      state: "rejected",
      action: "reject",
      recordIds: [expect.any(Number)],
    });
    const ownership = await db.addressOwnership.toCollection().first();
    const wallet = await db.wallets.toCollection().first();
    const leg = await db.transactionLegMetadata.toCollection().first();
    expect(ownership?.recordId).toBeGreaterThan(0);
    expect(ownership?.entityId).toBe(wallet?.entityId);
    expect(ownership?.walletId).toBe(wallet?.id);
    expect(leg?.entityId).toBe(wallet?.entityId);
    expect(leg?.walletId).toBe(wallet?.id);
    const restoredCounterparty = await db.entities.where("naturalKey").equals("counterparty:roundtrip payer").first();
    expect((await db.transactionMetadata.toCollection().first())?.counterpartyEntityId).toBe(restoredCounterparty?.id);

    // Attachment file bytes survived the round-trip exactly.
    expect(restoredFiles.size).toBe(N_FILES);
    for (const [path, bytes] of sourceFiles) {
      expect([...(restoredFiles.get(path) ?? [])]).toEqual([...bytes]);
    }
  });
});
