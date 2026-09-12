// @vitest-environment jsdom
//
// Tests for the bulk "Mark all as dust" action on the Dusted page: it flags
// every unspent dust output from the current scan in one click, skips
// already-flagged outpoints, hides/disables itself appropriately, and reports
// the newly flagged count via toast.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { bulkAddParticipants, clearParticipants } from "@/lib/data/transaction-crud";
import { getAllDustFlags, markOutpointsAsDust, toOutpoint } from "@/lib/data/dust-flags-crud";
import DustedPage from "./DustedPage";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// jsdom has no layout, so the real virtualizer measures a 0-height scroll
// element and renders nothing. Render every row instead.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 56,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 56,
      getVirtualItems: () => items,
    };
  },
}));

const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);
const TXID_C = "c".repeat(64);
const ADDR_1 = "bc1qdustedpagemarkalladdr1000000000000000";
const ADDR_2 = "bc1qdustedpagemarkalladdr2000000000000000";

/** Seed two address records with dust outputs; returns their record ids. */
async function seed() {
  const recordId1 = await createRecord({
    type: "address",
    inputString: ADDR_1,
    label: "Dusted mark-all 1",
    tags: [],
    categories: [],
  });
  const recordId2 = await createRecord({
    type: "address",
    inputString: ADDR_2,
    label: "Dusted mark-all 2",
    tags: [],
    categories: [],
  });
  await bulkAddParticipants([
    { txid: TXID_A, role: "output", address: ADDR_1, amount: 546, vout: 0 },
    { txid: TXID_B, role: "output", address: ADDR_1, amount: 800, vout: 1 },
    { txid: TXID_C, role: "output", address: ADDR_2, amount: 300, vout: 0 },
  ]);
  return { recordId1, recordId2 };
}

async function lastToast() {
  await waitFor(() => expect(toastSpy).toHaveBeenCalled());
  return toastSpy.mock.calls[toastSpy.mock.calls.length - 1][0];
}

describe("DustedPage bulk mark-all", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(async () => {
    toastSpy.mockClear();
    await clearAllRecords();
    await clearParticipants();
    await db.dustFlags.clear();
  });

  it("flags every unspent dust output across multiple address rows in one action", async () => {
    const { recordId1, recordId2 } = await seed();
    renderWithProviders(<DustedPage />);

    const button = await screen.findByTestId("button-mark-all-dust", {}, { timeout: 10000 });
    expect(button.textContent).toContain("3");
    fireEvent.click(button);

    await waitFor(async () => {
      const flags = await getAllDustFlags();
      expect(flags.map((f) => f.outpoint).sort()).toEqual(
        [toOutpoint(TXID_A, 0), toOutpoint(TXID_B, 1), toOutpoint(TXID_C, 0)].sort(),
      );
    });

    // Toast reports the newly flagged count.
    const toast = await lastToast();
    expect(toast.title).toBe("Marked all as dust");
    expect(toast.description).toContain("3");

    // Per-row buttons flip to Unmark (they subscribe to live dust flags), and
    // the bulk button disappears now that nothing is markable.
    await screen.findByTestId(`button-unmark-dust-${recordId1}`);
    await screen.findByTestId(`button-unmark-dust-${recordId2}`);
    await waitFor(() => {
      expect(screen.queryByTestId("button-mark-all-dust")).toBeNull();
    });
  });

  it("skips already-flagged outputs without duplicating them", async () => {
    const { recordId1 } = await seed();
    // Pre-flag one output before the scan.
    await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR_1, amountSats: 546 },
    ]);
    renderWithProviders(<DustedPage />);

    const button = await screen.findByTestId("button-mark-all-dust", {}, { timeout: 10000 });
    // Only the two unflagged outputs are advertised.
    expect(button.textContent).toContain("2");
    fireEvent.click(button);

    await waitFor(async () => {
      const flags = await getAllDustFlags();
      expect(flags.map((f) => f.outpoint).sort()).toEqual(
        [toOutpoint(TXID_A, 0), toOutpoint(TXID_B, 1), toOutpoint(TXID_C, 0)].sort(),
      );
    });

    // No duplicate flag rows for the pre-flagged outpoint.
    const flags = await getAllDustFlags();
    expect(flags.filter((f) => f.outpoint === toOutpoint(TXID_A, 0))).toHaveLength(1);

    // Toast reports only the newly flagged outputs.
    const toast = await lastToast();
    expect(toast.title).toBe("Marked all as dust");
    expect(toast.description).toContain("2");

    // The partially flagged row now shows Unmark.
    await screen.findByTestId(`button-unmark-dust-${recordId1}`);
  });

  it("hides the button when every output is already flagged", async () => {
    const { recordId1, recordId2 } = await seed();
    await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR_1, amountSats: 546 },
      { txid: TXID_B, vout: 1, address: ADDR_1, amountSats: 800 },
      { txid: TXID_C, vout: 0, address: ADDR_2, amountSats: 300 },
    ]);
    renderWithProviders(<DustedPage />);

    // Wait for the scan to complete (rows visible) — the bulk button must not appear.
    await screen.findByTestId(`row-dusted-${recordId1}`, {}, { timeout: 10000 });
    await screen.findByTestId(`row-dusted-${recordId2}`, {}, { timeout: 10000 });
    expect(screen.queryByTestId("button-mark-all-dust")).toBeNull();
  });

  it("does not render the button when the scan has no results", async () => {
    await createRecord({
      type: "address",
      inputString: ADDR_1,
      label: "No dust here",
      tags: [],
      categories: [],
    });
    // A non-dust output only — above the default threshold.
    await bulkAddParticipants([
      { txid: TXID_A, role: "output", address: ADDR_1, amount: 50_000, vout: 0 },
    ]);
    renderWithProviders(<DustedPage />);

    await screen.findByTestId("state-empty", {}, { timeout: 10000 });
    expect(screen.queryByTestId("button-mark-all-dust")).toBeNull();
  });

  it("disables the button while the bulk mark is in flight (no double submit)", async () => {
    await seed();

    // Hold the first markOutpointsAsDust call open so we can observe the busy state.
    const dustCrud = await import("@/lib/data/dust-flags-crud");
    const realMark = dustCrud.markOutpointsAsDust;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const markSpy = vi
      .spyOn(dustCrud, "markOutpointsAsDust")
      .mockImplementationOnce(async (entries) => {
        await gate;
        return realMark(entries);
      });

    try {
      renderWithProviders(<DustedPage />);
      const button = await screen.findByTestId("button-mark-all-dust", {}, { timeout: 10000 });

      fireEvent.click(button);
      // Busy while the first chunk is held open; a second click is a no-op.
      await waitFor(() => expect(button).toHaveProperty("disabled", true));
      fireEvent.click(button);
      expect(markSpy).toHaveBeenCalledTimes(1);

      release!();
      await waitFor(async () => {
        expect((await getAllDustFlags()).length).toBe(3);
      });
      expect(markSpy).toHaveBeenCalledTimes(1);
    } finally {
      release!();
      markSpy.mockRestore();
    }
  });

  it("shows a destructive toast when the bulk mark fails", async () => {
    await seed();

    const dustCrud = await import("@/lib/data/dust-flags-crud");
    const markSpy = vi
      .spyOn(dustCrud, "markOutpointsAsDust")
      .mockRejectedValueOnce(new Error("disk full"));

    try {
      renderWithProviders(<DustedPage />);
      const button = await screen.findByTestId("button-mark-all-dust", {}, { timeout: 10000 });
      fireEvent.click(button);

      await waitFor(() => {
        const failure = toastSpy.mock.calls
          .map((c) => c[0])
          .find((t) => t.variant === "destructive");
        expect(failure).toBeTruthy();
        expect(failure.title).toBe("Failed to mark all as dust");
        expect(failure.description).toContain("disk full");
      });

      // Nothing was flagged and the button is usable again.
      expect((await getAllDustFlags()).length).toBe(0);
      await waitFor(() => expect(button).toHaveProperty("disabled", false));
    } finally {
      markSpy.mockRestore();
    }
  });
});
