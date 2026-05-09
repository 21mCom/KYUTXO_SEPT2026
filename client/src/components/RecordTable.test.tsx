// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";

const mockGetParticipants = vi.fn();
const mockAttachmentsToArray = vi.fn(() => Promise.resolve([]));
const mockTxToArray = vi.fn(() => Promise.resolve([]));

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
    blockchainTransactions: {
      where: () => ({ anyOf: () => ({ toArray: () => mockTxToArray() }) }),
    },
  },
}));

vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddresses: (...args: unknown[]) => mockGetParticipants(...args),
}));

vi.mock("./BitcoinAddressDisplay", () => ({
  BitcoinAddressDisplay: ({ address }: { address: string }) => <span>{address}</span>,
}));

import { RecordTable } from "./RecordTable";

const ADDRESS_RECORDS = [
  { id: "1", type: "address" as const, inputString: "bc1addr1", label: "Addr 1", tags: [] },
  { id: "2", type: "address" as const, inputString: "bc1addr2", label: "Addr 2", tags: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAttachmentsToArray.mockResolvedValue([]);
  mockTxToArray.mockResolvedValue([]);
});

describe("RecordTable stats column loading skeletons", () => {
  it("shows skeleton placeholders in stats columns while the fetch is pending", async () => {
    let resolveParticipants: (v: unknown[]) => void = () => {};
    mockGetParticipants.mockImplementation(
      () => new Promise<unknown[]>((resolve) => { resolveParticipants = resolve; }),
    );

    const { container } = render(<RecordTable records={ADDRESS_RECORDS} />);

    await waitFor(() => {
      const skeletons = container.querySelectorAll(".animate-pulse");
      // 2 address rows × 3 stats columns (balance, lastTxDate, txCount) = 6
      expect(skeletons.length).toBe(6);
    });

    await act(async () => {
      resolveParticipants([]);
      await Promise.resolve();
    });
  });

  it("replaces skeletons with real values once the fetch resolves", async () => {
    mockGetParticipants.mockResolvedValue([
      { address: "bc1addr1", txid: "tx1", role: "output", amount: 100000 },
      { address: "bc1addr1", txid: "tx2", role: "input", amount: 40000 },
    ]);
    mockTxToArray.mockResolvedValue([
      { txid: "tx1", blockTime: 1700000000 },
      { txid: "tx2", blockTime: 1700001000 },
    ]);

    const { container } = render(<RecordTable records={ADDRESS_RECORDS} />);

    await waitFor(() => {
      expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
    });

    // Address 1: balance = 60000 sats = 0.0006 BTC, txCount = 2,
    // lastTxDate = blockTime 1700001000 → "Nov 14, 2023"
    const row1 = container.querySelector('[data-testid="row-record-1"]')!;
    expect(row1).toBeTruthy();
    const expectedDate = new Date(1700001000 * 1000).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    expect(row1.textContent).toContain("0.00060000");
    expect(row1.textContent).toContain(expectedDate);
    expect(row1.textContent).toContain("2");

    // Address 2 has no participants → renders dashes (not skeletons)
    const row2 = container.querySelector('[data-testid="row-record-2"]')!;
    expect(row2).toBeTruthy();
    expect(row2.querySelectorAll(".animate-pulse").length).toBe(0);
    expect(row2.textContent).toContain("-");
  });

  it("does not render skeletons for non-address rows", async () => {
    mockGetParticipants.mockResolvedValue([]);

    const records = [
      { id: "10", type: "transaction" as const, inputString: "txid_abc", label: "TX", tags: [] },
    ];

    const { container } = render(<RecordTable records={records} />);

    // Transaction rows always render dashes in stats cells, never skeletons
    await waitFor(() => {
      const row = container.querySelector('[data-testid="row-record-10"]')!;
      expect(row).toBeTruthy();
      expect(row.querySelectorAll(".animate-pulse").length).toBe(0);
    });
  });
});
