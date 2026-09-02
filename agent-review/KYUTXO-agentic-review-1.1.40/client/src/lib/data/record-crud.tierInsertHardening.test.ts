// @vitest-environment jsdom
//
// Task #1740 — insert-path tier hardening.
//
// Restoring an old backup used to reintroduce invalid importance tiers:
// deriveAddressImportance honored ANY truthy provided tier verbatim, so rows
// whose backups predate the settled tier vocabulary came back with
// unrecognized strings and silently dropped out of the Dexie tier-index
// narrowing (Records browse + search). createRecord must now only honor
// RECOGNIZED tiers and otherwise re-derive from provenance — sync-provenance
// rows must land back on a hidden discovery tier (never leak into curated
// balance surfaces), user rows on a user tier.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, AddressImportance } from "@/lib/database";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
    });
  }
}

const testDb = new TestDb(`KYUTXO-tier-hardening-${Date.now()}-${Math.random()}`);

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return { ...actual, db: testDb };
});

const { createRecord, clearAllRecords } = await import("./record-crud");

// A legacy tier string no current vocabulary recognizes — the shape an old
// backup can carry.
const LEGACY_TIER = "important" as AddressImportance;

const CREATE_OPTS = { skipNotification: true, skipVocabularySync: true };

beforeEach(async () => {
  await clearAllRecords();
});

afterAll(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("createRecord tier hardening", () => {
  it("honors a provided tier when it is one of the recognized values", async () => {
    const id = await createRecord(
      { type: "address", inputString: "bc1qvalid000001", addressImportance: "verified" },
      CREATE_OPTS,
    );
    const row = await testDb.records.get(id);
    expect(row?.addressImportance).toBe("verified");
  });

  it("ignores an unrecognized tier and derives 'manual' when there is no provenance", async () => {
    const id = await createRecord(
      { type: "address", inputString: "bc1qLegacy00002", addressImportance: LEGACY_TIER },
      CREATE_OPTS,
    );
    const row = await testDb.records.get(id);
    expect(row?.addressImportance).toBe("manual");
    // buildFullRecord still derives the search key on every insert.
    expect(row?.inputStringLower).toBe("bc1qlegacy00002");
  });

  it("ignores an unrecognized tier and keeps sync-provenance rows on a hidden discovery tier", async () => {
    const bySyncDepth = await createRecord(
      {
        type: "address",
        inputString: "bc1qsync0000003",
        addressImportance: LEGACY_TIER,
        syncDepth: 2,
      },
      CREATE_OPTS,
    );
    expect((await testDb.records.get(bySyncDepth))?.addressImportance).toBe(
      "blockchain-discovered",
    );

    const bySource = await createRecord(
      {
        type: "address",
        inputString: "bc1qsync0000004",
        addressImportance: LEGACY_TIER,
        source: "blockchain-sync",
      },
      CREATE_OPTS,
    );
    expect((await testDb.records.get(bySource))?.addressImportance).toBe(
      "blockchain-discovered",
    );
  });

  it("recognizes every real import source format (desktop, mobile, BIP-329)", async () => {
    // These are the exact shapes generateSourceName() writes in
    // WalletImport.tsx, MobileWalletImport.tsx, and BIP329Import.tsx —
    // display wallet names (with spaces) embedded after the marker.
    const sources = [
      "walletImport-Sparrow Wallet_2026-07-31_103000",
      "mobileImport-Phoenix Wallet_2026-07-31_103000",
      "bip329Import_2026-07-31_103000",
    ];
    for (const [i, source] of sources.entries()) {
      const id = await createRecord(
        {
          type: "address",
          inputString: `bc1qwalletsrc${i}0005`,
          addressImportance: LEGACY_TIER,
          source,
        },
        CREATE_OPTS,
      );
      expect((await testDb.records.get(id))?.addressImportance).toBe("wallet-import");
    }
  });

  it("classifies merged sources ('; '-joined) as wallet-import when any import marker is present", async () => {
    // merge-utils concatenates sources: an existing blockchain-sync row that
    // later merged a wallet import carries both markers. The user imported
    // it, so it is theirs — wallet-import, not blockchain-discovered.
    const id = await createRecord(
      {
        type: "address",
        inputString: "bc1qmergedsrc0005",
        addressImportance: LEGACY_TIER,
        source: "blockchain-sync; walletImport-Nunchuk_2026-01-01_000000",
      },
      CREATE_OPTS,
    );
    expect((await testDb.records.get(id))?.addressImportance).toBe("wallet-import");
  });

  it("keeps syncDepth precedence: a positive syncDepth stays hidden even with an import marker in source", async () => {
    const id = await createRecord(
      {
        type: "address",
        inputString: "bc1qsyncdepth0005",
        addressImportance: LEGACY_TIER,
        source: "walletImport-Sparrow Wallet_2026-01-01_000000",
        syncDepth: 3,
      },
      CREATE_OPTS,
    );
    expect((await testDb.records.get(id))?.addressImportance).toBe(
      "blockchain-discovered",
    );
  });

  it("ignores an unrecognized tier and derives xpub/descriptor provenance tiers", async () => {
    const xpubDerived = await createRecord(
      {
        type: "address",
        inputString: "bc1qxpub0000006",
        addressImportance: LEGACY_TIER,
        derivationPath: "m/84'/0'/0'/0/1",
      },
      CREATE_OPTS,
    );
    expect((await testDb.records.get(xpubDerived))?.addressImportance).toBe(
      "xpub-derived",
    );

    const descriptorDerived = await createRecord(
      {
        type: "address",
        inputString: "bc1qdescriptor0007",
        addressImportance: LEGACY_TIER,
        source: "descriptorImport-BSMS_2026-07-31_103000",
      },
      CREATE_OPTS,
    );
    expect((await testDb.records.get(descriptorDerived))?.addressImportance).toBe(
      "xpub-derived",
    );
  });
});
