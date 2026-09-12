// @vitest-environment jsdom
//
// Verifies the "Tag all suspects"/"Tag all targets" buttons surface live
// done/total progress fed by applyPoisoningTags' onProgress callback while a
// bulk tagging run is in flight, and restore their idle label afterwards.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { bulkAddParticipants, clearParticipants } from "@/lib/data/transaction-crud";
import AddressPoisoning from "./AddressPoisoning";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// jsdom has no layout; render every virtual row.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 132,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 132,
      getVirtualItems: () => items,
    };
  },
}));

// Controllable applyPoisoningTags: the test drives onProgress ticks and decides
// when the run completes, so the in-flight button text can be asserted.
type ProgressCb = (done: number, total: number) => void;
let capturedOnProgress: ProgressCb | null = null;
let resolveRun: (() => void) | null = null;

vi.mock("@/lib/data/poisoning-tagging", () => ({
  applyPoisoningTags: vi.fn(
    (
      entries: Array<{ address: string }>,
      _tags: string[],
      options?: { onProgress?: ProgressCb },
    ) => {
      capturedOnProgress = options?.onProgress ?? null;
      return new Promise((resolve) => {
        resolveRun = () =>
          resolve({ tagged: entries.length, alreadyTagged: 0, created: 0 });
      });
    },
  ),
}));

const TXID_DUST = "a".repeat(64);
const VICTIM = "bc1qpoisontarget000000000000000zz777";
const LOOKALIKE = "bc1qpoisonattack99999999999999zz777";

async function seed() {
  await createRecord({
    type: "address",
    inputString: VICTIM,
    label: "My receiving address",
    tags: [],
    categories: [],
    walletName: "Savings",
  });
  await bulkAddParticipants([
    { txid: TXID_DUST, role: "output", address: VICTIM, amount: 546, vout: 0 },
    { txid: TXID_DUST, role: "input", address: LOOKALIKE, amount: 600 },
  ]);
}

describe("AddressPoisoning tag-all progress", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(async () => {
    toastSpy.mockClear();
    capturedOnProgress = null;
    resolveRun = null;
    await clearAllRecords();
    await clearParticipants();
    await db.tags.clear();
  });

  it("shows live done/total progress on the busy Tag-all-suspects button", async () => {
    await seed();
    renderWithProviders(<AddressPoisoning />);

    fireEvent.click(await screen.findByTestId("button-run-scan"));
    const tagAll = await screen.findByTestId("button-tag-all-suspects", {}, { timeout: 10000 });
    expect(tagAll.textContent).toContain("Tag all suspects");
    fireEvent.click(tagAll);

    // Busy but before the first progress tick: generic label.
    await waitFor(() => {
      expect(screen.getByTestId("button-tag-all-suspects").textContent).toContain("Tagging…");
    });
    expect(capturedOnProgress).not.toBeNull();

    // First chunk done.
    act(() => capturedOnProgress!(3500, 10000));
    await waitFor(() => {
      expect(screen.getByTestId("button-tag-all-suspects").textContent).toContain(
        "Tagging 3,500 / 10,000…",
      );
    });

    // Progress advances on subsequent ticks.
    act(() => capturedOnProgress!(10000, 10000));
    await waitFor(() => {
      expect(screen.getByTestId("button-tag-all-suspects").textContent).toContain(
        "Tagging 10,000 / 10,000…",
      );
    });

    // Run completes: button returns to its idle label.
    act(() => resolveRun!());
    await waitFor(() => {
      const btn = screen.getByTestId("button-tag-all-suspects");
      expect(btn.textContent).toContain("Tag all suspects");
      expect(btn.textContent).not.toContain("Tagging");
    });
  });

  it("shows live done/total progress on the busy Tag-all-targets button", async () => {
    await seed();
    renderWithProviders(<AddressPoisoning />);

    fireEvent.click(await screen.findByTestId("button-run-scan"));
    const tagAll = await screen.findByTestId("button-tag-all-targets", {}, { timeout: 10000 });
    fireEvent.click(tagAll);

    await waitFor(() => {
      expect(screen.getByTestId("button-tag-all-targets").textContent).toContain("Tagging…");
    });

    act(() => capturedOnProgress!(500, 2000));
    await waitFor(() => {
      expect(screen.getByTestId("button-tag-all-targets").textContent).toContain(
        "Tagging 500 / 2,000…",
      );
    });

    act(() => resolveRun!());
    await waitFor(() => {
      expect(screen.getByTestId("button-tag-all-targets").textContent).toContain(
        "Tag all targets",
      );
    });
  });
});
