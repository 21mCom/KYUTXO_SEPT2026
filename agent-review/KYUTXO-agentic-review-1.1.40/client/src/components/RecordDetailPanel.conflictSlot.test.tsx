// @vitest-environment jsdom
//
// Verifies the reserved conflict-badge slot in RecordDetailPanel's header
// (data-testid="slot-conflicts"). The conflict check is async; the slot has a
// fixed min-height and is ALWAYS rendered so the badge popping in late (or
// resolving to zero) can never shift neighboring controls. These tests catch
// a refactor that moves the badge back into the flex-wrap badge row:
//   (a) the slot renders while the conflict check is still pending
//   (b) the slot renders (empty) when there are 0 conflicts
//   (c) with >0 conflicts, badge-conflicts appears and only inside the slot
//
// We render the real RecordDetailPanel with a mocked dataFacade so
// getRecordOrigins controls the conflict outcome; conflict detection itself
// (detectSingularFieldConflicts) runs for real against the mocked origins.

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import type { RecordOrigin } from "@/lib/database";

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

const { RecordDetailPanel } = await import("./RecordDetailPanel");
const { getRecordOrigins } = await import("@/lib/dataFacade");
const getRecordOriginsMock = vi.mocked(getRecordOrigins);

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    type: "address" as const,
    inputString: "bc1qexampleaddress",
    label: "Test Address",
    tags: [],
    categories: [],
    ...overrides,
  };
}

// Two origins that disagree on the singular `owner` field → exactly one
// unresolved conflict per detectSingularFieldConflicts.
function conflictingOrigins(): RecordOrigin[] {
  return [
    {
      id: 101,
      recordId: 1,
      originType: "manual",
      owner: "Alice",
      createdAt: 1000,
    } as unknown as RecordOrigin,
    {
      id: 102,
      recordId: 1,
      originType: "wallet-import",
      owner: "Bob",
      createdAt: 2000,
    } as unknown as RecordOrigin,
  ];
}

function renderPanel(record: ReturnType<typeof baseRecord>) {
  return renderWithProviders(
    <RecordDetailPanel open={true} onClose={() => {}} record={record} />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RecordDetailPanel reserved conflict-badge slot", () => {
  it("renders the slot (empty) while the conflict check is still pending", () => {
    // Never-resolving origins lookup keeps conflictCount === null (pending).
    getRecordOriginsMock.mockImplementation(() => new Promise(() => {}));

    const { getByTestId, queryByTestId } = renderPanel(baseRecord());

    const slot = getByTestId("slot-conflicts");
    expect(slot).toBeTruthy();
    // Reserved space: fixed min-height so a late badge can't shift controls.
    expect(slot.className).toContain("min-h-");
    // No badge while pending.
    expect(queryByTestId("badge-conflicts")).toBeNull();
  });

  it("keeps the slot present with no badge when there are 0 conflicts", async () => {
    getRecordOriginsMock.mockResolvedValue([]);

    const { getByTestId, queryByTestId } = renderPanel(baseRecord());

    // Let the async conflict check settle to 0.
    await waitFor(() => {
      expect(getRecordOriginsMock).toHaveBeenCalled();
    });

    const slot = getByTestId("slot-conflicts");
    expect(slot).toBeTruthy();
    expect(slot.className).toContain("min-h-");
    expect(queryByTestId("badge-conflicts")).toBeNull();
  });

  it("renders the conflict badge inside the slot when conflicts exist", async () => {
    getRecordOriginsMock.mockResolvedValue(conflictingOrigins());

    const { getByTestId, getAllByTestId } = renderPanel(
      baseRecord({ owner: "Alice" }),
    );

    const slot = getByTestId("slot-conflicts");

    // Badge pops in asynchronously once the conflict check resolves.
    await waitFor(() => {
      expect(within(slot).getByTestId("badge-conflicts")).toBeTruthy();
    });

    const badge = within(slot).getByTestId("badge-conflicts");
    expect(badge.textContent).toContain("1 Conflict");

    // The badge exists ONLY inside the reserved slot — a refactor moving it
    // back into the flex-wrap badge row would render it elsewhere.
    const allBadges = getAllByTestId("badge-conflicts");
    expect(allBadges).toHaveLength(1);
    expect(slot.contains(allBadges[0])).toBe(true);
    // And specifically not inside the flex-wrap badge row.
    const badgeRow = getByTestId("badge-conflicts").closest(".flex-wrap");
    expect(badgeRow).toBeNull();
  });
});
