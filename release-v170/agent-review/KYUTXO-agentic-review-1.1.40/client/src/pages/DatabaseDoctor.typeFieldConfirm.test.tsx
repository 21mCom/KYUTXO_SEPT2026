// @vitest-environment jsdom
//
// Confirm-before-mass-clear for the "Clear stale type fields" repair
// (Task #1979): when the scan finds MORE than 25 affected records, clicking
// the repair button opens a confirmation dialog showing the count instead of
// running immediately. Confirming runs the repair; cancelling does nothing.
// At or below the threshold the click runs the repair straight away, as
// before.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { db, type Record as DbRecord } from "@/lib/database";
import {
  clearAllRecords,
  getRecordsByIds,
  repairStaleTypeSpecificFields,
} from "@/lib/data/record-crud";

vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview: vi.fn(),
    openRecordPreviewByAddress: vi.fn(),
    openRecordEdit: vi.fn(),
    closePreview: vi.fn(),
    isOpen: false,
    isLoading: false,
  }),
}));

vi.mock("@/lib/vault", () => ({
  isLegacyDecryptComplete: vi.fn().mockResolvedValue(true),
  getLegacyDecryptCompletedTables: vi.fn().mockResolvedValue([]),
  isInputStringLowerRepaired: vi.fn().mockResolvedValue(true),
  setInputStringLowerRepaired: vi.fn().mockResolvedValue(undefined),
  setCanonicalInputStringsRepaired: vi.fn().mockResolvedValue(undefined),
}));

// The Balance Integrity card is idle until clicked; stub its heavy deps.
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));
vi.mock("@/lib/data/stale-balance-report-store", () => ({
  clearStaleReport: vi.fn().mockResolvedValue(undefined),
  appendStaleReportRows: vi.fn().mockResolvedValue(undefined),
  getStaleReportWindow: vi.fn().mockResolvedValue([]),
  exportStaleReport: vi.fn().mockResolvedValue(undefined),
}));

// Spy on the repair so tests can assert whether it ran; keep everything else
// (clearAllRecords etc.) real. record-crud is not in an import cycle with this
// page, so importOriginal partial-mocking is safe here.
vi.mock("@/lib/data/record-crud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/record-crud")>();
  return {
    ...actual,
    repairStaleTypeSpecificFields: vi.fn(actual.repairStaleTypeSpecificFields),
  };
});

import DatabaseDoctor from "./DatabaseDoctor";

const repairSpy = vi.mocked(repairStaleTypeSpecificFields);

// Seed an address row still carrying a transaction-only field (flowType) —
// exactly the corruption a pre-clearing Type switch leaves behind. Direct
// table write on purpose: the CRUD layer clears these on save.
async function seedStale(i: number): Promise<number> {
  const now = Date.now();
  return (await db.records.add({
    type: "address",
    inputString: `stale-record-${i}`,
    inputStringLower: `stale-record-${i}`,
    label: "",
    notes: "",
    tags: [],
    categories: [],
    owner: "Pending Review",
    source: "manual",
    addressImportance: "manual",
    flowType: "incoming",
    createdAt: now,
    updatedAt: now,
  } as unknown as DbRecord)) as number;
}

async function seedStaleRows(count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(await seedStale(i));
  return ids;
}

async function runHealthCheck() {
  render(<DatabaseDoctor />);
  fireEvent.click(screen.getByTestId("button-run-check"));
  await waitFor(
    () => expect(screen.getByTestId("card-record-health")).toBeTruthy(),
    { timeout: 15_000 },
  );
}

describe("Clear stale type fields confirmation (Task #1979)", () => {
  beforeEach(async () => {
    repairSpy.mockClear();
    await clearAllRecords();
  });

  afterEach(() => cleanup());

  it("above the threshold: shows a confirm dialog with the count; confirming runs the repair", async () => {
    const ids = await seedStaleRows(26);
    await runHealthCheck();

    fireEvent.click(screen.getByTestId("button-repair-type-fields"));

    // No repair yet — the dialog gates it, and shows the affected count.
    const dialog = await screen.findByTestId("dialog-confirm-type-field-repair");
    expect(repairSpy).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("26");

    fireEvent.click(screen.getByTestId("button-confirm-type-field-repair"));
    await waitFor(() => expect(repairSpy).toHaveBeenCalledTimes(1));

    // The repair actually cleared the stale fields.
    await waitFor(async () => {
      const rows = (await getRecordsByIds(ids)) as unknown as Array<{ flowType?: unknown }>;
      expect(rows.some((r) => r.flowType !== undefined)).toBe(false);
    });
  });

  it("above the threshold: cancelling does nothing", async () => {
    const ids = await seedStaleRows(26);
    await runHealthCheck();

    fireEvent.click(screen.getByTestId("button-repair-type-fields"));
    await screen.findByTestId("dialog-confirm-type-field-repair");
    fireEvent.click(screen.getByTestId("button-cancel-type-field-repair"));

    await waitFor(() =>
      expect(screen.queryByTestId("dialog-confirm-type-field-repair")).toBeNull(),
    );
    expect(repairSpy).not.toHaveBeenCalled();
    // Data untouched.
    const rows = (await getRecordsByIds(ids)) as unknown as Array<{ flowType?: unknown }>;
    expect(rows).toHaveLength(26);
    expect(rows.every((r) => r.flowType === "incoming")).toBe(true);
  });

  it("at or below the threshold: runs immediately without a dialog", async () => {
    await seedStaleRows(25);
    await runHealthCheck();

    fireEvent.click(screen.getByTestId("button-repair-type-fields"));

    await waitFor(() => expect(repairSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("dialog-confirm-type-field-repair")).toBeNull();
  });
});
