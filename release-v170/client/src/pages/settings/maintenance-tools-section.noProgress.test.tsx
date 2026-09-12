// @vitest-environment jsdom
//
// Covers the no-progress completion messaging of the "Rebuild Missing
// Transactions" flow (maintenance-tools-section.tsx): when a completed rebuild
// made no progress and the leftovers can't be fixed by re-running (e.g. every
// remaining orphan is "not found on your provider"), the completion toast and
// the "Last rebuild result" panel must both explain that the startup
// missing-data reminder will keep flagging those transactions and point at the
// Startup Missing-Data Reminder toggle in this same settings section. Without
// that, the user is stuck in a loop: every launch re-detects the same orphans,
// prompts a rebuild, and the rebuild "completes" having fixed nothing.
//
// detectAndBackfill is stubbed (no provider/network here); the messaging logic
// (hasOnlyUnresolvableLeftovers + formatSkippedReasons) is real, so these tests
// exercise the actual no-progress detection end-to-end through the component.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-toast")>();
  return {
    ...actual,
    useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
  };
});

// Settings hook: the section only reads disableOrphanCheck/isLoading for the
// reminder toggle; stub those two but keep the rest real — the provider
// harness (RecordPreviewProvider) uses other hooks from this module.
vi.mock("@/hooks/use-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-settings")>();
  return {
    ...actual,
    useSettings: () => ({ disableOrphanCheck: false, isLoading: false }),
    updateDisableOrphanCheck: vi.fn(),
  };
});

// Only detectAndBackfill is stubbed; every other export (formatSkippedReasons,
// hasOnlyUnresolvableLeftovers, ...) stays real.
const detectAndBackfillMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/txid-backfill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/txid-backfill")>();
  return {
    ...actual,
    detectAndBackfill: detectAndBackfillMock,
  };
});

import type { BackfillResult } from "@/lib/txid-backfill";

const { renderWithProviders } = await import("@/test/testProviders");
const { MaintenanceToolsSection } = await import("./maintenance-tools-section");

function makeResult(over: Partial<BackfillResult> = {}): BackfillResult {
  return {
    orphansFound: 107,
    rebuilt: 0,
    skipped: 107,
    skippedReasons: { "not-found": 107 },
    failed: 0,
    prevoutsResolved: 0,
    deferred: false,
    errors: [],
    details: [],
    ...over,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  toastSpy.mockReset();
  detectAndBackfillMock.mockReset();
});

afterEach(() => {
  cleanup();
});

async function completionToastDescription(): Promise<string> {
  await waitFor(() => {
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Transaction Rebuild Complete" }),
    );
  });
  const call = toastSpy.mock.calls.find(
    (c) => c[0]?.title === "Transaction Rebuild Complete",
  );
  return String(call?.[0]?.description ?? "");
}

describe("rebuild completion messaging (no progress, unresolvable leftovers)", () => {
  it("points at the Startup Missing-Data Reminder toggle when a re-run can't fix the leftovers", async () => {
    detectAndBackfillMock.mockResolvedValue(makeResult());

    renderWithProviders(<MaintenanceToolsSection />);
    fireEvent.click(screen.getByTestId("button-rebuild-transactions"));

    // Panel: the "Last rebuild result" summary carries the loop-exit hint.
    const hint = await screen.findByTestId("text-rebuild-unresolvable-hint");
    expect(hint.textContent).toContain("Startup Missing-Data Reminder");
    expect(hint.textContent).toMatch(/keep flagging/i);

    // Toast: the completion message explains the loop and the way out.
    const description = await completionToastDescription();
    expect(description).toContain("Startup Missing-Data Reminder");
    expect(description).toMatch(/keep flagging/i);
  });

  it("stays quiet while retryable skips remain (a later run may fix them)", async () => {
    detectAndBackfillMock.mockResolvedValue(
      makeResult({
        skipped: 107,
        skippedReasons: { "not-found": 106, "unconfirmed": 1 },
      }),
    );

    renderWithProviders(<MaintenanceToolsSection />);
    fireEvent.click(screen.getByTestId("button-rebuild-transactions"));

    await screen.findByTestId("rebuild-result-summary");
    expect(screen.queryByTestId("text-rebuild-unresolvable-hint")).toBeNull();

    const description = await completionToastDescription();
    expect(description).not.toContain("Startup Missing-Data Reminder");
  });

  it("stays quiet when the rebuild made progress", async () => {
    detectAndBackfillMock.mockResolvedValue(
      makeResult({ rebuilt: 106, skipped: 1, skippedReasons: { "not-found": 1 } }),
    );

    renderWithProviders(<MaintenanceToolsSection />);
    fireEvent.click(screen.getByTestId("button-rebuild-transactions"));

    await screen.findByTestId("rebuild-result-summary");
    expect(screen.queryByTestId("text-rebuild-unresolvable-hint")).toBeNull();

    const description = await completionToastDescription();
    expect(description).not.toContain("Startup Missing-Data Reminder");
  });
});
