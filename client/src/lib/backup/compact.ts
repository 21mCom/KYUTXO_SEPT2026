// Compact backup (v3 export option): classification + planning.
//
// A compact backup omits blockchain-discovered records that carry NO user-added
// metadata, plus the discovery-only history beneath them (their sync state, and
// transactions/participants/lineage/custody rows in which no kept record
// participates). Deep discovery ("Sync Deeper") can create millions of such
// rows; the user never touched them, so a compact backup can skip them and
// shrink dramatically.
//
// CRITICAL RESTORE CONSTRAINT (why restore rebuilds shells locally): a
// post-restore sync does NOT re-create dropped discovered records. syncAddress
// skips transactions at already-synced heights, and even without sync state it
// skips any tx already present in blockchainTransactions — counterparty
// discovery only runs for newly imported txs. Since a compact backup KEEPS the
// owned transaction history (balances/spent detection depend on it), restore
// must rebuild discovered record shells locally from the kept participant rows
// (see restore.ts); it cannot rely on the network.
//
// This module is the single source of truth for:
//   1. which Record fields count as user metadata (RECORD_FIELD_CLASSIFICATION,
//      compile-time frozen: adding a Record field without classifying it here
//      is a type error),
//   2. the prunability predicate (recordHasUserMetadata / isPrunableRecordShape),
//   3. the export pre-pass that turns the predicate into exact row-drop sets and
//      filtered per-table counts (computeCompactPlan), and
//   4. the per-row drop/scrub rules the export stream applies
//      (compactRowFilters) — counting and filtering share these functions so the
//      manifest counts can never diverge from the rows actually written.

import type {
  Record as VaultRecord,
  TransactionParticipant,
  BlockchainTransaction,
  AddressSyncState,
  UtxoLineage,
  CustodySegment,
  Attachment,
} from "@/lib/db-types";
import { BackupCancelledError } from "./sink";
import {
  getRecordsAfterId,
  countRecords,
} from "@/lib/data/record-crud";
import {
  getAttachmentsAfterId,
  countAttachments,
} from "@/lib/data/attachments-crud";
import {
  getTransactionsAfterId,
  countTransactions,
  getTransactionParticipantsAfterId,
  countTransactionParticipants,
} from "@/lib/data/transaction-crud";
import {
  getAddressSyncStateAfterId,
  countAddressSyncState,
} from "@/lib/data/address-sync-crud";
import {
  getUtxoLineageAfterId,
  getCustodySegmentsAfterId,
  countUtxoLineage,
  countCustodySegments,
} from "@/lib/data/lineage-crud";
import { getRecordOriginsAfterId } from "@/lib/data/record-origins-crud";
import { getAllBlacklist } from "@/lib/data/sync-protection-crud";

// ---------------------------------------------------------------------------
// 1. Field classification (compile-time frozen)
// ---------------------------------------------------------------------------

// How a Record field is treated by the prunability predicate:
//   - 'identity': structural/key fields — never metadata (id, type, the
//     address/txid string itself, timestamps).
//   - 'machine':  stamped by sync or derived caches — never metadata even when
//     present (inherited walletName/seedName/walletSoftware, cached stats,
//     syncDepth, discovery pointers, source, importance tier itself).
//   - 'user':     any meaningful value means the user (or a user-driven import)
//     touched the record — it must survive a compact export byte-for-byte.
//   - 'special':  explicitly handled in recordHasUserMetadata with a comment
//     (owner: 'Pending Review' is the machine default; date: machine-stamped on
//     sync-created transaction records, user-set otherwise).
export type CompactFieldClass = "identity" | "machine" | "user" | "special";

// Compile-time freeze: `[K in keyof Required<VaultRecord>]` forces EVERY field
// of Record — including any added in the future — to be explicitly classified
// here, or `npm run check` fails. The unit test additionally asserts runtime
// completeness against a fully-populated sample record.
export const RECORD_FIELD_CLASSIFICATION: {
  [K in keyof Required<VaultRecord>]: CompactFieldClass;
} = {
  id: "identity",
  type: "identity",
  inputString: "identity",
  inputStringLower: "identity",
  createdAt: "identity",
  updatedAt: "identity",

  // Machine-stamped by blockchain sync / derived caches — never user metadata.
  source: "machine",
  syncDepth: "machine",
  maxSyncedDepth: "machine",
  discoveredInTxid: "machine",
  discoveredFromRecordId: "machine",
  addressImportance: "machine",
  firstSeenBlockTime: "machine",
  // Discovered records INHERIT walletName/seedName/walletSoftware from the
  // record that led to their discovery (see findOrCreateAddressRecord), so
  // their presence is not evidence of user intent.
  walletName: "machine",
  seedName: "machine",
  walletSoftware: "machine",
  // Per-address stats cache, recomputed from local data.
  cachedBalanceSats: "machine",
  cachedTxCount: "machine",
  cachedLastActivityTime: "machine",
  statsComputedAt: "machine",
  cachedUtxoCount: "machine",

  // User-meaning fields — any meaningful value keeps the record.
  label: "user",
  notes: "user",
  amount: "user",
  tags: "user",
  categories: "user",
  privateKeyStatus: "user",
  chainType: "user",
  derivationPath: "user",
  xpub: "user",
  vault: "user",
  customFields: "user",
  flowType: "user",
  acquisitionMethod: "user",
  dispositionType: "user",
  costBasisUsd: "user",
  counterpartyType: "user",
  counterpartyName: "user",
  // Recorded from the Conflict Resolution page — a user decision.
  conflictResolutions: "user",

  // Special-cased in recordHasUserMetadata (see comments there).
  owner: "special",
  date: "special",
};

// The machine default owner stamped on every sync-created record. Sync-created
// TRANSACTION records may also inherit the parent record's owner — but a
// non-default inherited owner implies a metadata-bearing (kept) parent, and the
// parent participates in every one of that record's transactions, so treating a
// non-default owner as user metadata never strands prunable history.
export const MACHINE_DEFAULT_OWNER = "Pending Review";

function isMeaningful(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true; // numbers/booleans: presence is meaningful (0 counts — conservative)
}

// True when the record carries ANY user-added metadata per the classification
// above. Unknown fields present at runtime but missing from the classification
// (e.g. legacy stragglers like `_legacyEncryptedPayload`) count as user
// metadata — fail SAFE by keeping the record.
export function recordHasUserMetadata(record: VaultRecord): boolean {
  const rec = record as unknown as { [k: string]: unknown };
  for (const key of Object.keys(rec)) {
    const cls = (RECORD_FIELD_CLASSIFICATION as { [k: string]: CompactFieldClass | undefined })[key];
    const value = rec[key];
    if (cls === undefined) {
      // Unclassified runtime field — keep the record if it holds anything.
      if (isMeaningful(value)) return true;
      continue;
    }
    if (cls === "identity" || cls === "machine") continue;
    if (cls === "user") {
      if (isMeaningful(value)) return true;
      continue;
    }
    // 'special'
    if (key === "owner") {
      // 'Pending Review' is the machine default stamped by sync; anything else
      // is user-meaning (set directly, or inherited from a kept parent — see
      // MACHINE_DEFAULT_OWNER above for why inheritance is safe here).
      if (isMeaningful(value) && String(value).trim() !== MACHINE_DEFAULT_OWNER) return true;
      continue;
    }
    if (key === "date") {
      // Sync stamps `date` on the TRANSACTION records it creates (block date),
      // so for those it is machine data; on address/other records sync never
      // sets it, so a value means the user did.
      if (record.type !== "transaction" && isMeaningful(value)) return true;
      continue;
    }
  }
  return false;
}

// Shape-level prunability: tier is EXACTLY 'blockchain-discovered' (never
// pending-review, never curated, never legacy-null — see
// isUserCuratedImportance for why null counts as curated) and no user metadata.
// Covers both record types sync creates: address records get the tier
// explicitly, and sync-created transaction records get it via
// deriveAddressImportance (source === 'blockchain-sync').
//
// This is only the RECORD-level test; computeCompactPlan additionally requires
// no linked rows (attachments, record origins beyond blockchain-sync), a
// non-blacklisted address, and — for transaction records — that the
// transaction itself is discovery-only (dropped).
export function isPrunableRecordShape(record: VaultRecord): boolean {
  if (record.addressImportance !== "blockchain-discovered") return false;
  if (record.type !== "address" && record.type !== "transaction") return false;
  return !recordHasUserMetadata(record);
}

// ---------------------------------------------------------------------------
// 2. Plan computation (export pre-pass)
// ---------------------------------------------------------------------------

export interface CompactPlanCounts {
  records: number;
  blockchainTransactions: number;
  transactionParticipants: number;
  addressSyncState: number;
  utxoLineage: number;
  custodySegments: number;
}

export interface CompactPlan {
  // Record ids dropped from the backup (bare discovered address records +
  // discovery-only transaction records).
  droppedRecordIds: Set<number>;
  // Addresses of dropped address records (their addressSyncState rows drop too).
  droppedAddresses: Set<string>;
  // Addresses of every KEPT address record — participants whose address is here
  // anchor their transaction even when their recordId link is missing.
  keptAddresses: Set<string>;
  // Txids in which NO kept record participates: their blockchainTransactions /
  // participants / lineage / custody rows are dropped.
  droppedTxids: Set<string>;
  // Exact post-filter row counts for the affected streamed tables, computed by
  // the SAME predicates the export stream applies (see compactRowFilters).
  counts: CompactPlanCounts;
  // Rows dropped per table (counts + dropped = raw table totals at plan time).
  dropped: CompactPlanCounts;
}

export interface ComputeCompactPlanOptions {
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (p: { percent: number; phase: string }) => void;
}

const DEFAULT_BATCH = 1000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BackupCancelledError();
}

type PagedRow = { id?: number };

// Streams a whole table in bounded keyset pages through `visit`.
async function streamTable<T extends PagedRow>(
  reader: (afterId: number, limit: number) => Promise<T[]>,
  batchSize: number,
  signal: AbortSignal | undefined,
  visit: (row: T) => void,
  onBatch?: (n: number) => void,
): Promise<void> {
  let afterId = 0;
  for (;;) {
    throwIfAborted(signal);
    const batch = await reader(afterId, batchSize);
    if (batch.length === 0) break;
    for (const row of batch) visit(row);
    onBatch?.(batch.length);
    const last = batch[batch.length - 1];
    if (last.id == null) break;
    afterId = last.id;
  }
}

// Builds the full drop plan by streaming the vault once per table (bounded
// pages, cancellable). Membership sets are held in memory — the same posture
// the merge restore already takes for its de-dup key sets (all sync-state
// addresses / lineage identities), and the sets hold only DROPPED items plus
// the (much smaller) kept-address set.
export async function computeCompactPlan(
  opts: ComputeCompactPlanOptions = {},
): Promise<CompactPlan> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const { signal } = opts;

  // Progress: weight each pass by its raw row count (participants stream twice).
  const [
    rawRecords,
    rawAttachments,
    rawParticipants,
    rawSyncState,
    rawTransactions,
    rawLineage,
    rawSegments,
  ] = await Promise.all([
    countRecords(),
    countAttachments(),
    countTransactionParticipants(),
    countAddressSyncState(),
    countTransactions(),
    countUtxoLineage(),
    countCustodySegments(),
  ]);
  const totalUnits =
    rawRecords +
      rawAttachments +
      rawParticipants * 2 +
      rawSyncState +
      rawTransactions +
      rawLineage +
      rawSegments || 1;
  let doneUnits = 0;
  const report = (phase: string) => {
    opts.onProgress?.({
      percent: Math.min(100, Math.round((doneUnits / totalUnits) * 100)),
      phase,
    });
  };
  const advance = (phase: string) => (n: number) => {
    doneUnits += n;
    report(phase);
  };

  // --- Pass 0: blacklist + linked-row keep sets -----------------------------
  // Blacklisted addresses are never pruned: the blacklist entry itself is user
  // intent about that address. (The blacklist table is small.)
  report("Analyzing backup: reading blacklist...");
  const blacklisted = new Set<string>();
  for (const b of await getAllBlacklist()) {
    if (b.address) blacklisted.add(b.address);
  }

  // Records with linked rows that make them user-touched regardless of their
  // own fields: attachments, and record origins beyond plain blockchain-sync
  // (a manual/bulk-import/wallet-sync origin means an import touched it).
  // Evidence rows carry no record link in this schema, so there is nothing to
  // check for them (evidence itself always rides inline in the manifest).
  const linkedRecordIds = new Set<number>();
  await streamTable<Attachment>(
    getAttachmentsAfterId,
    batchSize,
    signal,
    (a) => {
      if (typeof a.recordId === "number") linkedRecordIds.add(a.recordId);
    },
    advance("Analyzing backup: scanning attachments..."),
  );
  await streamTable(
    getRecordOriginsAfterId,
    batchSize,
    signal,
    (o) => {
      if (o.originType !== "blockchain-sync" && typeof o.recordId === "number") {
        linkedRecordIds.add(o.recordId);
      }
    },
    // Origins are roughly one per record; reuse the records weighting is not
    // exact, so just don't advance units for them (they ride within the same
    // phase label as attachments — cheap relative to the big tables).
  );

  // --- Pass 1: classify records ---------------------------------------------
  const droppedRecordIds = new Set<number>();
  const droppedAddresses = new Set<string>();
  const keptAddresses = new Set<string>();
  // Txids anchored by a KEPT transaction-type record (metadata-bearing, or not
  // sync-created): their transaction rows must be kept.
  const anchoredTxids = new Set<string>();
  // Bare sync-created transaction records, by txid: dropped iff their txid is.
  const txRecordCandidates = new Map<string, number[]>();
  let recordsTotal = 0;

  await streamTable<VaultRecord>(
    getRecordsAfterId,
    batchSize,
    signal,
    (r) => {
      recordsTotal++;
      const id = typeof r.id === "number" ? r.id : undefined;
      if (r.type === "address") {
        const prunable =
          id !== undefined &&
          isPrunableRecordShape(r) &&
          !linkedRecordIds.has(id) &&
          !blacklisted.has(r.inputString);
        if (prunable) {
          droppedRecordIds.add(id!);
          if (r.inputString) droppedAddresses.add(r.inputString);
        } else if (r.inputString) {
          keptAddresses.add(r.inputString);
        }
        return;
      }
      if (r.type === "transaction") {
        const bare =
          id !== undefined && isPrunableRecordShape(r) && !linkedRecordIds.has(id);
        if (bare) {
          const list = txRecordCandidates.get(r.inputString);
          if (list) list.push(id!);
          else txRecordCandidates.set(r.inputString, [id!]);
        } else if (r.inputString) {
          // A metadata-bearing (or user-created) transaction record
          // participates in its transaction — the txid must be kept.
          anchoredTxids.add(r.inputString);
        }
      }
      // type 'other': never prunable, and carries no address/txid linkage.
    },
    advance("Analyzing backup: classifying records..."),
  );

  // --- Pass 2: resolve dropped txids from participants -----------------------
  // A txid is dropped iff at least one participant references a dropped record
  // (so it belongs to the discovery neighbourhood being pruned) AND no kept
  // record participates. "Kept record participates" is judged conservatively:
  //   - a participant whose recordId is NOT dropped anchors the tx (even if the
  //     id dangles in the source vault — keep rather than risk dropping), and
  //   - a participant whose ADDRESS belongs to any kept record anchors the tx
  //     even when its recordId link is missing (address-keyed balance loads
  //     depend on those rows).
  // Participants with no recordId and an unknown/blank address are neutral.
  const touchedTxids = new Set<string>();
  await streamTable<TransactionParticipant>(
    getTransactionParticipantsAfterId,
    batchSize,
    signal,
    (p) => {
      if (typeof p.txid !== "string" || p.txid === "") return;
      const recordDropped =
        typeof p.recordId === "number" && droppedRecordIds.has(p.recordId);
      const addressDropped = !!p.address && droppedAddresses.has(p.address);
      const anchored =
        (typeof p.recordId === "number" && !droppedRecordIds.has(p.recordId)) ||
        (!!p.address && keptAddresses.has(p.address));
      if (anchored) anchoredTxids.add(p.txid);
      else if (recordDropped || addressDropped) touchedTxids.add(p.txid);
    },
    advance("Analyzing backup: mapping discovery-only transactions..."),
  );
  const droppedTxids = new Set<string>();
  for (const txid of touchedTxids) {
    if (!anchoredTxids.has(txid)) droppedTxids.add(txid);
  }
  // Free the (potentially huge) intermediate set promptly.
  touchedTxids.clear();

  // Bare sync-created transaction records for dropped txids are dropped too —
  // keeping them would leave millions of records whose blockchainTransactions
  // row is gone, which the post-restore orphan backfill would then try to
  // re-fetch from the network (exactly what a compact restore must not do).
  let droppedTxRecordCount = 0;
  for (const [txid, ids] of txRecordCandidates) {
    if (!droppedTxids.has(txid)) continue;
    for (const id of ids) {
      droppedRecordIds.add(id);
      droppedTxRecordCount++;
    }
  }
  txRecordCandidates.clear();

  // --- Pass 3: count dropped rows per table with the SHARED predicates -------
  const filters = compactRowFilters({
    droppedRecordIds,
    droppedAddresses,
    keptAddresses,
    droppedTxids,
    // counts filled below
    counts: {
      records: 0,
      blockchainTransactions: 0,
      transactionParticipants: 0,
      addressSyncState: 0,
      utxoLineage: 0,
      custodySegments: 0,
    },
    dropped: {
      records: 0,
      blockchainTransactions: 0,
      transactionParticipants: 0,
      addressSyncState: 0,
      utxoLineage: 0,
      custodySegments: 0,
    },
  });

  let droppedParticipants = 0;
  let participantsTotal = 0;
  await streamTable<TransactionParticipant>(
    getTransactionParticipantsAfterId,
    batchSize,
    signal,
    (p) => {
      participantsTotal++;
      if (filters.dropParticipant(p)) droppedParticipants++;
    },
    advance("Analyzing backup: counting kept participants..."),
  );

  let droppedTransactions = 0;
  let transactionsTotal = 0;
  await streamTable<BlockchainTransaction>(
    getTransactionsAfterId,
    batchSize,
    signal,
    (t) => {
      transactionsTotal++;
      if (filters.dropTransaction(t)) droppedTransactions++;
    },
    advance("Analyzing backup: counting kept transactions..."),
  );

  let droppedSyncState = 0;
  let syncStateTotal = 0;
  await streamTable<AddressSyncState>(
    getAddressSyncStateAfterId,
    batchSize,
    signal,
    (s) => {
      syncStateTotal++;
      if (filters.dropSyncState(s)) droppedSyncState++;
    },
    advance("Analyzing backup: counting sync state..."),
  );

  let droppedLineage = 0;
  let lineageTotal = 0;
  await streamTable<UtxoLineage>(
    getUtxoLineageAfterId,
    batchSize,
    signal,
    (l) => {
      lineageTotal++;
      if (filters.dropLineage(l)) droppedLineage++;
    },
    advance("Analyzing backup: counting lineage..."),
  );

  let droppedSegments = 0;
  let segmentsTotal = 0;
  await streamTable<CustodySegment>(
    getCustodySegmentsAfterId,
    batchSize,
    signal,
    (s) => {
      segmentsTotal++;
      if (filters.dropSegment(s)) droppedSegments++;
    },
    advance("Analyzing backup: counting custody segments..."),
  );

  const droppedRecords = droppedRecordIds.size;
  const dropped: CompactPlanCounts = {
    records: droppedRecords,
    blockchainTransactions: droppedTransactions,
    transactionParticipants: droppedParticipants,
    addressSyncState: droppedSyncState,
    utxoLineage: droppedLineage,
    custodySegments: droppedSegments,
  };
  const counts: CompactPlanCounts = {
    records: Math.max(0, recordsTotal - droppedRecords),
    blockchainTransactions: Math.max(0, transactionsTotal - droppedTransactions),
    transactionParticipants: Math.max(0, participantsTotal - droppedParticipants),
    addressSyncState: Math.max(0, syncStateTotal - droppedSyncState),
    utxoLineage: Math.max(0, lineageTotal - droppedLineage),
    custodySegments: Math.max(0, segmentsTotal - droppedSegments),
  };
  // droppedTxRecordCount is folded into dropped.records via droppedRecordIds.
  void droppedTxRecordCount;

  opts.onProgress?.({ percent: 100, phase: "Analysis complete" });

  return {
    droppedRecordIds,
    droppedAddresses,
    keptAddresses,
    droppedTxids,
    counts,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// 3. Row filters shared by plan counting and the export stream
// ---------------------------------------------------------------------------

export interface CompactRowFilters {
  dropRecord(row: VaultRecord): boolean;
  // Returns the row to write for a KEPT record — scrubs a
  // `discoveredFromRecordId` that points at a dropped record so the backup
  // never carries a dangling pointer.
  scrubRecord(row: VaultRecord): VaultRecord;
  dropParticipant(row: TransactionParticipant): boolean;
  dropTransaction(row: BlockchainTransaction): boolean;
  dropSyncState(row: AddressSyncState): boolean;
  dropLineage(row: UtxoLineage): boolean;
  dropSegment(row: CustodySegment): boolean;
}

export function compactRowFilters(plan: CompactPlan): CompactRowFilters {
  const { droppedRecordIds, droppedAddresses, keptAddresses, droppedTxids } = plan;
  const txDropped = (txid: unknown): boolean =>
    typeof txid === "string" && txid !== "" && droppedTxids.has(txid);
  const addressKept = (address: unknown): boolean =>
    typeof address === "string" && address !== "" && keptAddresses.has(address);
  return {
    dropRecord: (row) => typeof row.id === "number" && droppedRecordIds.has(row.id),
    scrubRecord: (row) => {
      if (
        typeof row.discoveredFromRecordId === "number" &&
        droppedRecordIds.has(row.discoveredFromRecordId)
      ) {
        const { discoveredFromRecordId: _dropped, ...rest } = row;
        return rest as VaultRecord;
      }
      return row;
    },
    // Participants/transactions drop with their txid: the txid is dropped only
    // when NO kept record participates (see computeCompactPlan pass 2), so the
    // rows removed here are pure discovery-only history.
    dropParticipant: (row) => txDropped(row.txid),
    dropTransaction: (row) => txDropped(row.txid),
    dropSyncState: (row) =>
      typeof row.address === "string" &&
      row.address !== "" &&
      droppedAddresses.has(row.address),
    // Lineage/custody rows drop only when EVERY involved txid is dropped and
    // NO involved address belongs to a kept record — strictly conservative, so
    // anything touching kept history survives.
    dropLineage: (row) =>
      txDropped(row.spentTxid) &&
      txDropped(row.consumingTxid) &&
      txDropped(row.createdTxid) &&
      !addressKept(row.spentAddress) &&
      !addressKept(row.createdAddress),
    dropSegment: (row) => {
      if (!txDropped(row.originTxid)) return false;
      if (addressKept(row.originAddress) || addressKept(row.currentAddress)) return false;
      if (typeof row.currentTxid === "string" && row.currentTxid !== "" && !txDropped(row.currentTxid)) {
        return false;
      }
      const evidence = Array.isArray(row.evidenceTxids) ? row.evidenceTxids : [];
      for (const txid of evidence) {
        if (!txDropped(txid)) return false;
      }
      return true;
    },
  };
}
