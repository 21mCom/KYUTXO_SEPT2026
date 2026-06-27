// @vitest-environment jsdom
//
// Confirms the behavior badge stays attached to the correct record after the
// Records table is sorted. RecordTable sorts rows internally (sortedRecords
// memo) while the behavior badge is keyed by record id via
// addressStats.get(record.id). A sort reorders the rendered rows, but each
// row's badge must continue to show the label derived from THAT record's own
// cached stats — not the label of whatever row previously sat in that position.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

vi.mock("@/lib/dataFacade", () => ({
  getRecordOrigins: vi.fn(async () => []),
  getEvidenceByRecordId: vi.fn(async () => []),
  getRecords: vi.fn(async () => []),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/database", () => ({
  db: {
    attachments: {
      where: () => ({ anyOf: () => ({ toArray: () => Promise.resolve([]) }) }),
    },
  },
}));

// Enable the BTC Balance column so its internal sort button is rendered.
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    settings: { tableColumns: { balance: true }, customFieldColumns: {}, fieldVisibility: {}, cancelConfirmThreshold: 0.75 },
    tableColumns: { balance: true },
    customFieldColumns: {},
    fieldVisibility: {},
    cancelConfirmThreshold: 0.75,
    isLoading: false,
  }),
  useCustomFields: () => ({ customFields: [], enabledCustomFields: [], isLoading: false }),
  toggleTableColumn: vi.fn(),
  toggleCustomFieldColumn: vi.fn(),
}));

vi.mock("./BitcoinAddressDisplay", () => ({
  BitcoinAddressDisplay: ({ address }: { address: string }) => <span>{address}</span>,
}));

const { RecordTable } = await import("@/components/RecordTable");
import { BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";

const NOW = Math.floor(Date.now() / 1000);

// Three address records whose cached stats each classify to a DIFFERENT label,
// laid out so that sorting by balance reorders them away from input order.
//
//   id "1" Zebra  → high-activity (txCount 75),         balance 100,000 sats
//   id "2" Mango  → accumulator   (txs 10, utxo 5, +bal) balance 500,000 sats
//   id "3" Apple  → dormant       (txs 3, last ~4y ago)  balance   5,000 sats
const RECORDS = [
  {
    id: "1",
    type: "address" as const,
    inputString: "bc1qzebraaddress0000000000000000",
    label: "Zebra",
    tags: [],
    categories: [],
    statsComputedAt: Date.now(),
    cachedTxCount: 75,
    cachedBalanceSats: 100_000,
    cachedUtxoCount: 4,
    cachedLastActivityTime: NOW - 10 * 24 * 3600,
  },
  {
    id: "2",
    type: "address" as const,
    inputString: "bc1qmangoaddress0000000000000000",
    label: "Mango",
    tags: [],
    categories: [],
    statsComputedAt: Date.now(),
    cachedTxCount: 10,
    cachedBalanceSats: 500_000,
    cachedUtxoCount: 5,
    cachedLastActivityTime: NOW - 30 * 24 * 3600,
  },
  {
    id: "3",
    type: "address" as const,
    inputString: "bc1qappleaddress0000000000000000",
    label: "Apple",
    tags: [],
    categories: [],
    statsComputedAt: Date.now(),
    cachedTxCount: 3,
    cachedBalanceSats: 5_000,
    cachedUtxoCount: 1,
    cachedLastActivityTime: NOW - 4 * 365 * 24 * 3600,
  },
];

const EXPECTED_LABEL: Record<string, string> = {
  "1": BEHAVIOR_LABEL_DISPLAY["high-activity"],
  "2": BEHAVIOR_LABEL_DISPLAY["accumulator"],
  "3": BEHAVIOR_LABEL_DISPLAY["dormant"],
};

function renderTable() {
  return renderWithProviders(<RecordTable records={RECORDS} />);
}

function rowOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="row-record-"]')).map((el) =>
    (el.getAttribute("data-testid") || "").replace("row-record-", ""),
  );
}

describe("RecordTable behavior badge after sort", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function assertBadgesMatchOwnRecord(getByTestId: (id: string) => HTMLElement) {
    for (const id of Object.keys(EXPECTED_LABEL)) {
      expect(getByTestId(`badge-behavior-${id}`).textContent).toBe(EXPECTED_LABEL[id]);
    }
  }

  it("keeps each badge matched to its own record's stats after a balance sort reorders rows", () => {
    const { getByTestId, container } = renderTable();

    // Before sorting: input order, every badge already matches its own record.
    expect(rowOrder(container)).toEqual(["1", "2", "3"]);
    assertBadgesMatchOwnRecord(getByTestId);

    // Sort by balance ascending: 5,000 (id 3) < 100,000 (id 1) < 500,000 (id 2).
    fireEvent.click(getByTestId("button-sort-balance"));

    // The rows have genuinely reordered (sort happened, not a no-op).
    expect(rowOrder(container)).toEqual(["3", "1", "2"]);

    // The crucial assertion: despite the reorder, each badge still shows the
    // label derived from that record's own cached stats.
    assertBadgesMatchOwnRecord(getByTestId);

    // Sort by balance descending: 500,000 (id 2) > 100,000 (id 1) > 5,000 (id 3).
    fireEvent.click(getByTestId("button-sort-balance"));
    expect(rowOrder(container)).toEqual(["2", "1", "3"]);
    assertBadgesMatchOwnRecord(getByTestId);
  });
});
