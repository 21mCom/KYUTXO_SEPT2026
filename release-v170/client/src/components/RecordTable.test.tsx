// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

// RecordTable mounts the node-settings sync hook through the shared provider
// tree.  These unit tests exercise table rendering only; keep that network
// boundary contract-faithful and deterministic.
vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: {} }),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  RecordPreviewProvider: ({ children }: { children: unknown }) => children,
  useRecordPreview: () => ({ openPreview: vi.fn() }),
}));

const mockAttachmentsToArray = vi.fn(() => Promise.resolve([]));

const baseTableColumns = {
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
};

const settingsWithStatsColumns = {
  tableColumns: { ...baseTableColumns },
  customFieldColumns: {},
  fieldVisibility: {},
};

function setTableColumns(overrides: Partial<typeof baseTableColumns>) {
  settingsWithStatsColumns.tableColumns = { ...baseTableColumns, ...overrides };
}

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

vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return {
    ...actual,
    db: {
      ...actual.db,
      attachments: {
        where: () => ({ anyOf: () => ({ toArray: () => mockAttachmentsToArray() }) }),
      },
    },
  };
});


import { RecordTable } from "./RecordTable";

beforeEach(() => {
  vi.clearAllMocks();
  mockAttachmentsToArray.mockResolvedValue([]);
  setTableColumns({});
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

    const { container } = renderWithProviders(<RecordTable records={records} />);

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

    const { container } = renderWithProviders(<RecordTable records={records} />);

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

    const { container } = renderWithProviders(<RecordTable records={records} />);

    await waitFor(() => {
      const row = container.querySelector('[data-testid="row-record-10"]')!;
      expect(row).toBeTruthy();
    });

    const row = container.querySelector('[data-testid="row-record-10"]')!;
    expect(row.textContent).not.toContain("Not synced");
    expect(row.textContent).toContain("-");
  });
});

describe("RecordTable missing array fields", () => {
  it("renders without throwing when tags/categories are undefined and their columns are enabled", async () => {
    setTableColumns({ tags: true, categories: true });

    // Older/imported/partial records may lack the array fields entirely.
    const records = [
      {
        id: "missing-arrays",
        type: "address" as const,
        inputString: "bc1addrMissing",
        label: "No arrays",
      } as any,
    ];

    const { container } = renderWithProviders(<RecordTable records={records} />);

    await waitFor(() => {
      const row = container.querySelector('[data-testid="row-record-missing-arrays"]')!;
      expect(row).toBeTruthy();
    });

    const row = container.querySelector('[data-testid="row-record-missing-arrays"]')!;
    expect(row.textContent).toContain("No arrays");
  });

  it("renders tag and category badges when the arrays are present", async () => {
    setTableColumns({ tags: true, categories: true });

    const records = [
      {
        id: "with-arrays",
        type: "address" as const,
        inputString: "bc1addrWith",
        label: "Has arrays",
        tags: ["alpha", "beta", "gamma"],
        categories: ["cat1"],
      },
    ];

    const { container } = renderWithProviders(<RecordTable records={records} />);

    await waitFor(() => {
      const row = container.querySelector('[data-testid="row-record-with-arrays"]')!;
      expect(row).toBeTruthy();
    });

    const row = container.querySelector('[data-testid="row-record-with-arrays"]')!;
    expect(row.textContent).toContain("alpha");
    expect(row.textContent).toContain("beta");
    expect(row.textContent).toContain("+1");
    expect(row.textContent).toContain("cat1");
  });

  it("sorts by label and by tags without throwing when a row omits them (Task #1924)", async () => {
    setTableColumns({ tags: true });

    // Sparse row mirrors createRecord storage for records saved without
    // optional metadata: label and tags are absent (undefined), not "".
    const records = [
      {
        id: "sparse",
        type: "address" as const,
        inputString: "bc1addrSparseSort",
      } as any,
      {
        id: "full",
        type: "address" as const,
        inputString: "bc1addrFullSort",
        label: "Alpha label",
        tags: ["zeta"],
      },
    ];

    const { container } = renderWithProviders(<RecordTable records={records} />);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="row-record-sparse"]')).toBeTruthy();
    });

    // Label sort exercised a.label.toLowerCase() on an undefined label.
    fireEvent.click(container.querySelector('[data-testid="button-sort-label"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="row-record-sparse"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="row-record-full"]')).toBeTruthy();
    });

    // Tags sort exercised a.tags[0] on undefined tags.
    fireEvent.click(container.querySelector('[data-testid="button-sort-tags"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="row-record-sparse"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="row-record-full"]')).toBeTruthy();
    });
  });
});
