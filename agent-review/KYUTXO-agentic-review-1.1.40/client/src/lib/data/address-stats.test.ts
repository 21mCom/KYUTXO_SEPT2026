import { describe, it, expect } from "vitest";
import { computeUtxoCountForAddress } from "./address-stats";
import type { TransactionParticipant } from "../database";

function part(over: Partial<TransactionParticipant>): TransactionParticipant {
  return {
    txid: "tx",
    role: "output",
    address: "addr",
    amount: 1000,
    recordId: 1,
    ...over,
  } as TransactionParticipant;
}

// Every tx has a positive block time unless explicitly absent from this map.
const times: Record<string, number> = {
  o1: 100,
  o2: 200,
  o3: 300,
  spend1: 250,
  spend2: 50,
  unconf: 0,
};
const blockTimeOf = (txid: string) => times[txid] ?? 0;

describe("computeUtxoCountForAddress", () => {
  it("returns 0 when the address has no participants", () => {
    expect(computeUtxoCountForAddress([], [], blockTimeOf)).toBe(0);
  });

  it("exact mode: counts outputs not referenced by a prevout input", () => {
    const outputs = [
      part({ txid: "o1", vout: 0 }),
      part({ txid: "o2", vout: 1 }),
    ];
    // An input that spends o1:0 (carries prevout data → exact mode).
    const inputs = [
      part({ txid: "spend1", role: "input", prevTxid: "o1", prevVout: 0 }),
    ];
    // o1 spent, o2 unspent → 1 UTXO.
    expect(computeUtxoCountForAddress(outputs, inputs, blockTimeOf)).toBe(1);
  });

  it("exact mode: ignores outputs with no known block time", () => {
    const outputs = [
      part({ txid: "o1", vout: 0 }),
      part({ txid: "unconf", vout: 0 }),
    ];
    const inputs = [
      part({ txid: "spend1", role: "input", prevTxid: "zzz", prevVout: 0 }),
    ];
    // unconf output ignored; o1 not spent → 1 UTXO.
    expect(computeUtxoCountForAddress(outputs, inputs, blockTimeOf)).toBe(1);
  });

  it("heuristic mode: pairs a later same-amount input to mark an output spent", () => {
    const outputs = [
      part({ txid: "o1", amount: 5000, vout: 0 }),
      part({ txid: "o2", amount: 7000, vout: 0 }),
    ];
    // Input with no prevout data (heuristic mode), same amount as o1, later time.
    const inputs = [
      part({ txid: "spend1", role: "input", amount: 5000 }),
    ];
    // o1 (5000) matched/spent by the later input, o2 (7000) unspent → 1 UTXO.
    expect(computeUtxoCountForAddress(outputs, inputs, blockTimeOf)).toBe(1);
  });

  it("heuristic mode: an earlier input cannot spend a later output", () => {
    const outputs = [part({ txid: "o3", amount: 5000, vout: 0 })];
    // spend2 (time 50) is earlier than o3 (time 300) → cannot be its spend.
    const inputs = [part({ txid: "spend2", role: "input", amount: 5000 })];
    expect(computeUtxoCountForAddress(outputs, inputs, blockTimeOf)).toBe(1);
  });
});
