import { describe, expect, it } from "vitest";
import type { TransactionParticipant } from "./db-types";
import {
  detectMultiOwnerAddressReuse,
  detectMultiOwnerCoSpend,
  type AuditContext,
} from "./privacy-audit";

function participant(
  txid: string,
  role: "input" | "output",
  address: string,
): TransactionParticipant {
  return { txid, role, address, amount: 10_000 };
}

function context(
  participants: TransactionParticipant[],
  confirmedOwnerByAddress: Map<string, string>,
): AuditContext {
  const participantsByTxid = new Map<string, TransactionParticipant[]>();
  for (const row of participants) {
    const rows = participantsByTxid.get(row.txid) ?? [];
    rows.push(row);
    participantsByTxid.set(row.txid, rows);
  }
  return {
    userAddresses: new Set(confirmedOwnerByAddress.keys()),
    participants,
    participantsByTxid,
    transactions: new Map(),
    confirmedOwnerByAddress,
  };
}

describe("multi-owner privacy findings", () => {
  it("reports confirmed owners co-spent together with inspectable transaction and address evidence", () => {
    const alice = "bc1qalice";
    const bob = "bc1qbob";
    const ctx = context(
      [
        participant("co-spend-tx", "input", alice),
        participant("co-spend-tx", "input", bob),
      ],
      new Map([[alice, "Alice"], [bob, "Bob"]]),
    );

    expect(detectMultiOwnerCoSpend(ctx)).toEqual([
      expect.objectContaining({
        type: "MULTI_OWNER_CO_SPEND",
        txids: ["co-spend-tx"],
        addresses: [alice, bob],
        details: expect.objectContaining({
          ownerEvidence: [
            { owner: "Alice", addresses: [alice] },
            { owner: "Bob", addresses: [bob] },
          ],
        }),
      }),
    ]);
  });

  it("reports a recipient address reused by confirmed different owners with all supporting txids", () => {
    const alice = "bc1qalice";
    const bob = "bc1qbob";
    const recipient = "bc1qsharedrecipient";
    const ctx = context(
      [
        participant("alice-payment", "input", alice),
        participant("alice-payment", "output", recipient),
        participant("bob-payment", "input", bob),
        participant("bob-payment", "output", recipient),
      ],
      new Map([[alice, "Alice"], [bob, "Bob"]]),
    );

    expect(detectMultiOwnerAddressReuse(ctx)).toEqual([
      expect.objectContaining({
        type: "MULTI_OWNER_ADDRESS_REUSE",
        txids: ["alice-payment", "bob-payment"],
        addresses: [recipient, alice, bob],
        details: expect.objectContaining({
          ownerEvidence: [
            { owner: "Alice", addresses: [alice] },
            { owner: "Bob", addresses: [bob] },
          ],
        }),
      }),
    ]);
  });

  it("does not turn unknown inputs into an owner or a cross-owner finding", () => {
    const alice = "bc1qalice";
    const unknown = "bc1qunknown";
    const recipient = "bc1qsharedrecipient";
    const ctx = context(
      [
        participant("payment-one", "input", alice),
        participant("payment-one", "output", recipient),
        participant("payment-two", "input", unknown),
        participant("payment-two", "output", recipient),
        participant("co-spend", "input", alice),
        participant("co-spend", "input", unknown),
      ],
      new Map([[alice, "Alice"]]),
    );

    expect(detectMultiOwnerCoSpend(ctx)).toEqual([]);
    expect(detectMultiOwnerAddressReuse(ctx)).toEqual([]);
  });
});