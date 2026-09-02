// @vitest-environment jsdom
//
// Regression guard proving that MERGE-mode restore is idempotent at the row
// level: merging the SAME backup twice never doubles any user-data table.
//
// The real merge path lives in SettingsPage's `handleRestore` (restoreMode ===
// "merge"). Unlike the v3 streaming restore (which always clears the vault and
// runs in "replace" mode), merge mode does NOT clear anything — it layers the
// backup on top of whatever is already there, relying on each table's per-row
// de-dup (records by inputString, vocabulary by name, attachments by
// objectStoragePath, transactions by txid, etc.). If any one of those de-dup
// guards regresses — or a NEW table is wired into the merge restore without one
// — re-importing the same backup would silently accumulate duplicate rows.
//
// This test mirrors that merge orchestration (the same `restoreLegacy*` helpers
// SettingsPage calls, in the same order) in `mergeRestoreAll`, then:
//   1. seeds a representative vault covering every table the backup carries,
//   2. snapshots the whole vault into a backup object,
//   3. clears the vault,
//   4. merge-restores the backup into the empty vault (pass 1) and records the
//      per-table row counts,
//   5. merge-restores the IDENTICAL backup again (pass 2) and records the counts,
//   6. asserts every table has the same count after pass 2 as after pass 1.
//
// The snapshot, clear, and count steps all iterate `db.tables` generically, so a
// NEW table added to the schema + backup naturally falls under coverage: once it
// is seeded and wired into `mergeRestoreAll` (mirroring production), its counts
// are compared automatically with no change to the assertion loop.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import { db } from "@/lib/database";
import {
  restoreLegacyRecords,
  restoreLegacyAttachments,
  restoreLegacyTransactions,
  restoreLegacyAddressSyncState,
} from "./legacy-restore";
import {
  restoreLegacyVocabulary,
  restoreLegacyCustomFields,
  restoreLegacyDerivationTemplates,
  restoreLegacyEvidence,
  restoreLegacyPriceData,
  restoreLegacyLineage,
} from "./legacy-restore-misc";
import { restoreNodeSettingsRows, restoreSettingsPreferences } from "./inline-tables";

type Backup = Record<string, any[]>;

// A representative backup: one or more rows in every table the KYUTXO backup
// format carries and the merge path restores. Records (and the dependent rows
// that reference them) use explicit ids so the foreign-key links survive the
// snapshot; restore strips these ids and remaps the references to fresh ones.
const SEED: Backup = {
  records: [
    { id: 1, type: "address", inputString: "addr-1", inputStringLower: "addr-1", label: "R1", tags: [], categories: [], createdAt: 1, updatedAt: 1 },
    { id: 2, type: "address", inputString: "addr-2", inputStringLower: "addr-2", label: "R2", tags: [], categories: [], createdAt: 1, updatedAt: 1 },
  ],
  tags: [
    { id: 1, name: "tag-1", color: "#888888", createdAt: 1 },
    { id: 2, name: "tag-2", color: "#999999", createdAt: 1 },
  ],
  categories: [{ id: 1, name: "cat-1", createdAt: 1 }],
  owners: [{ id: 1, name: "owner-1", createdAt: 1 }],
  walletNames: [{ id: 1, name: "wallet-1", createdAt: 1 }],
  seedNames: [{ id: 1, name: "seed-1", createdAt: 1 }],
  walletSoftware: [{ id: 1, name: "sw-1", createdAt: 1 }],
  attachments: [
    { id: 1, recordId: 1, filename: "a.pdf", mimeType: "application/pdf", size: 10, objectStoragePath: "hash-a", createdAt: 1 },
    { id: 2, recordId: 2, filename: "b.pdf", mimeType: "application/pdf", size: 20, objectStoragePath: "hash-b", createdAt: 1 },
  ],
  customFields: [{ id: 1, slug: "cf-1", label: "CF1", type: "text", enabled: true, createdAt: 1 }],
  derivationTemplates: [
    { id: 1, fingerprint: "abcd1234", scriptType: "P2WPKH", derivationPath: "m/84'/0'/0'", gapLimit: 20, network: "mainnet", createdAt: 1, updatedAt: 1 },
  ],
  evidence: [
    { id: 1, title: "Ev1", documentType: "invoice", originalDate: "2024-01-01", tags: [], partiesInvolved: [], createdAt: 1, updatedAt: 1 },
  ],
  evidenceAttachments: [
    { id: 1, evidenceId: 1, filename: "e.pdf", mimeType: "application/pdf", size: 5, objectStoragePath: "ev-hash-a", createdAt: 1 },
  ],
  priceData: [
    { id: 1, date: "2024-01-01", currency: "USD", asset: "BTC", price: 50000, source: "test", importedAt: 1 },
  ],
  nodeSettings: [{ id: "default", nodeType: "public", proxyEnabled: false }],
  settings: [{ id: "default", disableOrphanCheck: true }],
  utxoLineage: [
    { id: 1, spentTxid: "stx", spentVout: 0, createdTxid: "ctx", createdVout: 1, consumingTxid: "ctx", spentAddress: "addr-1", createdAddress: "addr-2", segmentId: "seg-1", spentOwned: true, createdOwned: true, isChange: false, blockTime: 1_700_000_000 },
  ],
  custodySegments: [
    { id: 1, segmentId: "seg-1", originTxid: "stx", originVout: 0, originAddress: "addr-1", currentAddress: "addr-2", status: "active", originDate: "2024-01-01" },
  ],
  blockchainTransactions: [
    { id: 1, txid: "tx-1", blockHeight: 800000, blockTime: 1_700_000_000, fee: 1000, feeRate: 5, syncedAt: 1_700_000_100 },
  ],
  transactionParticipants: [
    { id: 1, txid: "tx-1", role: "output", address: "addr-1", amount: 5000, recordId: 1 },
    { id: 2, txid: "tx-1", role: "input", address: "addr-x", amount: 6000 },
  ],
  addressSyncState: [
    { id: 1, address: "addr-1", recordId: 1, lastSyncedHeight: 800000, lastSyncedAt: 1_700_000_000, txCount: 3 },
  ],
};

// Mirror of SettingsPage `handleRestore`'s merge orchestration: the same shared
// `restoreLegacy*` (+ node/settings) helpers, in the same order, sharing one
// recordId map so dependent rows relink to the restored records. Keeping this in
// lock-step with production is what makes the idempotence assertion meaningful.
async function mergeRestoreAll(data: Backup): Promise<void> {
  const recordIdMap = new Map<number, number>();
  await restoreLegacyRecords(data.records, "merge", recordIdMap);
  await restoreLegacyVocabulary(
    {
      tags: data.tags,
      categories: data.categories,
      owners: data.owners,
      walletNames: data.walletNames,
      seedNames: data.seedNames,
      walletSoftware: data.walletSoftware,
    },
    "merge",
  );
  await restoreLegacyAttachments(data.attachments, "merge", recordIdMap);
  await restoreLegacyCustomFields(data.customFields, "merge");
  await restoreLegacyDerivationTemplates(data.derivationTemplates, "merge");
  await restoreLegacyEvidence(data.evidence, data.evidenceAttachments, "merge");
  await restoreLegacyPriceData(data.priceData, "merge");
  await restoreNodeSettingsRows(data.nodeSettings ?? []);
  await restoreSettingsPreferences(data.settings ?? []);
  await restoreLegacyLineage(data.utxoLineage, data.custodySegments, "merge");
  await restoreLegacyTransactions(
    data.blockchainTransactions,
    data.transactionParticipants,
    "merge",
    recordIdMap,
  );
  await restoreLegacyAddressSyncState(data.addressSyncState, "merge", recordIdMap);
}

// Generic vault operations over `db.tables` — these are the pieces that let a new
// table fall under coverage without editing the assertions.
async function snapshotVault(): Promise<Backup> {
  const out: Backup = {};
  for (const table of db.tables) out[table.name] = await table.toArray();
  return out;
}

async function clearVault(): Promise<void> {
  for (const table of db.tables) await table.clear();
}

async function countAllTables(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of db.tables) out[table.name] = await table.count();
  return out;
}

async function seedVault(seed: Backup): Promise<void> {
  for (const [name, rows] of Object.entries(seed)) {
    if (rows.length > 0) await db.table(name).bulkAdd(rows);
  }
}

beforeEach(async () => {
  await clearVault();
});

describe("merge restore: merging the same backup twice never doubles a table", () => {
  it("every user-data table has identical row counts after the first and second merge restore", async () => {
    // Build a representative backup by snapshotting a fully-seeded vault, then
    // start from an empty vault so pass 1 establishes the baseline.
    await seedVault(SEED);
    const backup = await snapshotVault();
    await clearVault();

    // Pass 1: merge into the empty vault.
    await mergeRestoreAll(backup);
    const countsAfterFirst = await countAllTables();

    // Sanity: the merge actually restored data, so the idempotence check below
    // is not vacuously passing over empty tables.
    const totalAfterFirst = Object.values(countsAfterFirst).reduce((a, b) => a + b, 0);
    expect(totalAfterFirst).toBeGreaterThan(0);
    expect(countsAfterFirst.records).toBe(2);
    expect(countsAfterFirst.blockchainTransactions).toBe(1);
    expect(countsAfterFirst.transactionParticipants).toBe(2);
    expect(countsAfterFirst.evidence).toBe(1);
    expect(countsAfterFirst.utxoLineage).toBe(1);

    // Pass 2: merge the IDENTICAL backup again. Nothing should be added.
    await mergeRestoreAll(backup);
    const countsAfterSecond = await countAllTables();

    // Generic per-table invariant: no table grew on the second merge. Iterating
    // the union of table names means a newly added table is compared too.
    const allTables = new Set([
      ...Object.keys(countsAfterFirst),
      ...Object.keys(countsAfterSecond),
    ]);
    for (const name of allTables) {
      expect(
        countsAfterSecond[name],
        `table "${name}" row count doubled on the second merge restore ` +
          `(${countsAfterFirst[name]} -> ${countsAfterSecond[name]})`,
      ).toBe(countsAfterFirst[name]);
    }
  });
});
