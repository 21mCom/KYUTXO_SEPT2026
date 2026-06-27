// @vitest-environment jsdom
//
// Confirms the behavior badge updates live in the Records table (RecordTable),
// not just the RecordCard view. RecordTable derives its badge from a useMemo
// keyed on the `records` array (localAddressStats) with an optional
// precomputedAddressStats map from the Dashboard — a different code branch from
// RecordCard. An address row starts with no statsComputedAt (neutral
// "Not Synced" badge); once the cached stats fields are written and the table
// re-renders with a new records array, the badge must reflect the newly
// classified label with no stale text left behind.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TestProviders } from "@/test/testProviders";

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

vi.mock("./BitcoinAddressDisplay", () => ({
  BitcoinAddressDisplay: ({ address }: { address: string }) => <span>{address}</span>,
}));

const { RecordTable } = await import("@/components/RecordTable");
import { BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";

const ADDRESS = "bc1qexampletableaddress00000000";

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "7",
    type: "address" as const,
    inputString: ADDRESS,
    label: "Table Address",
    tags: [],
    categories: [],
    ...overrides,
  };
}

function renderTable(record: ReturnType<typeof makeRecord>, extraProps: Record<string, unknown> = {}) {
  return render(
    <TestProviders>
      <RecordTable records={[record]} {...extraProps} />
    </TestProviders>,
  );
}

describe("RecordTable behavior badge live update", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("re-renders 'Not Synced' -> 'Accumulator' via the localAddressStats fallback (no precomputed map)", () => {
    // 1. Initial render: no statsComputedAt → not-enough-data ("Not Synced").
    const { getByTestId, rerender } = renderTable(makeRecord());

    expect(getByTestId("badge-behavior-7").textContent).toBe(
      BEHAVIOR_LABEL_DISPLAY["not-enough-data"],
    );

    // 2. Stats are recomputed: a new records array carries the cached fields.
    //    txCount=10, utxoCount=5, balance>0 → utxoTxRatio=0.5 ≥ 0.4 → Accumulator
    rerender(
      <TestProviders>
        <RecordTable
          records={[
            makeRecord({
              statsComputedAt: Date.now(),
              cachedTxCount: 10,
              cachedBalanceSats: 500_000,
              cachedUtxoCount: 5,
              cachedLastActivityTime: Math.floor(Date.now() / 1000) - 180 * 24 * 3600,
            }),
          ]}
        />
      </TestProviders>,
    );

    // 3. The same badge element now shows the recomputed label, no stale text.
    const updated = getByTestId("badge-behavior-7");
    expect(updated.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["accumulator"]);
    expect(updated.textContent).not.toBe(BEHAVIOR_LABEL_DISPLAY["not-enough-data"]);
  });

  it("re-renders live when an empty precomputedAddressStats map is passed (falls back to local)", () => {
    // The Dashboard passes an empty Map when stats columns are toggled off; the
    // badge must still derive from localAddressStats and update on rerender.
    const { getByTestId, rerender } = renderTable(makeRecord(), {
      precomputedAddressStats: new Map(),
    });

    expect(getByTestId("badge-behavior-7").textContent).toBe(
      BEHAVIOR_LABEL_DISPLAY["not-enough-data"],
    );

    // A completed sync writes a high tx count (≥ 50) and recent activity.
    rerender(
      <TestProviders>
        <RecordTable
          records={[
            makeRecord({
              statsComputedAt: Date.now(),
              cachedTxCount: 75,
              cachedBalanceSats: 120_000,
              cachedUtxoCount: 4,
              cachedLastActivityTime: Math.floor(Date.now() / 1000) - 10 * 24 * 3600,
            }),
          ]}
          precomputedAddressStats={new Map()}
        />
      </TestProviders>,
    );

    const updated = getByTestId("badge-behavior-7");
    expect(updated.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["high-activity"]);
    expect(updated.textContent).not.toBe(BEHAVIOR_LABEL_DISPLAY["not-enough-data"]);
  });
});
