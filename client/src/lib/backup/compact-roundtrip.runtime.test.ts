// @vitest-environment jsdom
//
// Runtime round-trip verification for the COMPACT backup option (task: skip
// bare discovered records). Drives the REAL export -> zip -> restore pipeline
// over the REAL `@/lib/database` schema on fake-indexeddb, twice per fixture —
// once full, once compact — and proves:
//
//   1. the compact plan classifies exactly the right rows (bare discovered
//      records drop; metadata-bearing / attachment-linked / origin-linked /
//      blacklisted records keep; discovery-only txs drop; anchored txs keep),
//   2. the manifest carries the compact marker + FILTERED counts that match
//      the rows actually restored,
//   3. every user-touched row survives byte-for-byte (compared against the
//      original seeded vault),
//   4. restore rebuilds blockchain-discovered shells for every pruned address
//      still referenced by kept participant rows — zero dangling recordIds —
//      and the OWNED transaction history (the inputs to balance / spent /
//      Sent detection) is IDENTICAL to a full-backup restore,
//   5. merge mode reuses existing address records instead of creating shells,
//      merge-cancel removes rebuilt shells (undo log), and a wrong-password
//      restore is rejected non-destructively.
//
// On (4): balances, spent/UTXO status, and Sent detection are pure functions
// of records + blockchainTransactions + transactionParticipants (+ lineage)
// for the OWNED (kept) addresses. The test asserts those row sets are
// identical (modulo auto-increment ids) between the full-restore and the
// compact-restore vaults, which implies every derived balance/spent/Sent
// result is identical too — without booting the whole engine in this harness.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll } from "vitest";

import { exportBackup, type AttachmentFileIO } from "./export";
import {
  restoreV3Backup,
  type AttachmentFileWriter,
  type RestoreResult,
} from "./restore";
import { BackupCancelledError, MemorySink } from "./sink";
import { blobChunks } from "./zip-stream";
import { computeCompactPlan, type CompactPlan } from "./compact";

import {
  bulkCreateRecords,
  clearAllRecords,
  getAllRecords,
  type CreateRecordData,
} from "@/lib/data/record-crud";
import {
  bulkAddAttachments,
  clearAttachments,
  getAllAttachments,
  type CreateAttachmentData,
} from "@/lib/data/attachments-crud";
import {
  bulkAddParticipants,
  bulkAddTransactions,
  clearParticipants,
  clearTransactions,
  getAllTransactions,
  getAllTransactionParticipants,
} from "@/lib/data/transaction-crud";
import {
  bulkAddAddressSyncState,
  clearAddressSyncState,
  getAllAddressSyncState,
} from "@/lib/data/address-sync-crud";
import {
  bulkAddUtxoLineage,
  bulkAddCustodySegments,
  bulkAddLineageSnapshots,
  clearUtxoLineage,
  clearCustodySegments,
  clearLineageSnapshots,
  getAllUtxoLineage,
  getAllCustodySegments,
  getAllLineageSnapshots,
  type CreateUtxoLineageData,
  type CreateCustodySegmentData,
  type CreateLineageSnapshotData,
} from "@/lib/data/lineage-crud";
import {
  addRecordOrigin,
  clearRecordOrigins,
  type CreateRecordOriginData,
} from "@/lib/data/record-origins-crud";
import {
  addToBlacklist,
  removeFromBlacklistByAddress,
} from "@/lib/data/sync-protection-crud";
import type { Record as VaultRecord } from "@/lib/db-types";

// ---------------------------------------------------------------------------
// Fixture identifiers (first 8 chars all distinct)
// ---------------------------------------------------------------------------

const ADDR_A = "bc1qaaaa-curated-cold-storage-000000000001"; // curated, kept
const ADDR_B = "bc1qbbbb-bare-dropped-branch-0000000000002"; // bare, dropped, NOT rebuilt
const ADDR_C = "bc1qcccc-tagged-discovered-000000000000003"; // tagged, kept
const ADDR_E0 = "bc1qe000-bare-counterparty-000000000000004"; // bare, dropped, shell
const ADDR_E1 = "bc1qe111-bare-counterparty-000000000000005"; // bare, dropped, shell
const ADDR_F = "bc1qffff-attachment-bearing-00000000000006"; // bare + attachment, kept
const ADDR_G = "bc1qgggg-import-origin-0000000000000000007"; // bare + manual origin, kept
const ADDR_H = "bc1qhhhh-blacklisted-0000000000000000000008"; // bare + blacklisted, kept
const ADDR_I = "bc1qiiii-co-spender-00000000000000000000009"; // bare, dropped, shell
const ADDR_J = "bc1qjjjj-anchored-by-txrecord-000000000010"; // bare, dropped, shell
const ADDR_X2 = "bc1qx222-external-nobody-00000000000000011"; // recordless externals
const ADDR_X4 = "bc1qx444-external-nobody-00000000000000012";
const ADDR_X5 = "bc1qx555-external-nobody-00000000000000013";
const EXT_IN = "bc1qxine-external-funder-00000000000000014";
const EXT_A = "bc1qxa00-external-nobody-00000000000000015";
const EXT_B = "bc1qxb00-external-nobody-00000000000000016";

const TX0 = "tx0-kept".padEnd(64, "0"); // E0 -> A            KEPT (A anchors)
const TX1 = "tx1-drop".padEnd(64, "0"); // ext -> B           DROPPED
const TX1B = "tx1bdrop".padEnd(64, "0"); // B -> X2           DROPPED
const TX2 = "tx2-kept".padEnd(64, "0"); // E1 -> C            KEPT (C + TR2 anchor)
const TX4 = "tx4-kept".padEnd(64, "0"); // A(no recordId)+I -> X4  KEPT (kept ADDRESS anchors)
const TX5 = "tx5-kept".padEnd(64, "0"); // J -> X5            KEPT (TR5 tx record anchors)
const TX6 = "tx6-kept".padEnd(64, "0"); // ext -> ext         KEPT (neutral, untouched)
const EXT0 = "ext0-prv".padEnd(64, "0");
const EXT1 = "ext1-prv".padEnd(64, "0");
const EXT2 = "ext2-prv".padEnd(64, "0");
const EXT4 = "ext4-prv".padEnd(64, "0");
const EXT5 = "ext5-prv".padEnd(64, "0");

const ATT_PATH = "ab/attachment-for-f.bin";
const ATT_BYTES = new TextEncoder().encode("receipt-bytes");

const KEPT_TXIDS = [TX0, TX2, TX4, TX5, TX6];
const DROPPED_TXIDS = [TX1, TX1B];
const SHELL_ADDRESSES = [ADDR_E0, ADDR_E1, ADDR_I, ADDR_J];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const sourceFiles = new Map<string, Uint8Array>();
const restoredFiles = new Map<string, Uint8Array>();

const attachmentIO: AttachmentFileIO = {
  async listAll() {
    return [...sourceFiles.keys()];
  },
  async read(relPath) {
    const v = sourceFiles.get(relPath);
    return v
      ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer)
      : null;
  },
};

const attachmentWriter: AttachmentFileWriter = {
  async write(relPath, data) {
    restoredFiles.set(relPath, new Uint8Array(data));
  },
};

async function clearEverything(): Promise<void> {
  await clearAllRecords({ skipNotification: true });
  await clearAttachments({ skipNotification: true });
  await clearParticipants({ skipNotification: true });
  await clearTransactions({ skipNotification: true });
  await clearAddressSyncState({ skipNotification: true });
  await clearUtxoLineage({ skipNotification: true });
  await clearCustodySegments({ skipNotification: true });
  await clearLineageSnapshots({ skipNotification: true });
  await clearRecordOrigins({ skipNotification: true });
  await removeFromBlacklistByAddress(ADDR_H);
  restoredFiles.clear();
}

function bareDiscovered(
  address: string,
  discoveredInTxid: string,
  over: { [k: string]: unknown } = {},
): CreateRecordData {
  // Every machine-stamped field populated — none may protect the record.
  return {
    type: "address",
    inputString: address,
    inputStringLower: address.toLowerCase(),
    label: "",
    tags: [],
    categories: [],
    owner: "Pending Review",
    source: "blockchain-sync",
    syncDepth: 1,
    maxSyncedDepth: 0,
    discoveredInTxid,
    addressImportance: "blockchain-discovered",
    firstSeenBlockTime: 1_700_000_000,
    walletName: "Main Wallet", // inherited from the discovering record
    seedName: "Main Seed",
    cachedBalanceSats: 1_000,
    cachedTxCount: 1,
    statsComputedAt: 1_700_000_002_000,
    ...over,
  } as unknown as CreateRecordData;
}

function bareTxRecord(txid: string, over: { [k: string]: unknown } = {}): CreateRecordData {
  return {
    type: "transaction",
    inputString: txid,
    inputStringLower: txid,
    label: "",
    tags: [],
    categories: [],
    owner: "Pending Review",
    source: "blockchain-sync",
    syncDepth: 1,
    date: "2024-05-01", // machine-stamped block date on sync tx records
    addressImportance: "blockchain-discovered",
    firstSeenBlockTime: 1_700_000_000,
    ...over,
  } as unknown as CreateRecordData;
}

interface SeedIds {
  A: number;
  B: number;
}

async function seedVault(): Promise<SeedIds> {
  await clearEverything();
  sourceFiles.clear();
  sourceFiles.set(ATT_PATH, ATT_BYTES);

  // Pass 1: records later rows reference by id.
  const [idA, idB] = await bulkCreateRecords(
    [
      {
        type: "address",
        inputString: ADDR_A,
        inputStringLower: ADDR_A,
        label: "Cold storage",
        owner: "Alice",
        tags: ["mine"],
        categories: [],
        addressImportance: "manual",
        source: "manual",
      } as unknown as CreateRecordData,
      bareDiscovered(ADDR_B, TX1),
    ],
    { skipNotification: true, skipVocabularySync: true },
  );

  // Pass 2: the rest (some reference idA/idB).
  const [idE0, idC, idF, idG, idH, idI, idJ, idE1] = await bulkCreateRecords(
    [
      bareDiscovered(ADDR_E0, TX0),
      // User-tagged discovered record; its discovery pointer aims at B, which
      // the compact export DROPS — the pointer must be scrubbed in the backup.
      bareDiscovered(ADDR_C, TX2, { tags: ["watch"], discoveredFromRecordId: idB }),
      // Bare, but an attachment row links it — kept. Pointer at A (kept) must
      // survive unscrubbed.
      bareDiscovered(ADDR_F, TX0, { discoveredFromRecordId: idA }),
      bareDiscovered(ADDR_G, TX0), // kept via non-sync record origin
      bareDiscovered(ADDR_H, TX1), // kept via blacklist entry
      bareDiscovered(ADDR_I, TX4),
      bareDiscovered(ADDR_J, TX5),
      bareDiscovered(ADDR_E1, TX2),
    ],
    { skipNotification: true, skipVocabularySync: true },
  );

  await bulkCreateRecords(
    [
      bareTxRecord(TX0), // bare tx record of a KEPT tx -> kept
      bareTxRecord(TX1), // bare tx record of a DROPPED tx -> dropped with it
      bareTxRecord(TX2, { notes: "verified with counterparty" }), // user notes -> kept + anchors
      bareTxRecord(TX5, { label: "interesting flow" }), // user label -> kept + ANCHORS TX5
    ],
    { skipNotification: true, skipVocabularySync: true },
  );

  await addRecordOrigin(
    { recordId: idG, originType: "manual" } as CreateRecordOriginData,
    { skipNotification: true },
  );
  // A plain blockchain-sync origin must NOT protect a record.
  await addRecordOrigin(
    { recordId: idE0, originType: "blockchain-sync" } as CreateRecordOriginData,
    { skipNotification: true },
  );
  await addToBlacklist({ address: ADDR_H, reason: "test" }, { skipNotification: true });
  await bulkAddAttachments(
    [
      {
        recordId: idF,
        filename: "receipt.txt",
        mimeType: "text/plain",
        size: ATT_BYTES.byteLength,
        objectStoragePath: ATT_PATH,
      } as CreateAttachmentData,
    ],
    { skipNotification: true },
  );

  const mkTx = (txid: string, blockHeight: number) => ({
    txid,
    blockHeight,
    blockTime: 1_700_000_000 + blockHeight,
    fee: 210,
    feeRate: 1.5,
    syncedAt: 1_700_000_500_000,
  });
  await bulkAddTransactions(
    [
      mkTx(TX0, 800_000),
      mkTx(TX1, 800_001),
      mkTx(TX1B, 800_002),
      mkTx(TX2, 800_003),
      mkTx(TX4, 800_004),
      mkTx(TX5, 800_005),
      mkTx(TX6, 800_006),
    ],
    { skipNotification: true },
  );

  await bulkAddParticipants(
    [
      // TX0: bare E0 pays curated A — kept (A's recordId anchors).
      { txid: TX0, role: "input", address: ADDR_E0, amount: 50_000, recordId: idE0, prevTxid: EXT0, prevVout: 0 },
      { txid: TX0, role: "output", address: ADDR_A, amount: 49_000, vout: 0, recordId: idA },
      // TX1: external funder pays bare B — dropped (no kept participant).
      { txid: TX1, role: "input", address: EXT_IN, amount: 30_000, prevTxid: EXT1, prevVout: 0 },
      { txid: TX1, role: "output", address: ADDR_B, amount: 29_000, vout: 0, recordId: idB },
      // TX1B: B spends on — dropped.
      { txid: TX1B, role: "input", address: ADDR_B, amount: 29_000, recordId: idB, prevTxid: TX1, prevVout: 0 },
      { txid: TX1B, role: "output", address: ADDR_X2, amount: 28_500, vout: 0 },
      // TX2: bare E1 pays tagged C — kept.
      { txid: TX2, role: "input", address: ADDR_E1, amount: 20_000, recordId: idE1, prevTxid: EXT2, prevVout: 0 },
      { txid: TX2, role: "output", address: ADDR_C, amount: 19_500, vout: 0, recordId: idC },
      // TX4: A co-spends with bare I. A's participant has NO recordId — the
      // kept-ADDRESS rule alone must anchor this tx.
      { txid: TX4, role: "input", address: ADDR_A, amount: 49_000, prevTxid: TX0, prevVout: 0 },
      { txid: TX4, role: "input", address: ADDR_I, amount: 5_000, recordId: idI, prevTxid: EXT4, prevVout: 0 },
      { txid: TX4, role: "output", address: ADDR_X4, amount: 53_500, vout: 0 },
      // TX5: bare J pays external — anchored ONLY by TR5 (labelled tx record).
      { txid: TX5, role: "input", address: ADDR_J, amount: 8_000, recordId: idJ, prevTxid: EXT5, prevVout: 0 },
      { txid: TX5, role: "output", address: ADDR_X5, amount: 7_500, vout: 0 },
      // TX6: fully external/neutral — untouched by the compact filter.
      { txid: TX6, role: "input", address: EXT_A, amount: 1_000, prevTxid: EXT0, prevVout: 1 },
      { txid: TX6, role: "output", address: EXT_B, amount: 900, vout: 0 },
    ],
    { skipNotification: true },
  );

  await bulkAddAddressSyncState(
    [
      { address: ADDR_A, recordId: idA, lastSyncedHeight: 800_010, lastSyncedAt: 1_700_000_500_000, txCount: 2 },
      { address: ADDR_B, recordId: idB, lastSyncedHeight: 800_010, lastSyncedAt: 1_700_000_500_000, txCount: 2 },
      { address: ADDR_C, recordId: idC, lastSyncedHeight: 800_010, lastSyncedAt: 1_700_000_500_000, txCount: 1 },
      { address: ADDR_H, recordId: idH, lastSyncedHeight: 800_010, lastSyncedAt: 1_700_000_500_000, txCount: 0 },
    ],
    { skipNotification: true },
  );

  const mkLineage = (
    spentTxid: string,
    spentAddress: string,
    consumingTxid: string,
    createdAddress: string,
  ): CreateUtxoLineageData =>
    ({
      spentTxid,
      spentVout: 0,
      spentAddress,
      spentAmount: 10_000,
      consumingTxid,
      createdTxid: consumingTxid,
      createdVout: 0,
      createdAddress,
      createdAmount: 9_500,
      spentOwned: true,
      createdOwned: false,
      isChange: false,
      confidence: "high",
      blockTime: 1_700_000_100,
      blockHeight: 800_010,
      createdAt: 1_700_000_500_000,
    }) as unknown as CreateUtxoLineageData;

  await bulkAddUtxoLineage(
    [
      mkLineage(TX0, ADDR_A, TX4, ADDR_X4), // kept: all txids kept
      mkLineage(TX1, ADDR_B, TX1B, ADDR_X2), // dropped: everything dropped
      mkLineage(TX1, ADDR_B, TX2, ADDR_C), // kept: consuming tx kept (conservative)
    ],
    { skipNotification: true },
  );

  const mkSegment = (
    segmentId: string,
    originTxid: string,
    originAddress: string,
    evidenceTxids: string[],
    over: { [k: string]: unknown } = {},
  ): CreateCustodySegmentData =>
    ({
      segmentId,
      originTxid,
      originVout: 0,
      originAddress,
      originDate: 1_700_000_000,
      originAmount: 49_000,
      currentAmount: 49_000,
      status: "active",
      hopCount: 0,
      evidenceTxids,
      createdAt: 1_700_000_500_000,
      updatedAt: 1_700_000_500_000,
      ...over,
    }) as unknown as CreateCustodySegmentData;

  await bulkAddCustodySegments(
    [
      mkSegment("seg-0", TX0, ADDR_A, [TX0]), // kept
      mkSegment("seg-1", TX1, ADDR_B, [TX1, TX1B], {
        currentTxid: TX1B,
        currentAddress: ADDR_X2,
      }), // dropped: all discovery-only
      mkSegment("seg-2", TX1, ADDR_B, [TX1, TX0]), // kept: TX0 evidence survives
    ],
    { skipNotification: true },
  );

  await bulkAddLineageSnapshots(
    [
      {
        snapshotId: "snap-1",
        targetType: "address",
        targetAddress: ADDR_A,
        segments: ["seg-0"],
        evidenceTxids: [TX0],
        totalAmount: 49_000,
        earliestDate: 1_700_000_000,
        latestDate: 1_700_000_100,
        hopCount: 0,
        narrative: "test narrative",
        disclosureLevel: "full",
        generatedAt: 1_700_000_500_000,
      } as unknown as CreateLineageSnapshotData,
    ],
    { skipNotification: true },
  );

  return { A: idA, B: idB };
}

async function exportZip(plan?: CompactPlan, password?: string): Promise<Blob> {
  const sink = new MemorySink();
  await exportBackup({
    sink,
    encrypted: !!password,
    password: password ?? "",
    compactPlan: plan,
    attachmentIO,
  });
  return sink.blob as Blob;
}

async function runRestore(
  blob: Blob,
  restoreMode: "replace" | "merge",
  opts: {
    password?: string;
    signal?: AbortSignal;
    onProgress?: (p: { percent: number; phase: string }) => void;
  } = {},
): Promise<RestoreResult> {
  return restoreV3Backup({
    source: blobChunks(blob),
    password: opts.password,
    attachmentWriter,
    restoreMode,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
}

interface VaultSnapshot {
  records: VaultRecord[];
  txs: Awaited<ReturnType<typeof getAllTransactions>>;
  parts: Awaited<ReturnType<typeof getAllTransactionParticipants>>;
  sync: Awaited<ReturnType<typeof getAllAddressSyncState>>;
  lineage: Awaited<ReturnType<typeof getAllUtxoLineage>>;
  segments: Awaited<ReturnType<typeof getAllCustodySegments>>;
  snaps: Awaited<ReturnType<typeof getAllLineageSnapshots>>;
  attachments: Awaited<ReturnType<typeof getAllAttachments>>;
}

async function snapshotVault(): Promise<VaultSnapshot> {
  return {
    records: await getAllRecords(),
    txs: await getAllTransactions(),
    parts: await getAllTransactionParticipants(),
    sync: await getAllAddressSyncState(),
    lineage: await getAllUtxoLineage(),
    segments: await getAllCustodySegments(),
    snaps: await getAllLineageSnapshots(),
    attachments: await getAllAttachments(),
  };
}

function byInput(records: VaultRecord[]): Map<string, VaultRecord> {
  const m = new Map<string, VaultRecord>();
  for (const r of records) {
    expect(m.has(r.inputString), `duplicate record for ${r.inputString}`).toBe(false);
    m.set(r.inputString, r);
  }
  return m;
}

// Strips per-restore volatile fields (auto-increment id) for comparison.
function stripId<T extends { id?: unknown }>(row: T): Omit<T, "id"> {
  const { id: _id, ...rest } = row;
  return rest;
}

// Participant identity independent of record ids (which differ across
// restores): the fields balance/spent/Sent computations consume.
function partKey(p: {
  txid: string;
  role: string;
  address?: string;
  amount?: number;
  vout?: number;
  prevTxid?: string;
  prevVout?: number;
}): string {
  return [p.txid, p.role, p.address ?? "", p.amount ?? "", p.vout ?? "", p.prevTxid ?? "", p.prevVout ?? ""].join("|");
}

// ---------------------------------------------------------------------------
// Tests (sequential; module-level state carries between its)
// ---------------------------------------------------------------------------

let originalSnap: VaultSnapshot;
let originalIds: SeedIds;
let plan: CompactPlan;
let fullBlob: Blob;
let compactBlob: Blob;
let compactResult: RestoreResult;
let compactSnap: VaultSnapshot;
let fullSnap: VaultSnapshot;

beforeAll(async () => {
  originalIds = await seedVault();
  originalSnap = await snapshotVault();
  plan = await computeCompactPlan({ batchSize: 3 }); // tiny pages: exercise keyset paging
  fullBlob = await exportZip();
  compactBlob = await exportZip(plan);
}, 60_000);

describe("compact plan classification", () => {
  it("drops exactly the bare discovered records and discovery-only history", () => {
    expect(plan.dropped).toEqual({
      records: 6, // E0, B, E1, I, J + TR1 (bare tx record of a dropped tx)
      blockchainTransactions: 2, // TX1, TX1B
      transactionParticipants: 4, // 2 rows each in TX1, TX1B
      addressSyncState: 1, // B's row
      utxoLineage: 1,
      custodySegments: 1,
    });
    expect(plan.counts).toEqual({
      records: 8, // A, C, F, G, H + TR0, TR2, TR5
      blockchainTransactions: 5,
      transactionParticipants: 11,
      addressSyncState: 3,
      utxoLineage: 2,
      custodySegments: 2,
    });
    expect([...plan.droppedTxids].sort()).toEqual([...DROPPED_TXIDS].sort());
    expect([...plan.droppedAddresses].sort()).toEqual(
      [ADDR_B, ADDR_E0, ADDR_E1, ADDR_I, ADDR_J].sort(),
    );
    expect([...plan.keptAddresses].sort()).toEqual(
      [ADDR_A, ADDR_C, ADDR_F, ADDR_G, ADDR_H].sort(),
    );
    expect(plan.droppedRecordIds.size).toBe(6);
  });

  it("produces a materially smaller archive than the full export", () => {
    expect(compactBlob.size).toBeLessThan(fullBlob.size);
  });
});

describe("replace-restore of a compact backup", () => {
  beforeAll(async () => {
    compactResult = await runRestore(compactBlob, "replace");
    compactSnap = await snapshotVault();
  }, 60_000);

  it("manifest carries the compact marker and exact filtered counts", () => {
    expect(compactResult.manifest.compact).toBe(true);
    expect(compactResult.manifest.compactDropped).toEqual(plan.dropped);
    // Manifest counts describe what the archive holds; the restore counted the
    // rows it actually wrote. Equality proves the export filter and the plan's
    // counting pass agree row-for-row.
    expect(compactResult.manifest.counts.records).toBe(plan.counts.records);
    expect(compactResult.counts.records).toBe(plan.counts.records);
    expect(compactResult.counts.blockchainTransactions).toBe(plan.counts.blockchainTransactions);
    expect(compactResult.counts.transactionParticipants).toBe(plan.counts.transactionParticipants);
    expect(compactResult.counts.addressSyncState).toBe(plan.counts.addressSyncState);
    expect(compactResult.counts.utxoLineage).toBe(plan.counts.utxoLineage);
    expect(compactResult.counts.custodySegments).toBe(plan.counts.custodySegments);
    expect(compactResult.counts.lineageSnapshots).toBe(1);
    expect(compactResult.counts.attachments).toBe(1);
    expect(compactResult.counts.attachmentFiles).toBe(1);
  });

  it("rebuilds a blockchain-discovered shell for every pruned address still referenced by kept rows", () => {
    expect(compactResult.counts.rebuiltDiscoveredShells).toBe(SHELL_ADDRESSES.length);
    const m = byInput(compactSnap.records);
    const expectedDiscoveredIn: { [addr: string]: string } = {
      [ADDR_E0]: TX0,
      [ADDR_E1]: TX2,
      [ADDR_I]: TX4,
      [ADDR_J]: TX5,
    };
    for (const address of SHELL_ADDRESSES) {
      const shell = m.get(address);
      expect(shell, `missing shell for ${address}`).toBeDefined();
      expect(shell!.type).toBe("address");
      expect(shell!.addressImportance).toBe("blockchain-discovered");
      expect(shell!.owner).toBe("Pending Review");
      expect(shell!.label ?? "").toBe("");
      expect(shell!.source).toBe("blockchain-sync");
      // Never-synced marker so "Sync Deeper" naturally rebuilds their history.
      expect(shell!.maxSyncedDepth).toBe(-1);
      expect(shell!.discoveredInTxid).toBe(expectedDiscoveredIn[address]);
    }
    // B was only referenced by DROPPED transactions — nothing kept points at
    // it, so it must NOT be rebuilt (and its sync state is gone).
    expect(m.has(ADDR_B)).toBe(false);
    expect(compactSnap.sync.some((s) => s.address === ADDR_B)).toBe(false);
    // Total: 8 kept + 4 shells.
    expect(compactSnap.records.length).toBe(8 + SHELL_ADDRESSES.length);
  });

  it("keeps every user-touched record byte-for-byte (vs the original vault)", () => {
    const restored = byInput(compactSnap.records);
    const original = byInput(originalSnap.records);
    const keptInputs = [ADDR_A, ADDR_C, ADDR_F, ADDR_G, ADDR_H, TX0, TX2, TX5];
    for (const input of keptInputs) {
      const orig = original.get(input);
      const rest = restored.get(input);
      expect(orig, `original missing ${input}`).toBeDefined();
      expect(rest, `restored missing ${input}`).toBeDefined();
      const origCmp = stripId(orig!) as { [k: string]: unknown };
      const restCmp = stripId(rest!) as { [k: string]: unknown };
      if (input === ADDR_C) {
        // C's discovery pointer aimed at B, which the compact export dropped —
        // the backup must carry NO dangling pointer, so restore has none.
        expect(restCmp.discoveredFromRecordId).toBeUndefined();
        delete origCmp.discoveredFromRecordId;
        delete restCmp.discoveredFromRecordId;
      }
      if (input === ADDR_F) {
        // F's pointer aims at A (kept): it survives. (Restore keeps the raw
        // backup value — id remapping of this pointer is a pre-existing
        // limitation shared with FULL restores, asserted identical below.)
        expect(restCmp.discoveredFromRecordId).toBe(originalIds.A);
      }
      expect(restCmp, `record ${input} must survive byte-for-byte`).toEqual(origCmp);
    }
    // Dropped records are gone: TR1's tx record and B's address record.
    expect(restored.has(TX1)).toBe(false);
    expect(restored.has(ADDR_B)).toBe(false);
  });

  it("leaves ZERO dangling recordIds anywhere", () => {
    const ids = new Set(compactSnap.records.map((r) => r.id));
    for (const p of compactSnap.parts) {
      if (p.recordId !== undefined) {
        expect(ids.has(p.recordId), `participant ${p.txid}/${p.address} dangles`).toBe(true);
      }
    }
    for (const s of compactSnap.sync) {
      if (s.recordId !== undefined) {
        expect(ids.has(s.recordId), `syncState ${s.address} dangles`).toBe(true);
      }
    }
    for (const a of compactSnap.attachments) {
      expect(ids.has(a.recordId), `attachment ${a.filename} dangles`).toBe(true);
    }
    // Every formerly-pruned participant is relinked to its rebuilt shell.
    const m = byInput(compactSnap.records);
    for (const address of SHELL_ADDRESSES) {
      const rows = compactSnap.parts.filter((p) => p.address === address);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.recordId).toBe(m.get(address)!.id);
      }
    }
    // TX4's A-input deliberately has no recordId (address-keyed row) — that is
    // valid data, not a dangling link; it must survive as-is.
    const aInput = compactSnap.parts.find((p) => p.txid === TX4 && p.role === "input" && p.address === ADDR_A);
    expect(aInput).toBeDefined();
    expect(aInput!.recordId).toBeUndefined();
  });

  it("drops only discovery-only history rows; kept tables match the original", () => {
    expect(compactSnap.txs.map((t) => t.txid).sort()).toEqual([...KEPT_TXIDS].sort());
    expect(compactSnap.parts.map(partKey).sort()).toEqual(
      originalSnap.parts
        .filter((p) => !DROPPED_TXIDS.includes(p.txid))
        .map(partKey)
        .sort(),
    );
    expect(compactSnap.sync.map((s) => s.address).sort()).toEqual(
      [ADDR_A, ADDR_C, ADDR_H].sort(),
    );
    expect(compactSnap.lineage.map((l) => stripId(l)).sort((a, b) => a.spentTxid.localeCompare(b.spentTxid) || a.consumingTxid.localeCompare(b.consumingTxid))).toEqual(
      originalSnap.lineage
        .filter((l) => !(l.spentTxid === TX1 && l.consumingTxid === TX1B))
        .map((l) => stripId(l))
        .sort((a, b) => a.spentTxid.localeCompare(b.spentTxid) || a.consumingTxid.localeCompare(b.consumingTxid)),
    );
    expect(compactSnap.segments.map((s) => s.segmentId).sort()).toEqual(["seg-0", "seg-2"]);
    expect(compactSnap.snaps.length).toBe(1);
    expect(compactSnap.snaps[0].snapshotId).toBe("snap-1");
    // Attachment row and file bytes survive untouched.
    expect(compactSnap.attachments.length).toBe(1);
    expect(new TextDecoder().decode(restoredFiles.get(ATT_PATH)!)).toBe(
      new TextDecoder().decode(ATT_BYTES),
    );
  });
});

describe("owned-history equivalence: compact restore == full restore", () => {
  beforeAll(async () => {
    fullSnap = undefined as unknown as VaultSnapshot;
    await runRestore(fullBlob, "replace");
    fullSnap = await snapshotVault();
  }, 60_000);

  it("full restore really contains the discovery-only rows the compact one prunes", () => {
    expect(fullSnap.records.length).toBe(originalSnap.records.length); // 14, incl. B + TR1
    expect(fullSnap.txs.length).toBe(originalSnap.txs.length); // 7, incl. TX1/TX1B
  });

  it("kept transactions + participants are IDENTICAL — so balances, spent/UTXO status, and Sent detection are too", () => {
    // Balance / spent / Sent computations consume blockchainTransactions and
    // transactionParticipants rows for owned addresses (plus the records
    // themselves). All three row sets are identical for every kept txid and
    // address, so every derived number is identical by construction.
    const keptTx = (t: { txid: string }) => KEPT_TXIDS.includes(t.txid);
    expect(
      compactSnap.txs.map((t) => stripId(t)).sort((a, b) => a.txid.localeCompare(b.txid)),
    ).toEqual(
      fullSnap.txs.filter(keptTx).map((t) => stripId(t)).sort((a, b) => a.txid.localeCompare(b.txid)),
    );
    expect(compactSnap.parts.map(partKey).sort()).toEqual(
      fullSnap.parts.filter(keptTx).map(partKey).sort(),
    );
    // Kept address records byte-identical between the two restores (C's
    // scrubbed pointer aside, which full keeps as B's stale backup id).
    const fullBy = byInput(fullSnap.records);
    const compactBy = byInput(compactSnap.records);
    for (const input of [ADDR_A, ADDR_C, ADDR_F, ADDR_G, ADDR_H, TX0, TX2, TX5]) {
      const f = stripId(fullBy.get(input)!) as { [k: string]: unknown };
      const c = stripId(compactBy.get(input)!) as { [k: string]: unknown };
      if (input === ADDR_C) {
        delete f.discoveredFromRecordId;
        delete c.discoveredFromRecordId;
      }
      expect(c, `record ${input} differs between full and compact restores`).toEqual(f);
    }
    // Sync state for kept addresses matches (recordIds are per-restore ids;
    // compare the address-keyed payload).
    const syncKey = (s: { address: string; lastSyncedHeight?: number; txCount?: number }) =>
      [s.address, s.lastSyncedHeight, s.txCount].join("|");
    expect(compactSnap.sync.map(syncKey).sort()).toEqual(
      fullSnap.sync
        .filter((s) => s.address !== ADDR_B)
        .map(syncKey)
        .sort(),
    );
  });
});

describe("merge-restore of a compact backup", () => {
  it("reuses an existing address record instead of creating a duplicate shell", async () => {
    await clearEverything();
    const [bobId] = await bulkCreateRecords(
      [
        {
          type: "address",
          inputString: ADDR_E0,
          inputStringLower: ADDR_E0,
          label: "Known peer",
          owner: "Bob",
          tags: [],
          categories: [],
          addressImportance: "manual",
          source: "manual",
        } as unknown as CreateRecordData,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    const result = await runRestore(compactBlob, "merge");
    // E0 resolves to Bob's record — only E1, I, J need shells.
    expect(result.counts.rebuiltDiscoveredShells).toBe(3);

    const snap = await snapshotVault();
    const e0Records = snap.records.filter((r) => r.inputString === ADDR_E0);
    expect(e0Records.length).toBe(1);
    expect(e0Records[0].id).toBe(bobId);
    expect(e0Records[0].label).toBe("Known peer"); // merge never overwrites
    expect(e0Records[0].owner).toBe("Bob");

    const e0Input = snap.parts.find((p) => p.txid === TX0 && p.role === "input");
    expect(e0Input).toBeDefined();
    expect(e0Input!.recordId).toBe(bobId);

    // 1 pre-existing + 8 restored + 3 shells; zero dangling links.
    expect(snap.records.length).toBe(1 + 8 + 3);
    const ids = new Set(snap.records.map((r) => r.id));
    for (const p of snap.parts) {
      if (p.recordId !== undefined) expect(ids.has(p.recordId)).toBe(true);
    }
  }, 60_000);

  it("cancelling a merge also undoes rebuilt shells (vault returns to its pre-merge state)", async () => {
    await clearEverything();
    const [keeperId] = await bulkCreateRecords(
      [
        {
          type: "address",
          inputString: "bc1qkeep-premerge-baseline-000000000000017",
          inputStringLower: "bc1qkeep-premerge-baseline-000000000000017",
          label: "Pre-merge baseline",
          tags: [],
          categories: [],
          addressImportance: "manual",
          source: "manual",
        } as unknown as CreateRecordData,
      ],
      { skipNotification: true, skipVocabularySync: true },
    );

    // Abort once addressSyncState starts restoring: records, attachments, and
    // participants (INCLUDING the rebuilt shells) are already in the vault.
    const controller = new AbortController();
    let thrown: unknown;
    try {
      await runRestore(compactBlob, "merge", {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase.startsWith("Restoring addressSyncState")) controller.abort();
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BackupCancelledError);
    expect((thrown as BackupCancelledError).mergeUndone).toBe(true);

    const snap = await snapshotVault();
    expect(snap.records.length).toBe(1); // shells + restored records all undone
    expect(snap.records[0].id).toBe(keeperId);
    expect(snap.parts.length).toBe(0);
    expect(snap.txs.length).toBe(0);
    expect(snap.sync.length).toBe(0);
    expect(snap.attachments.length).toBe(0);
  }, 60_000);
});

describe("wrong-password restore of an encrypted compact backup", () => {
  it("rejects before touching the vault", async () => {
    await seedVault();
    const freshPlan = await computeCompactPlan();
    const encBlob = await exportZip(freshPlan, "correct-horse-battery-9");

    const before = await snapshotVault();
    await expect(
      runRestore(encBlob, "replace", { password: "wrong-password-42" }),
    ).rejects.toThrow(/password|corrupt/i);

    const after = await snapshotVault();
    expect(after.records.length).toBe(before.records.length);
    expect(after.parts.length).toBe(before.parts.length);
    expect(after.txs.length).toBe(before.txs.length);
    expect(after.sync.length).toBe(before.sync.length);
  }, 60_000);
});
