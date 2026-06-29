// @vitest-environment jsdom
//
// Verifies that RecordTable shows behavior badges in its label cell for address
// rows even when an empty precomputedAddressStats map is passed in — the
// scenario that occurs in Dashboard when stats columns are toggled off.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

vi.mock("@/lib/dataFacade", () => ({
  getRecordOrigins: vi.fn(async () => []),
  getEvidenceByRecordId: vi.fn(async () => []),
  getRecords: vi.fn(async () => []),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return {
    ...actual,
    db: {
      attachments: {
        where: () => ({ anyOf: () => ({ toArray: () => Promise.resolve([]) }) }),
      },
    },
  };
});

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    settings: { tableColumns: {}, customFieldColumns: {}, fieldVisibility: {}, cancelConfirmThreshold: 0.75 },
    tableColumns: {},
    customFieldColumns: {},
    fieldVisibility: {},
    cancelConfirmThreshold: 0.75,
    isLoading: false,
  }),
  useCustomFields: () => ({ customFields: [], enabledCustomFields: [], isLoading: false }),
  toggleTableColumn: vi.fn(),
  toggleCustomFieldColumn: vi.fn(),
}));


const { RecordTable } = await import("@/components/RecordTable");
import { BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "7",
    type: "address" as const,
    inputString: "bc1qexampletableaddress00000000",
    label: "Table Address",
    tags: [],
    categories: [],
    ...overrides,
  };
}

function renderTable(record: ReturnType<typeof makeRecord>, extraProps: Record<string, unknown> = {}) {
  return renderWithProviders(
    <RecordTable
      records={[record]}
      onRecordClick={() => {}}
      onRecordEdit={() => {}}
      onRecordDelete={() => {}}
      {...extraProps}
    />,
  );
}

describe("RecordTable behavior badge with empty precomputedAddressStats", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows behavior badge when precomputedAddressStats is an empty Map (default dashboard state)", () => {
    const { getByTestId } = renderTable(
      makeRecord({
        statsComputedAt: Date.now(),
        cachedTxCount: 8,
        cachedBalanceSats: 200_000,
        cachedUtxoCount: 4,
        cachedLastActivityTime: Math.floor(Date.now() / 1000) - 60 * 24 * 3600,
      }),
      { precomputedAddressStats: new Map() },
    );
    // Badge must exist regardless of the empty precomputed map
    const badge = getByTestId("badge-behavior-7");
    expect(badge).toBeTruthy();
  });

  it("shows 'Not Synced' badge for unsynced address even with empty precomputedAddressStats", () => {
    const { getByTestId } = renderTable(
      makeRecord({ statsComputedAt: undefined }),
      { precomputedAddressStats: new Map() },
    );
    const badge = getByTestId("badge-behavior-7");
    expect(badge.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["not-enough-data"]);
  });

  it("shows correct label when precomputedAddressStats is undefined (no prop passed)", () => {
    const { getByTestId } = renderTable(
      makeRecord({
        statsComputedAt: Date.now(),
        cachedTxCount: 6,
        cachedBalanceSats: 300_000,
        cachedUtxoCount: 3,
        cachedLastActivityTime: Math.floor(Date.now() / 1000) - 90 * 24 * 3600,
      }),
    );
    // Accumulator: balance > 0, utxoCount >= 3, utxoTxRatio = 3/6 = 0.5 >= 0.4
    const badge = getByTestId("badge-behavior-7");
    expect(badge.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["accumulator"]);
  });
});
