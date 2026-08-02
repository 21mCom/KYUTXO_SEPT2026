// @vitest-environment jsdom
//
// Tests for the bulk "Unmark all" action on the Dusted page: when every
// the scan has any flagged unspent outputs, the toolbar offers a bulk unmark
// that removes all of the scan's flags in one click (alongside Mark all on
// partially flagged scans), with busy state, summary toast, and destructive
// error toast. Mirrors DustedPage.markAll.test.tsx.

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
const ADDR_1 = "bc1qdustedpageunmarkalladdr100000000000000";
const ADDR_2 = "bc1qdustedpageunmarkalladdr200000000000000";

/** Seed two address records with dust outputs; returns their record ids. */
async function seed() {
  const recordId1 = await createRecord({
    type: "address",
    inputString: ADDR_1,
    label: "Dusted unmark-all 1",
    tags: [],
    categories: [],
  });
  const recordId2 = await createRecord({
    type: "address",
    inputString: ADDR_2,
    label: "Dusted unmark-all 2",
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

/** Flag every seeded unspent dust output so the scan is fully flagged. */
async function flagAll() {
  await markOutpointsAsDust([
    { txid: TXID_A, vout: 0, address: ADDR_1, amountSats: 546 },
    { txid: TXID_B, vout: 1, address: ADDR_1, amountSats: 800 },
    { txid: TXID_C, vout: 0, address: ADDR_2, amountSats: 300 },
  ]);
}

async function lastToast() {
  await waitFor(() => expect(toastSpy).toHaveBeenCalled());
  return toastSpy.mock.calls[toastSpy.mock.calls.length - 1][0];
}

describe("DustedPage bulk unmark-all", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(async () => {
    toastSpy.mockClear();
    await clearAllRecords();
    await clearParticipants();
    await db.dustFlags.clear();
  });

  it("removes every flag from the scan in one action", async () => {
    const { recordId1, recordId2 } = await seed();
    await flagAll();
    renderWithProviders(<DustedPage />);

    const button = await screen.findByTestId("button-unmark-all-dust", {}, { timeout: 10000 });
    expect(button.textContent).toContain("3");
    fireEvent.click(button);

    await waitFor(async () => {
      expect((await getAllDustFlags()).length).toBe(0);
    });

    // Toast reports the removed count.
    const toast = await lastToast();
    expect(toast.title).toBe("Dust flags removed");
    expect(toast.description).toContain("3");

    // Per-row buttons flip back to Mark, and the unmark-all button disappears
    // (the mark-all button reappears now that everything is markable again).
    await screen.findByTestId(`button-mark-dust-${recordId1}`);
    await screen.findByTestId(`button-mark-dust-${recordId2}`);
    await waitFor(() => {
      expect(screen.queryByTestId("button-unmark-all-dust")).toBeNull();
      expect(screen.queryByTestId("button-mark-all-dust")).not.toBeNull();
    });
  });

  it("clears only the scan's existing flags on a partially flagged scan, leaving unflagged outputs untouched", async () => {
    const { recordId1 } = await seed();
    // Only one of the three outputs flagged — both bulk buttons render.
    await markOutpointsAsDust([
      { txid: TXID_A, vout: 0, address: ADDR_1, amountSats: 546 },
    ]);
    renderWithProviders(<DustedPage />);

    await screen.findByTestId(`row-dusted-${recordId1}`, {}, { timeout: 10000 });
    const markAll = await screen.findByTestId("button-mark-all-dust");
    expect(markAll.textContent).toContain("2");
    const unmarkAll = await screen.findByTestId("button-unmark-all-dust");
    expect(unmarkAll.textContent).toContain("1");

    fireEvent.click(unmarkAll);

    await waitFor(async () => {
      expect((await getAllDustFlags()).length).toBe(0);
    });
    const toast = await lastToast();
    expect(toast.title).toBe("Dust flags removed");
    expect(toast.description).toContain("1");

    // Unmark all disappears; Mark all now advertises all three outputs.
    await waitFor(() => {
      expect(screen.queryByTestId("button-unmark-all-dust")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("button-mark-all-dust").textContent).toContain("3");
    });
  });

  it("hides the button when nothing is flagged", async () => {
    const { recordId1, recordId2 } = await seed();
    renderWithProviders(<DustedPage />);

    await screen.findByTestId(`row-dusted-${recordId1}`, {}, { timeout: 10000 });
    await screen.findByTestId(`row-dusted-${recordId2}`, {}, { timeout: 10000 });
    expect(screen.queryByTestId("button-unmark-all-dust")).toBeNull();
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
    expect(screen.queryByTestId("button-unmark-all-dust")).toBeNull();
  });

  it("disables the button while the bulk unmark is in flight (no double submit)", async () => {
    await seed();
    await flagAll();

    // Hold the first unmarkDustOutpoints call open so we can observe the busy state.
    const dustCrud = await import("@/lib/data/dust-flags-crud");
    const realUnmark = dustCrud.unmarkDustOutpoints;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unmarkSpy = vi
      .spyOn(dustCrud, "unmarkDustOutpoints")
      .mockImplementationOnce(async (outpoints) => {
        await gate;
        return realUnmark(outpoints);
      });

    try {
      renderWithProviders(<DustedPage />);
      const button = await screen.findByTestId("button-unmark-all-dust", {}, { timeout: 10000 });

      fireEvent.click(button);
      // Busy while the first chunk is held open; a second click is a no-op.
      await waitFor(() => expect(button).toHaveProperty("disabled", true));
      fireEvent.click(button);
      expect(unmarkSpy).toHaveBeenCalledTimes(1);

      release!();
      await waitFor(async () => {
        expect((await getAllDustFlags()).length).toBe(0);
      });
      expect(unmarkSpy).toHaveBeenCalledTimes(1);
    } finally {
      release!();
      unmarkSpy.mockRestore();
    }
  });

  it("shows a destructive toast when the bulk unmark fails", async () => {
    await seed();
    await flagAll();

    const dustCrud = await import("@/lib/data/dust-flags-crud");
    const unmarkSpy = vi
      .spyOn(dustCrud, "unmarkDustOutpoints")
      .mockRejectedValueOnce(new Error("disk full"));

    try {
      renderWithProviders(<DustedPage />);
      const button = await screen.findByTestId("button-unmark-all-dust", {}, { timeout: 10000 });
      fireEvent.click(button);

      await waitFor(() => {
        const failure = toastSpy.mock.calls
          .map((c) => c[0])
          .find((t) => t.variant === "destructive");
        expect(failure).toBeTruthy();
        expect(failure.title).toBe("Failed to remove dust flags");
        expect(failure.description).toContain("disk full");
      });

      // Nothing was removed and the button is usable again.
      expect((await getAllDustFlags()).length).toBe(3);
      await waitFor(() => expect(button).toHaveProperty("disabled", false));
    } finally {
      unmarkSpy.mockRestore();
    }
  });
});
