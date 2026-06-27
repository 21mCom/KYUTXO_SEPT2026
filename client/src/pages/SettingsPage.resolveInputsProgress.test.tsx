// @vitest-environment jsdom
//
// UI coverage for the Settings "Resolve Input Addresses" cancel flow
// (Task #558). When the user cancels the pass, we still recompute cached
// balances for the inputs already committed before the abort. That recompute
// can take a moment on large vaults, so the dialog must surface the engine's
// "recomputing" progress ("Updating balances... X of Y addresses") during the
// wait instead of sitting on "Cancelling..." until the toast appears. Once the
// recompute finishes, the existing "Resolution Cancelled" toast must still fire.
//
// We drive the real handleResolveInputs()/handleCancelResolveInputs() wiring
// and only stub the engine (resolveAllBlankInputAddresses) so we can deliver a
// deterministic post-cancel "recomputing" progress event, plus useToast so we
// can assert the terminal toast.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// useAuth throws outside an AuthProvider; this panel doesn't need it.
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    isInitialized: true,
    isAuthenticated: true,
    setupPassword: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    isLoading: false,
    isMigrating: false,
    legacyMigrationProgress: null,
    legacyMigrationResult: null,
    fileDecryptProgress: null,
  }),
}));

// Unrelated heavy sibling panels (own DB queries / auth) — stub them out.
vi.mock("@/components/VocabularyManager", () => ({ default: () => null }));
vi.mock("@/components/StripMarkersPanel", () => ({ default: () => null }));
vi.mock("@/components/MigrationAuditPanel", () => ({ default: () => null }));
vi.mock("@/components/LegacyRecoveryPanel", () => ({ default: () => null }));

// Capture toasts so we can assert the terminal "Resolution Cancelled" toast.
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

// Engine stub: emit scanning/resolving, then block until the user's cancel
// aborts the signal, then emit the post-cancel "recomputing" progress and hold
// (recomputeGate) so the test can assert the live message before completing.
let recomputeGate: () => void = () => {};
const resolveSpy = vi.fn(
  async ({
    signal,
    onProgress,
  }: {
    signal?: AbortSignal;
    onProgress?: (p: any) => void;
  }) => {
    onProgress?.({ phase: "scanning", unresolvedFound: 5, fetched: 0, totalToFetch: 0 });
    onProgress?.({ phase: "resolving", unresolvedFound: 5, fetched: 2, totalToFetch: 5 });

    // Wait for the user to cancel (handleCancelResolveInputs aborts the signal).
    if (!signal?.aborted) {
      await new Promise<void>((res) =>
        signal?.addEventListener("abort", () => res(), { once: true }),
      );
    }

    // Post-cancel balance recompute reports progress so the UI can show it.
    onProgress?.({
      phase: "recomputing",
      unresolvedFound: 5,
      fetched: 0,
      totalToFetch: 0,
      recomputeProcessed: 1,
      recomputeTotal: 3,
    });

    // Hold here so the test can observe "Updating balances..." before the pass
    // completes and the dialog closes.
    await new Promise<void>((res) => {
      recomputeGate = res;
    });

    onProgress?.({ phase: "complete", unresolvedFound: 5, fetched: 0, totalToFetch: 0 });
    return {
      unresolvedFound: 5,
      resolved: 3,
      recomputed: 3,
      cancelled: true,
      deferred: false,
      errors: [],
    };
  },
);

vi.mock("@/lib/txid-backfill", () => ({
  detectAndBackfill: vi.fn(),
  detectOrphanedTxRecords: vi.fn(),
  runTxidBackfill: vi.fn(),
  resolveAllBlankInputAddresses: resolveSpy,
}));

const SettingsPage = (await import("./SettingsPage")).default;
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
const { putSettings } = await import("@/lib/data/settings-crud");
import type { Settings } from "@/lib/db-types";

beforeEach(async () => {
  toastSpy.mockClear();
  resolveSpy.mockClear();
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
});

afterEach(() => {
  cleanup();
});

describe("SettingsPage — Resolve Input Addresses cancel progress", () => {
  it("shows the post-cancel recompute progress, then fires the cancel toast", async () => {
    renderWithSettingsProviders(<SettingsPage />);

    // Start the pass.
    fireEvent.click(await screen.findByTestId("button-resolve-inputs"));

    // The progress dialog appears in the resolving phase.
    const message = await screen.findByTestId("text-resolve-inputs-message");
    await waitFor(() =>
      expect(message.textContent).toContain("fetched 2 of 5 prior transactions"),
    );

    // Cancel: the message first reflects the cancel request.
    fireEvent.click(screen.getByTestId("button-cancel-resolve-inputs"));
    await waitFor(() => expect(message.textContent).toBe("Cancelling..."));

    // The post-cancel recompute then surfaces its progress in the same dialog —
    // this is the behavior under test (no silent wait on "Cancelling...").
    await waitFor(() =>
      expect(
        screen.getByTestId("text-resolve-inputs-message").textContent,
      ).toBe("Updating balances... 1 of 3 addresses"),
    );

    // The cancel toast has NOT fired yet — the recompute is still running.
    expect(toastSpy).not.toHaveBeenCalled();

    // Let the recompute finish.
    recomputeGate();

    // The existing "Resolution Cancelled" toast fires once recompute completes.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Resolution Cancelled" }),
      ),
    );

    // The dialog closes after completion.
    await waitFor(() =>
      expect(screen.queryByTestId("dialog-resolve-inputs")).toBeNull(),
    );
  });
});

describe("SettingsPage — Resolve Input Addresses error messaging", () => {
  it("explains a node outage when the resolve fails on a connectivity error", async () => {
    // The pass throws while reaching the node for a prior transaction.
    resolveSpy.mockRejectedValueOnce(new Error("ETIMEDOUT"));

    renderWithSettingsProviders(<SettingsPage />);

    fireEvent.click(await screen.findByTestId("button-resolve-inputs"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Resolution Failed",
          description: expect.stringContaining("Couldn't reach your Bitcoin node"),
        }),
      ),
    );
  });

  it("explains an internal error when the resolve fails for a non-connectivity reason", async () => {
    // The pass blows up for an unexpected, non-network reason.
    resolveSpy.mockRejectedValueOnce(new Error("kaboom"));

    renderWithSettingsProviders(<SettingsPage />);

    fireEvent.click(await screen.findByTestId("button-resolve-inputs"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Resolution Failed",
          description: expect.stringContaining("An internal error stopped the resolve"),
        }),
      ),
    );
  });
});
