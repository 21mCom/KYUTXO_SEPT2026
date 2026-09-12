// Parity guard: the Wallet Overview page aggregates per-wallet address usage
// two ways — a Dexie keyset scan folding each row through
// addRecordToWalletUsage (client/src/lib/wallet-usage.ts), and the native
// engine's getWalletUsageSummaries SQL (gated by CURATED_ADDRESS_SQL). Both
// must return IDENTICAL per-wallet numbers for the same vault contents, so
// this test runs the real emitted SQL (better-sqlite3, in-memory) and the
// real Dexie-side helper over the same fixture set.
//
// Fixtures deliberately mix user-curated tiers (verified, manual,
// wallet-import, xpub-derived), legacy NULL-importance rows, and the
// non-curated tiers sync auto-creates for counterparty addresses
// (blockchain-discovered, pending-review) which INHERIT the parent wallet's
// walletName — the rows that used to inflate Wallet Overview into the
// thousands. An unknown/future tier is included to prove both paths exclude
// it (allowlist semantics on both sides).

import "fake-indexeddb/auto";

import { describe, it, expect } from "vitest";
import { createInMemoryEngineDb } from "../better-sqlite3-adapter";
import {
  createSchema,
  insertRecords,
  getWalletUsageSummaries,
  type RecordRow,
} from "../engine-core";
import {
  addRecordToWalletUsage,
  type WalletUsageStats,
} from "@/lib/wallet-usage";

interface Fixture {
  id: number;
  walletName: string | null;
  addressImportance: string | null;
  chainType: "receive" | "change" | null;
  derivationPath: string | null;
  firstSeenBlockTime: number | null;
  discoveredInTxid: string | null;
}

function fix(over: Partial<Fixture> & { id: number }): Fixture {
  return {
    walletName: null,
    addressImportance: null,
    chainType: null,
    derivationPath: null,
    firstSeenBlockTime: null,
    discoveredInTxid: null,
    ...over,
  };
}

function toRow(f: Fixture): RecordRow {
  const inputString = `bc1qparity${String(f.id).padStart(4, "0")}`;
  return {
    id: f.id,
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label: null,
    notes: null,
    owner: null,
    walletName: f.walletName,
    seedName: null,
    walletSoftware: null,
    addressImportance: f.addressImportance,
    chainType: f.chainType,
    syncDepth: null,
    firstSeenBlockTime: f.firstSeenBlockTime,
    cachedBalanceSats: null,
    cachedTxCount: null,
    cachedUtxoCount: null,
    statsComputedAt: null,
    createdAt: f.id,
    updatedAt: f.id,
    tags: "[]",
    categories: "[]",
    derivationPath: f.derivationPath,
    discoveredInTxid: f.discoveredInTxid,
    vaultIsVaultXpub: null,
    vaultM: null,
    vaultN: null,
    vaultName: null,
    vaultNotes: null,
  };
}

const FIXTURES: Fixture[] = [
  // ── WalletAlpha: user-curated rows across every curated tier ────────────
  fix({ id: 1, walletName: "WalletAlpha", addressImportance: "manual", chainType: "receive", firstSeenBlockTime: 100 }),
  fix({ id: 2, walletName: "WalletAlpha", addressImportance: "verified", chainType: "receive" }),
  fix({ id: 3, walletName: "WalletAlpha", addressImportance: "wallet-import", chainType: "change", discoveredInTxid: "tx3" }),
  fix({ id: 4, walletName: "WalletAlpha", addressImportance: "xpub-derived", derivationPath: "m/84'/0'/0'/0/5", firstSeenBlockTime: 50 }),
  fix({ id: 5, walletName: "WalletAlpha", addressImportance: "xpub-derived", derivationPath: "m/84'/0'/0'/1/7" }),
  // Legacy row: NULL importance counts as curated on BOTH paths.
  fix({ id: 6, walletName: "WalletAlpha", addressImportance: null, chainType: "receive", firstSeenBlockTime: 5 }),
  // Fallback classification: short derivation path -> receive.
  fix({ id: 7, walletName: "WalletAlpha", addressImportance: "manual", derivationPath: "m/0" }),

  // ── WalletAlpha: non-curated rows stamped with its name by sync ─────────
  // These are the rows that used to inflate the wallet into the thousands.
  fix({ id: 8, walletName: "WalletAlpha", addressImportance: "blockchain-discovered", chainType: "receive", discoveredInTxid: "tx8" }),
  fix({ id: 9, walletName: "WalletAlpha", addressImportance: "blockchain-discovered", chainType: "change", discoveredInTxid: "tx9" }),
  fix({ id: 10, walletName: "WalletAlpha", addressImportance: "pending-review", firstSeenBlockTime: 10 }),

  // ── WalletBeta: smaller curated set + an unknown/future tier ────────────
  fix({ id: 11, walletName: "WalletBeta", addressImportance: "manual", chainType: "receive", firstSeenBlockTime: 200 }),
  fix({ id: 12, walletName: "WalletBeta", addressImportance: "verified", chainType: "change", firstSeenBlockTime: 201 }),
  fix({ id: 13, walletName: "WalletBeta", addressImportance: "some-future-tier", chainType: "receive" }),
  fix({ id: 14, walletName: "WalletBeta", addressImportance: "pending-review", chainType: "receive", discoveredInTxid: "tx14" }),

  // ── Excluded entirely: no walletName ────────────────────────────────────
  fix({ id: 15, walletName: null, addressImportance: "manual", chainType: "receive" }),
  fix({ id: 16, walletName: "", addressImportance: "manual", chainType: "change" }),
];

describe("wallet usage parity: Dexie helper vs engine SQL", () => {
  it("both paths return identical per-wallet summaries", () => {
    const db = createInMemoryEngineDb();
    createSchema(db);
    insertRecords(db, FIXTURES.map(toRow));

    const engineRows = getWalletUsageSummaries(db);

    const walletMap = new Map<string, WalletUsageStats>();
    for (const f of FIXTURES) {
      addRecordToWalletUsage(walletMap, f as never);
    }
    const dexieRows = [...walletMap.values()].sort((a, b) =>
      a.walletName.localeCompare(b.walletName),
    );

    // Engine returns rows ordered by walletName already.
    expect(engineRows).toEqual(dexieRows);

    // …and the numbers are the curated-only ones, not the inflated legacy ones.
    const alpha = engineRows.find((r) => r.walletName === "WalletAlpha")!;
    expect(alpha).toEqual({
      walletName: "WalletAlpha",
      receiveTotal: 5, // ids 1, 2 (chainType), 4 (path …/0/5), 6 (NULL tier), 7 (fallback)
      receiveUsed: 3, // ids 1, 4, 6 used
      changeTotal: 2, // ids 3 (chainType), 5 (path …/1/7)
      changeUsed: 1, // id 3
      unknownTotal: 0,
      unknownUsed: 0,
    });

    const beta = engineRows.find((r) => r.walletName === "WalletBeta")!;
    expect(beta).toEqual({
      walletName: "WalletBeta",
      receiveTotal: 1, // id 11 (future-tier 13 and pending-review 14 excluded)
      receiveUsed: 1,
      changeTotal: 1, // id 12
      changeUsed: 1,
      unknownTotal: 0,
      unknownUsed: 0,
    });

    // Non-curated rows must not appear under ANY wallet.
    expect(engineRows).toHaveLength(2);
  });
});
