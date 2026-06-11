// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const mockAttachmentsToArray = vi.fn(() => Promise.resolve([]));

const settingsWithStatsColumns = {
  tableColumns: {
    tags: false,
    categories: false,
    walletSoftware: false,
    seedName: false,
    privateKeyStatus: false,
    hasAttachments: false,
    owner: false,
    walletName: false,
    source: false,
    firstSeen: false,
    balance: true,
    lastTxDate: true,
    txCount: true,
  },
  customFieldColumns: {},
  fieldVisibility: {},
};

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    settings: settingsWithStatsColumns,
    tableColumns: settingsWithStatsColumns.tableColumns,
    customFieldColumns: {},
    fieldVisibility: {},
    cancelConfirmThreshold: 0.75,
    isLoading: false,
  }),
  useCustomFields: () => ({
    customFields: [],
    enabledCustomFields: [],
    isLoading: false,
  }),
  toggleTableColumn: vi.fn(),
  toggleCustomFieldColumn: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  db: {
    attachments: {
      where: () => ({ anyOf: () => ({ toArray: () => mockAttachmentsToArray() }) }),
    },
  },
}));

vi.mock("./BitcoinAddressDisplay", () => ({
  BitcoinAddressDisplay: ({ address }: { address: string }) => <span>{address}</span>,
}));

import { RecordTable } from "./RecordTable";

beforeEach(() => {
  vi.clearAllMocks();
  mockAttachmentsToArray.mockResolvedValue([]);
});

describe("RecordTable stats columns (cached values)", () => {
  it("renders cached stats values for synced address records", async () => {
    const records = [
      {
        id: "1",
        type: "address" as const,
        inputString: "bc1addr1",
        label: "Addr 1",
        tags: [],
        cachedBalanceSats: 60000,
        cachedTxCount: 2,
        cachedLastActivityTime: 1700001000,
        statsComputedAt: 1700002000,
      },
    ];

    const { container } = render(<RecordTable records={records} />);

    await waitFor(() => {
      const row1 = container.querySelector('[data-testid="row-record-1"]')!;
      expect(row1).toBeTruthy();
    });

    const row1 = container.querySelector('[data-testid="row-record-1"]')!;
    const expectedDate = new Date(1700001000 * 1000).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    expect(row1.textContent).toContain("0.00060000");
    expect(row1.textContent).toContain(expectedDate);
    expect(row1.textContent).toContain("2");
  });

  it("shows 'Not synced' for address records without a stats cache", async () => {
    const records = [
      { id: "2", type: "address" as const, inputString: "bc1addr2", label: "Addr 2", tags: [] },
    ];

    const { container } = render(<RecordTable records={records} />);

    await waitFor(() => {
      const row2 = container.querySelector('[data-testid="row-record-2"]')!;
      expect(row2).toBeTruthy();
    });

    const row2 = container.querySelector('[data-testid="row-record-2"]')!;
    expect(row2.textContent).toContain("Not synced");
  });

  it("renders dashes for non-address rows", async () => {
    const records = [
      { id: "10", type: "transaction" as const, inputString: "txid_abc", label: "TX", tags: [] },
    ];

    const { container } = render(<RecordTable records={records} />);

    await waitFor(() => {
      const row = container.querySelector('[data-testid="row-record-10"]')!;
      expect(row).toBeTruthy();
    });

    const row = container.querySelector('[data-testid="row-record-10"]')!;
    expect(row.textContent).not.toContain("Not synced");
    expect(row.textContent).toContain("-");
  });
});
