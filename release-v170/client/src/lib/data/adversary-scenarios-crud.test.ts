// @vitest-environment jsdom
//
// CRUD + restore-helper coverage for the adversaryScenarios table (Privacy
// Audit "what if they knew?" scenarios): save/list/update/delete/clear and
// the backup-restore de-dup contract (merge mode skips rows whose
// (name, counterparty) identity already exists, including duplicates within
// the incoming backup itself).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "vitest";

import {
  saveAdversaryScenario,
  getAllAdversaryScenarios,
  updateAdversaryScenario,
  deleteAdversaryScenario,
  clearAdversaryScenarios,
  restoreAdversaryScenarioRows,
  adversaryScenarioIdentity,
  type NewAdversaryScenario,
} from "@/lib/data/adversary-scenarios-crud";

const SCENARIO_A: NewAdversaryScenario = {
  name: "Exchange KYC leak",
  counterpartyName: "TestExchange",
  knownAddresses: ["bc1qaaa", "bc1qbbb"],
  knownTxids: ["a".repeat(64)],
};

const SCENARIO_B: NewAdversaryScenario = {
  name: "Old employer",
  counterpartyName: "ACME Corp",
  knownAddresses: ["bc1qccc"],
  knownTxids: [],
};

beforeEach(async () => {
  await clearAdversaryScenarios({ skipNotification: true });
});

describe("adversaryScenarios CRUD", () => {
  it("saves, lists newest-first, updates, and deletes scenarios", async () => {
    const idA = await saveAdversaryScenario(SCENARIO_A);
    // Ensure a distinct createdAt so the newest-first ordering is exercised.
    await new Promise((r) => setTimeout(r, 5));
    const idB = await saveAdversaryScenario(SCENARIO_B);

    let rows = await getAllAdversaryScenarios();
    expect(rows.map((r) => r.id)).toEqual([idB, idA]);
    expect(rows[1]).toMatchObject({
      name: "Exchange KYC leak",
      counterpartyName: "TestExchange",
      knownAddresses: ["bc1qaaa", "bc1qbbb"],
      knownTxids: ["a".repeat(64)],
    });
    expect(typeof rows[1].createdAt).toBe("number");
    expect(typeof rows[1].updatedAt).toBe("number");

    await updateAdversaryScenario(idA, {
      ...SCENARIO_A,
      name: "Exchange KYC leak (updated)",
      knownAddresses: ["bc1qaaa"],
    });
    rows = await getAllAdversaryScenarios();
    const updated = rows.find((r) => r.id === idA)!;
    expect(updated.name).toBe("Exchange KYC leak (updated)");
    expect(updated.knownAddresses).toEqual(["bc1qaaa"]);
    expect(updated.createdAt).toBeLessThanOrEqual(updated.updatedAt);

    await deleteAdversaryScenario(idB);
    rows = await getAllAdversaryScenarios();
    expect(rows.map((r) => r.id)).toEqual([idA]);
  });

  it("normalizes blank names and de-dupes list entries on save", async () => {
    const id = await saveAdversaryScenario({
      name: "   ",
      counterpartyName: "  Someone  ",
      knownAddresses: ["bc1qaaa", "bc1qaaa", "", "bc1qbbb"],
      knownTxids: [],
    });
    const rows = await getAllAdversaryScenarios();
    expect(rows[0].id).toBe(id);
    expect(rows[0].name).toBe("Untitled scenario");
    expect(rows[0].counterpartyName).toBe("Someone");
    expect(rows[0].knownAddresses).toEqual(["bc1qaaa", "bc1qbbb"]);
  });

  it("clear empties the table", async () => {
    await saveAdversaryScenario(SCENARIO_A);
    await clearAdversaryScenarios({ skipNotification: true });
    expect(await getAllAdversaryScenarios()).toHaveLength(0);
  });
});

describe("restoreAdversaryScenarioRows", () => {
  it("replace mode restores every row with fresh ids and preserved fields", async () => {
    const written = await restoreAdversaryScenarioRows(
      [
        { id: 99, ...SCENARIO_A, createdAt: 111, updatedAt: 222 },
        { id: 100, ...SCENARIO_B },
      ],
      "replace",
      { skipNotification: true },
    );
    expect(written).toBe(2);
    const rows = await getAllAdversaryScenarios();
    expect(rows).toHaveLength(2);
    // Backup ids are stripped (fresh autoincrement) but everything else rides.
    expect(rows.map((r) => r.id)).not.toContain(99);
    const a = rows.find((r) => r.name === SCENARIO_A.name)!;
    expect(a.createdAt).toBe(111);
    expect(a.updatedAt).toBe(222);
    expect(a.knownTxids).toEqual(["a".repeat(64)]);
  });

  it("merge mode skips existing identities and duplicates within the backup", async () => {
    await saveAdversaryScenario(SCENARIO_A);

    const collect: { insertedIds: number[] } = { insertedIds: [] };
    const written = await restoreAdversaryScenarioRows(
      [
        // Same identity as the existing scenario (case-insensitive), but with
        // different content — a merge must NOT duplicate it.
        {
          name: "exchange kyc LEAK",
          counterpartyName: "testexchange",
          knownAddresses: ["bc1qzzz"],
          knownTxids: [],
        },
        SCENARIO_B,
        // Exact duplicate of SCENARIO_B within the same backup.
        { ...SCENARIO_B },
        // Malformed rows are skipped, never fatal.
        null,
        "not an object",
      ],
      "merge",
      { skipNotification: true },
      collect,
    );

    expect(written).toBe(1);
    expect(collect.insertedIds).toHaveLength(1);
    const rows = await getAllAdversaryScenarios();
    expect(rows).toHaveLength(2);
    // The pre-existing scenario keeps its ORIGINAL content (merge never
    // overwrites), and the local-only scenario B was added exactly once.
    expect(rows.find((r) => r.name === SCENARIO_A.name)!.knownAddresses).toEqual([
      "bc1qaaa",
      "bc1qbbb",
    ]);
    expect(rows.filter((r) => r.name === SCENARIO_B.name)).toHaveLength(1);
  });

  it("identity is the case-insensitive (name, counterparty) pair", () => {
    expect(adversaryScenarioIdentity(SCENARIO_A)).toBe(
      adversaryScenarioIdentity({
        name: "  EXCHANGE kyc leak ",
        counterpartyName: "TESTEXCHANGE",
      }),
    );
    expect(adversaryScenarioIdentity(SCENARIO_A)).not.toBe(
      adversaryScenarioIdentity({ ...SCENARIO_A, counterpartyName: "Other" }),
    );
  });
});
