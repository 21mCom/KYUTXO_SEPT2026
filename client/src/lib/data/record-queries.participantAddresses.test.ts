import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionParticipant } from "../database";

const mocks = vi.hoisted(() => ({
  kind: "dexie" as "dexie" | "protected",
  query: vi.fn(),
}));

vi.mock("../repository", () => ({
  getVaultRepository: () => ({
    kind: mocks.kind,
    query: mocks.query,
  }),
}));

vi.mock("./attachments-crud", () => ({
  addAttachment: vi.fn(),
  getAttachmentsByRecordId: vi.fn(),
}));

import { getRecordParticipantsByAddresses } from "./record-queries";

const rows: TransactionParticipant[] = [
  ...Array.from({ length: 1001 }, (_, index) => ({
    id: index + 1,
    txid: `tx-a-${index}`,
    role: "output" as const,
    address: "address-a",
  })),
  {
    id: 1002,
    txid: "tx-b-1",
    role: "output",
    address: "address-b",
  },
];

describe("getRecordParticipantsByAddresses", () => {
  beforeEach(() => {
    mocks.kind = "dexie";
    mocks.query.mockReset();
    mocks.query.mockImplementation(
      async (
        _table: string,
        name: string,
        value: { address?: string; addresses?: string[]; afterId: number },
        limit: number,
      ) => {
        const addresses = name === "participants.byAddressAfterId"
          ? new Set([value.address])
          : new Set(value.addresses);
        return rows
          .filter((row) =>
            row.id! > value.afterId && addresses.has(row.address))
          .slice(0, limit);
      },
    );
  });

  it("deduplicates Dexie address inputs while paging past 1,000 rows", async () => {
    const result = await getRecordParticipantsByAddresses([
      "address-a",
      "address-a",
      "address-b",
    ]);

    expect(result.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(mocks.query.mock.calls.map(([, , value]) => value)).toEqual([
      { address: "address-a", afterId: 0 },
      { address: "address-a", afterId: 1000 },
      { address: "address-b", afterId: 0 },
    ]);
  });

  it("passes unique addresses to the protected batched query", async () => {
    mocks.kind = "protected";

    const result = await getRecordParticipantsByAddresses([
      "address-a",
      "address-a",
      "address-b",
    ]);

    expect(result.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(mocks.query.mock.calls.map(([, , value]) => value)).toEqual([
      { addresses: ["address-a", "address-b"], afterId: 0 },
      { addresses: ["address-a", "address-b"], afterId: 1000 },
    ]);
  });
});