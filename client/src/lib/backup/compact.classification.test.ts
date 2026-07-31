// @vitest-environment jsdom
//
// Unit tests for the compact-backup field classification, the prunability
// predicate, and the shared row filters (client/src/lib/backup/compact.ts).
//
// The field classification is compile-time frozen: RECORD_FIELD_CLASSIFICATION
// is typed `[K in keyof Required<Record>]`, so adding a Record field without
// classifying it fails `npm run check`. These tests pin the runtime half of
// that freeze:
//   - the 'special' class must stay exactly {owner, date} — the only fields
//     recordHasUserMetadata special-cases; a new 'special' entry without a
//     matching branch would silently fall through, so the test locks the list;
//   - every classification value must be one of the four known classes;
//   - the predicate's behavior per class, including the fail-safe that keeps
//     records carrying UNKNOWN runtime fields (e.g. legacy stragglers).

import "fake-indexeddb/auto";

import { describe, it, expect } from "vitest";

import {
  RECORD_FIELD_CLASSIFICATION,
  MACHINE_DEFAULT_OWNER,
  recordHasUserMetadata,
  isPrunableRecordShape,
  compactRowFilters,
  type CompactFieldClass,
  type CompactPlan,
} from "./compact";
import type {
  Record as VaultRecord,
  TransactionParticipant,
  BlockchainTransaction,
  AddressSyncState,
  UtxoLineage,
  CustodySegment,
} from "@/lib/db-types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A bare blockchain-discovered ADDRESS record with EVERY machine + identity
// field populated — the exact shape deep discovery mass-produces (inherited
// wallet metadata, cached stats, discovery pointers). None of these fields may
// count as user metadata, or compact backups would never prune anything.
const BARE_ADDRESS = {
  id: 7,
  type: "address",
  inputString: "bc1q-bare-discovered-000000000000000000000",
  inputStringLower: "bc1q-bare-discovered-000000000000000000000",
  label: "",
  tags: [] as string[],
  categories: [] as string[],
  owner: "Pending Review",
  source: "blockchain-sync",
  syncDepth: 2,
  maxSyncedDepth: 1,
  discoveredInTxid: "ab".repeat(32),
  discoveredFromRecordId: 3,
  addressImportance: "blockchain-discovered",
  firstSeenBlockTime: 1_700_000_000,
  walletName: "Inherited Wallet",
  seedName: "Inherited Seed",
  walletSoftware: "Sparrow",
  cachedBalanceSats: 12_345,
  cachedTxCount: 7,
  cachedLastActivityTime: 1_700_000_001,
  statsComputedAt: 1_700_000_002_000,
  cachedUtxoCount: 2,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
};

// A bare sync-created TRANSACTION record. deriveAddressImportance stamps the
// blockchain-discovered tier on these via source === 'blockchain-sync', and
// sync sets `date` from the block time — so `date` must NOT count as user
// metadata on transaction records.
const BARE_TX = {
  id: 8,
  type: "transaction",
  inputString: "cd".repeat(32),
  inputStringLower: "cd".repeat(32),
  label: "",
  tags: [] as string[],
  categories: [] as string[],
  owner: "Pending Review",
  source: "blockchain-sync",
  syncDepth: 1,
  date: "2024-05-01",
  addressImportance: "blockchain-discovered",
  firstSeenBlockTime: 1_700_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
};

function addr(overrides: { [k: string]: unknown } = {}): VaultRecord {
  return { ...BARE_ADDRESS, ...overrides } as unknown as VaultRecord;
}
function txRec(overrides: { [k: string]: unknown } = {}): VaultRecord {
  return { ...BARE_TX, ...overrides } as unknown as VaultRecord;
}

// ---------------------------------------------------------------------------
// Classification freeze
// ---------------------------------------------------------------------------

describe("RECORD_FIELD_CLASSIFICATION (runtime freeze)", () => {
  it("uses only the four known classes", () => {
    const valid: CompactFieldClass[] = ["identity", "machine", "user", "special"];
    for (const [key, cls] of Object.entries(RECORD_FIELD_CLASSIFICATION)) {
      expect(valid, `field "${key}" has unknown class "${cls}"`).toContain(cls);
    }
  });

  it("keeps 'special' at exactly {owner, date} — the only fields the predicate special-cases", () => {
    const specials = Object.entries(RECORD_FIELD_CLASSIFICATION)
      .filter(([, cls]) => cls === "special")
      .map(([k]) => k)
      .sort();
    expect(specials).toEqual(["date", "owner"]);
  });

  it("classifies every field the bare fixtures carry (fixtures stay in sync with the schema)", () => {
    for (const key of [...Object.keys(BARE_ADDRESS), ...Object.keys(BARE_TX)]) {
      expect(
        RECORD_FIELD_CLASSIFICATION,
        `fixture field "${key}" is not classified`,
      ).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// recordHasUserMetadata
// ---------------------------------------------------------------------------

describe("recordHasUserMetadata", () => {
  it("a bare discovered address with every machine field populated has NO user metadata", () => {
    expect(recordHasUserMetadata(addr())).toBe(false);
  });

  it("a bare sync-created transaction record has NO user metadata (date is machine there)", () => {
    expect(recordHasUserMetadata(txRec())).toBe(false);
  });

  it("EVERY user-class field trips the predicate when meaningful (loop derived from the classification)", () => {
    // Values chosen per field shape; anything not listed gets a plain string.
    const sample: { [k: string]: unknown } = {
      tags: ["a-tag"],
      categories: ["a-category"],
      customFields: { "custom-slug": "v" },
      vault: { name: "V" },
      conflictResolutions: { field: { chosenValue: "x" } },
      amount: 0, // numeric zero is deliberately meaningful (conservative)
      costBasisUsd: 0,
    };
    const userKeys = Object.entries(RECORD_FIELD_CLASSIFICATION)
      .filter(([, cls]) => cls === "user")
      .map(([k]) => k);
    expect(userKeys.length).toBeGreaterThan(0);
    for (const key of userKeys) {
      const value = key in sample ? sample[key] : "user-set-value";
      expect(
        recordHasUserMetadata(addr({ [key]: value })),
        `user field "${key}" should count as metadata`,
      ).toBe(true);
    }
  });

  it("EMPTY user values do not count (blank label, empty arrays, empty customFields)", () => {
    expect(
      recordHasUserMetadata(
        addr({ label: "", notes: "   ", tags: [], categories: [], customFields: {} }),
      ),
    ).toBe(false);
  });

  it("owner: machine default (incl. padded) is not metadata; any other owner is", () => {
    expect(recordHasUserMetadata(addr({ owner: MACHINE_DEFAULT_OWNER }))).toBe(false);
    expect(recordHasUserMetadata(addr({ owner: `  ${MACHINE_DEFAULT_OWNER}  ` }))).toBe(false);
    expect(recordHasUserMetadata(addr({ owner: "" }))).toBe(false);
    expect(recordHasUserMetadata(addr({ owner: "Alice" }))).toBe(true);
  });

  it("date: machine-stamped on transaction records, user-set on address records", () => {
    expect(recordHasUserMetadata(txRec({ date: "2024-05-01" }))).toBe(false);
    expect(recordHasUserMetadata(addr({ date: "2024-05-01" }))).toBe(true);
  });

  it("UNKNOWN runtime fields fail safe: meaningful value keeps the record", () => {
    expect(recordHasUserMetadata(addr({ _legacyEncryptedPayload: "ciphertext" }))).toBe(true);
    expect(recordHasUserMetadata(addr({ _legacyEncryptedPayload: "" }))).toBe(false);
    expect(recordHasUserMetadata(addr({ someFutureField: 42 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPrunableRecordShape
// ---------------------------------------------------------------------------

describe("isPrunableRecordShape", () => {
  it("bare blockchain-discovered address and transaction records are prunable", () => {
    expect(isPrunableRecordShape(addr())).toBe(true);
    expect(isPrunableRecordShape(txRec())).toBe(true);
  });

  it("only the EXACT 'blockchain-discovered' tier is prunable — never pending-review, curated, or legacy-null", () => {
    for (const tier of ["manual", "pending-review", "xpub-derived"]) {
      expect(
        isPrunableRecordShape(addr({ addressImportance: tier })),
        `tier "${tier}" must not be prunable`,
      ).toBe(false);
    }
    // Legacy records predate the tier field entirely: null/undefined counts as
    // curated (see isUserCuratedImportance) and must never be pruned.
    expect(isPrunableRecordShape(addr({ addressImportance: undefined }))).toBe(false);
    const noTier = addr();
    delete (noTier as unknown as { [k: string]: unknown }).addressImportance;
    expect(isPrunableRecordShape(noTier)).toBe(false);
  });

  it("record types other than address/transaction are never prunable", () => {
    expect(isPrunableRecordShape(addr({ type: "other" }))).toBe(false);
  });

  it("any user metadata blocks pruning", () => {
    expect(isPrunableRecordShape(addr({ notes: "checked this one" }))).toBe(false);
    expect(isPrunableRecordShape(txRec({ label: "interesting flow" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compactRowFilters (shared by plan counting AND the export stream)
// ---------------------------------------------------------------------------

function mkPlan(p: {
  droppedRecordIds?: number[];
  droppedAddresses?: string[];
  keptAddresses?: string[];
  droppedTxids?: string[];
}): CompactPlan {
  const zero = () => ({
    records: 0,
    blockchainTransactions: 0,
    transactionParticipants: 0,
    addressSyncState: 0,
    utxoLineage: 0,
    custodySegments: 0,
  });
  return {
    droppedRecordIds: new Set(p.droppedRecordIds ?? []),
    droppedAddresses: new Set(p.droppedAddresses ?? []),
    keptAddresses: new Set(p.keptAddresses ?? []),
    droppedTxids: new Set(p.droppedTxids ?? []),
    counts: zero(),
    dropped: zero(),
  };
}

describe("compactRowFilters", () => {
  const filters = compactRowFilters(
    mkPlan({
      droppedRecordIds: [2],
      droppedAddresses: ["dAddr"],
      keptAddresses: ["kAddr"],
      droppedTxids: ["dTx1", "dTx2"],
    }),
  );

  const part = (p: { [k: string]: unknown }): TransactionParticipant =>
    p as unknown as TransactionParticipant;
  const tx = (t: { [k: string]: unknown }): BlockchainTransaction =>
    t as unknown as BlockchainTransaction;
  const sync = (s: { [k: string]: unknown }): AddressSyncState =>
    s as unknown as AddressSyncState;
  const lineage = (l: { [k: string]: unknown }): UtxoLineage => l as unknown as UtxoLineage;
  const segment = (s: { [k: string]: unknown }): CustodySegment =>
    s as unknown as CustodySegment;

  it("dropRecord: only ids in the dropped set", () => {
    expect(filters.dropRecord(addr({ id: 2 }))).toBe(true);
    expect(filters.dropRecord(addr({ id: 3 }))).toBe(false);
    expect(filters.dropRecord(addr({ id: undefined }))).toBe(false);
  });

  it("scrubRecord: removes discoveredFromRecordId only when it points at a dropped record", () => {
    const scrubbed = filters.scrubRecord(addr({ discoveredFromRecordId: 2 }));
    expect("discoveredFromRecordId" in (scrubbed as unknown as object)).toBe(false);

    const kept = filters.scrubRecord(addr({ discoveredFromRecordId: 3 }));
    expect(kept.discoveredFromRecordId).toBe(3);

    const noPointer = addr();
    delete (noPointer as unknown as { [k: string]: unknown }).discoveredFromRecordId;
    expect(filters.scrubRecord(noPointer)).toBe(noPointer); // untouched rows pass through
  });

  it("dropParticipant / dropTransaction: by dropped txid; blank txids are never dropped", () => {
    expect(filters.dropParticipant(part({ txid: "dTx1" }))).toBe(true);
    expect(filters.dropParticipant(part({ txid: "kTx" }))).toBe(false);
    expect(filters.dropParticipant(part({ txid: "" }))).toBe(false);
    expect(filters.dropTransaction(tx({ txid: "dTx2" }))).toBe(true);
    expect(filters.dropTransaction(tx({ txid: "kTx" }))).toBe(false);
  });

  it("dropSyncState: by dropped address only", () => {
    expect(filters.dropSyncState(sync({ address: "dAddr" }))).toBe(true);
    expect(filters.dropSyncState(sync({ address: "kAddr" }))).toBe(false);
    expect(filters.dropSyncState(sync({ address: "unknown" }))).toBe(false);
    expect(filters.dropSyncState(sync({ address: "" }))).toBe(false);
  });

  it("dropLineage: only when EVERY txid is dropped and NO address is kept", () => {
    const base = {
      spentTxid: "dTx1",
      consumingTxid: "dTx2",
      createdTxid: "dTx2",
      spentAddress: "dAddr",
      createdAddress: "nobody",
    };
    expect(filters.dropLineage(lineage(base))).toBe(true);
    expect(filters.dropLineage(lineage({ ...base, consumingTxid: "kTx" }))).toBe(false);
    expect(filters.dropLineage(lineage({ ...base, spentAddress: "kAddr" }))).toBe(false);
    expect(filters.dropLineage(lineage({ ...base, createdAddress: "kAddr" }))).toBe(false);
  });

  it("dropSegment: origin, current, every evidence txid dropped, and no kept address", () => {
    const base = {
      originTxid: "dTx1",
      originAddress: "dAddr",
      evidenceTxids: ["dTx1", "dTx2"],
    };
    expect(filters.dropSegment(segment(base))).toBe(true);
    expect(filters.dropSegment(segment({ ...base, evidenceTxids: ["dTx1", "kTx"] }))).toBe(false);
    expect(filters.dropSegment(segment({ ...base, currentTxid: "kTx" }))).toBe(false);
    expect(filters.dropSegment(segment({ ...base, currentTxid: "dTx2" }))).toBe(true);
    expect(filters.dropSegment(segment({ ...base, currentAddress: "kAddr" }))).toBe(false);
    expect(filters.dropSegment(segment({ ...base, originAddress: "kAddr" }))).toBe(false);
    expect(filters.dropSegment(segment({ ...base, originTxid: "kTx" }))).toBe(false);
    expect(filters.dropSegment(segment({ ...base, evidenceTxids: [] }))).toBe(true);
  });
});
