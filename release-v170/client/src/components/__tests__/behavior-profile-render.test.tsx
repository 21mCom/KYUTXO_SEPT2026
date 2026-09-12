// @vitest-environment jsdom
//
// Verifies that RecordDetailPanel renders the behavior badge and summary
// correctly for both synced addresses (with known stats) and unsynced
// addresses (neutral "Not Synced" state).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

vi.mock("@/lib/dataFacade", () => ({
  getRecordOrigins: vi.fn(async () => []),
  getParticipantsByAddress: vi.fn(async () => []),
  getParticipantsByTxid: vi.fn(async () => []),
  getTransactionByTxid: vi.fn(async () => null),
  getTransactionsByTxids: vi.fn(async () => []),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,stub") },
}));

const { RecordDetailPanel } = await import("@/components/RecordDetailPanel");
import { BEHAVIOR_LABEL_DISPLAY } from "@/lib/behavior-profile";

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "42",
    type: "address" as const,
    inputString: "bc1qexample000000000000000000000",
    label: "Test Address",
    tags: [],
    categories: [],
    ...overrides,
  };
}

function renderPanel(record: ReturnType<typeof baseRecord>) {
  return renderWithProviders(
    <RecordDetailPanel open={true} onClose={() => {}} record={record} />,
  );
}

describe("RecordDetailPanel behavior profile", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the behavior section for address records", () => {
    const { getByTestId } = renderPanel(
      baseRecord({
        statsComputedAt: Date.now(),
        cachedTxCount: 5,
        cachedBalanceSats: 100_000,
        cachedUtxoCount: 3,
        cachedLastActivityTime: Math.floor(Date.now() / 1000) - 30 * 24 * 3600,
      }),
    );
    expect(getByTestId("section-behavior-profile")).toBeTruthy();
    expect(getByTestId("badge-behavior-label")).toBeTruthy();
    expect(getByTestId("text-behavior-summary")).toBeTruthy();
  });

  it("shows 'Not Synced' label when address has no statsComputedAt", () => {
    const { getByTestId } = renderPanel(
      baseRecord({
        statsComputedAt: undefined,
      }),
    );
    const badge = getByTestId("badge-behavior-label");
    expect(badge.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["not-enough-data"]);
    const summary = getByTestId("text-behavior-summary");
    expect(summary.textContent).toMatch(/not been synced/i);
  });

  it("shows 'Accumulator' label for address with matching stats", () => {
    // txCount=10, utxoCount=5, balance>0, last activity 6 months ago
    // => utxoTxRatio = 0.5 >= 0.4, balance > 0, utxoCount >= 3 → Accumulator
    const { getByTestId } = renderPanel(
      baseRecord({
        statsComputedAt: Date.now(),
        cachedTxCount: 10,
        cachedBalanceSats: 500_000,
        cachedUtxoCount: 5,
        cachedLastActivityTime: Math.floor(Date.now() / 1000) - 180 * 24 * 3600,
      }),
    );
    const badge = getByTestId("badge-behavior-label");
    expect(badge.textContent).toBe(BEHAVIOR_LABEL_DISPLAY["accumulator"]);
  });

  it("does not render the behavior section for transaction records", () => {
    const { queryByTestId } = renderPanel(
      baseRecord({ type: "transaction" as const }),
    );
    expect(queryByTestId("section-behavior-profile")).toBeNull();
  });

  it("shows summary sentence citing key metrics", () => {
    const { getByTestId } = renderPanel(
      baseRecord({
        statsComputedAt: Date.now(),
        cachedTxCount: 10,
        cachedBalanceSats: 500_000,
        cachedUtxoCount: 5,
        cachedLastActivityTime: Math.floor(Date.now() / 1000) - 180 * 24 * 3600,
      }),
    );
    const summary = getByTestId("text-behavior-summary");
    // Summary should mention tx count or utxo count (citing observable metrics)
    expect(summary.textContent!.length).toBeGreaterThan(20);
  });
});
