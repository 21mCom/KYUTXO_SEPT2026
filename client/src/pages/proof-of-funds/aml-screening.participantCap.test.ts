// Pins the AML participant-cap behavior in runAmlScreening.
//
// On huge vaults, 2000 txids × hundreds of participants per txid can balloon
// the loaded participant set to millions of rows and freeze the UI. The
// screening therefore caps total loaded participants at 100k, warns via
// console.warn, and continues with a partial graph instead of throwing.
// A refactor that silently drops the cap would reintroduce the freeze — this
// suite mocks the participant loaders to return oversized batches and asserts:
//   1. the loader loop STOPS once the cap is reached (later batches never
//      requested),
//   2. the graph is built from at most MAX_TOTAL_PARTICIPANTS rows (observed
//      via the address set handed to lookupEntities),
//   3. a console.warn fires mentioning the cap, and
//   4. the screening still resolves with hasGraphData: true.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TransactionParticipant } from "@/lib/db-types";

const lookupEntitiesMock = vi.fn((_addrs: string[]) => new Map());

vi.mock("@/lib/privacy-entity-list", () => ({
  lookupEntities: (addrs: string[]) => lookupEntitiesMock(addrs),
  getActiveEntityCount: () => 0,
  getActiveEntitySource: () => "bundled" as const,
  ENTITY_CATEGORY_LABELS: {},
}));

vi.mock("@/lib/data/settings-crud", () => ({
  getSettings: vi.fn(async () => null),
}));

const getParticipantsByTxidsMock = vi.fn();
vi.mock("@/lib/data/transaction-crud", () => ({
  getParticipantsByTxids: (txids: string[]) => getParticipantsByTxidsMock(txids),
}));

const getParticipantsByAddressesWithOutpointSpendsMock = vi.fn();
vi.mock("@/lib/data/record-queries", () => ({
  getParticipantsByAddressesWithOutpointSpends: (addrs: string[]) =>
    getParticipantsByAddressesWithOutpointSpendsMock(addrs),
}));

import { runAmlScreening } from "./aml-screening";

const MAX_TOTAL_PARTICIPANTS = 100_000;
const BATCH = 500;

function ownParticipant(i: number): TransactionParticipant {
  return {
    txid: `owntxid${String(i).padStart(8, "0")}`,
    role: "output",
    address: "bc1qowned0000000000000000000000000000000000",
    amount: 1000,
    vout: 0,
  };
}

let participantSeq = 0;
function oversizedBatch(txids: string[], perTxid: number): TransactionParticipant[] {
  const out: TransactionParticipant[] = [];
  for (const txid of txids) {
    for (let j = 0; j < perTxid; j++) {
      out.push({
        txid,
        role: "output",
        // Unique address per row so the capped participant count is
        // observable via the graph address set passed to lookupEntities.
        address: `bc1qpart${String(participantSeq++).padStart(10, "0")}`,
        amount: 1,
        vout: j,
      });
    }
  }
  return out;
}

describe("runAmlScreening participant cap", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    participantSeq = 0;
    lookupEntitiesMock.mockClear();
    getParticipantsByTxidsMock.mockClear();
    getParticipantsByAddressesWithOutpointSpendsMock.mockClear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("stops loading at the cap, warns, and still returns a graph result", async () => {
    // 2000 unique own txids → 4 batches of 500. Each batch returns
    // 500 × 120 = 60,000 participants, so the 100k cap is hit inside the
    // second batch; batches 3 and 4 must never be requested.
    const own = Array.from({ length: 2000 }, (_, i) => ownParticipant(i));
    getParticipantsByAddressesWithOutpointSpendsMock.mockResolvedValue(own);
    getParticipantsByTxidsMock.mockImplementation(async (txids: string[]) =>
      oversizedBatch(txids, 120),
    );

    const result = await runAmlScreening(["bc1qowned0000000000000000000000000000000000"]);

    // Loader loop stopped after the cap-hitting batch.
    expect(getParticipantsByTxidsMock).toHaveBeenCalledTimes(2);
    expect(getParticipantsByTxidsMock.mock.calls[0][0]).toHaveLength(BATCH);

    // console.warn fired mentioning the cap.
    expect(warnSpy).toHaveBeenCalled();
    const warnText = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warnText).toContain(String(MAX_TOTAL_PARTICIPANTS));
    expect(warnText).toContain("partial graph");

    // Graph built from at most MAX_TOTAL_PARTICIPANTS rows: every mocked
    // participant carries a unique address, so the graph-address lookup
    // (second lookupEntities call) sees exactly the capped row count.
    expect(lookupEntitiesMock).toHaveBeenCalledTimes(2);
    const graphAddresses = lookupEntitiesMock.mock.calls[1][0];
    expect(graphAddresses.length).toBe(MAX_TOTAL_PARTICIPANTS);

    // Screening completed rather than throwing, with graph data present.
    expect(result.hasGraphData).toBe(true);
    expect(result.screenedCount).toBe(1);
    expect(result.nearestHopDistance).toBeNull();
  });

  it("does not warn or truncate when under the cap", async () => {
    const own = Array.from({ length: 10 }, (_, i) => ownParticipant(i));
    getParticipantsByAddressesWithOutpointSpendsMock.mockResolvedValue(own);
    getParticipantsByTxidsMock.mockImplementation(async (txids: string[]) =>
      oversizedBatch(txids, 3),
    );

    const result = await runAmlScreening(["bc1qowned0000000000000000000000000000000000"]);

    expect(getParticipantsByTxidsMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    const graphAddresses = lookupEntitiesMock.mock.calls[1][0];
    expect(graphAddresses.length).toBe(30);
    expect(result.hasGraphData).toBe(true);
  });
});
