import { describe, expect, it, vi } from "vitest";

const { listCalls, recordLookup } = vi.hoisted(() => ({
  listCalls: [] as Array<{ table: string; cursor: string | number | undefined; limit: number }>,
  recordLookup: vi.fn(),
}));

vi.mock("@/lib/repository", () => ({
  getVaultRepository: () => ({
    kind: "protected",
    list: async (table: string, options: { cursor?: string | number; limit: number }) => {
      listCalls.push({ table, cursor: options.cursor, limit: options.limit });
      if (table === "addressOwnership") {
        return options.cursor === undefined
          ? {
            rows: [
              { recordId: 1, state: "assigned", entityId: 7 },
              { recordId: 3, state: "undetermined", entityId: 9 },
            ],
            cursor: "ownership-page-2",
          }
          : { rows: [{ recordId: 2, state: "assigned", entityId: 8 }] };
      }
      if (table === "entities") {
        return options.cursor === undefined
          ? { rows: [{ id: 7, name: "Alice" }], cursor: "entity-page-2" }
          : { rows: [{ id: 8, name: "Bob" }] };
      }
      return { rows: [] };
    },
  }),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByInputStrings: recordLookup,
}));

import { loadConfirmedOwnerByAddress } from "./privacy-audit";

describe("confirmed ownership loading in the protected repository", () => {
  it("uses bounded repository pages and excludes ownership that is not assigned", async () => {
    recordLookup.mockImplementation(async (addresses: string[]) =>
      addresses.map((inputString, index) => ({
        id: inputString === "address-1" ? 1 : inputString === "address-2" ? 2 : index + 3,
        inputString,
      })),
    );
    const addresses = Array.from({ length: 1001 }, (_, index) => `address-${index + 1}`);

    await expect(loadConfirmedOwnerByAddress(addresses)).resolves.toEqual(
      new Map([["address-1", "Alice"], ["address-2", "Bob"]]),
    );
    expect(recordLookup).toHaveBeenCalledTimes(2);
    expect(recordLookup.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1]);
    expect(listCalls).toEqual([
      { table: "addressOwnership", cursor: undefined, limit: 1000 },
      { table: "addressOwnership", cursor: "ownership-page-2", limit: 1000 },
      { table: "entities", cursor: undefined, limit: 1000 },
      { table: "entities", cursor: "entity-page-2", limit: 1000 },
    ]);
  });
});