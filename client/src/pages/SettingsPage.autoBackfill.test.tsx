// @vitest-environment jsdom
//
// UI coverage for the end-to-end "Fix now" flow (Task #643). The
// OrphanedTxNotifier toast button sets sessionStorage["kyutxo:autoBackfill"]
// = "1" and navigates to /settings. This test covers the CONSUMER side: the
// Settings page reads that one-shot flag on mount and automatically starts the
// missing-transaction rebuild, then clears the flag so a later visit does not
// re-trigger a rebuild.
//
// We drive the real autoBackfill useEffect + handleManualBackfill() wiring and
// only stub detectAndBackfill (the engine) so we can assert it auto-starts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom has no layout engine; the autoBackfill effect calls scrollIntoView on
  // the rebuild section before starting the rebuild.
  (Element.prototype as any).scrollIntoView = vi.fn();
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

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

// Engine stub: a backfill that holds open (via a gate) so the test can observe
// the auto-started rebuild dialog before it completes, then resolves to a
// no-orphans result.
let backfillGate: () => void = () => {};
const detectSpy = vi.fn(
  async ({ onProgress }: { signal?: AbortSignal; onProgress?: (p: any) => void } = {}) => {
    onProgress?.({ phase: "scanning", orphansFound: 0, processed: 0 });
    await new Promise<void>((res) => {
      backfillGate = res;
    });
    onProgress?.({ phase: "complete", orphansFound: 0, processed: 0 });
    return {
      orphansFound: 0,
      rebuilt: 0,
      skipped: 0,
      failed: 0,
      deferred: false,
      errors: [],
    };
  },
);

vi.mock("@/lib/txid-backfill", () => ({
  detectAndBackfill: detectSpy,
  detectOrphanedTxRecords: vi.fn(),
  runTxidBackfill: vi.fn(),
  resolveAllBlankInputAddresses: vi.fn(),
}));

const SettingsPage = (await import("./SettingsPage")).default;
const { ActivityBusProvider } = await import("@/lib/activity-bus");
const { putSettings } = await import("@/lib/data/settings-crud");
import type { Settings } from "@/lib/db-types";

beforeEach(async () => {
  toastSpy.mockClear();
  detectSpy.mockClear();
  backfillGate = () => {};
  sessionStorage.clear();
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
});

afterEach(() => {
  cleanup();
});

describe("SettingsPage — autoBackfill 'Fix now' flag", () => {
  it("auto-starts the rebuild when the autoBackfill flag is set on mount", async () => {
    sessionStorage.setItem("kyutxo:autoBackfill", "1");

    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );

    // The rebuild auto-starts: the engine is invoked and the progress dialog
    // appears without any user interaction.
    await waitFor(() => expect(detectSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("dialog-backfill-transactions")).toBeTruthy();

    // Let the held backfill finish so the page settles.
    backfillGate();
    await waitFor(() =>
      expect(screen.queryByTestId("dialog-backfill-transactions")).toBeNull(),
    );
  });

  it("clears the flag after consumption so a later visit does not re-trigger", async () => {
    sessionStorage.setItem("kyutxo:autoBackfill", "1");

    const first = render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );

    // First mount consumes the flag and auto-starts the rebuild.
    await waitFor(() => expect(detectSpy).toHaveBeenCalledTimes(1));

    // The one-shot flag must be removed immediately on consumption.
    expect(sessionStorage.getItem("kyutxo:autoBackfill")).toBeNull();

    // Finish + unmount the first instance.
    backfillGate();
    await waitFor(() =>
      expect(first.queryByTestId("dialog-backfill-transactions")).toBeNull(),
    );
    first.unmount();
    cleanup();
    detectSpy.mockClear();

    // A fresh visit (no flag set) must NOT auto-start another rebuild.
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );

    await screen.findByTestId("button-rebuild-transactions");
    // Give the mount effects a tick to run; the engine must stay untouched.
    await new Promise((res) => setTimeout(res, 50));
    expect(detectSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("dialog-backfill-transactions")).toBeNull();
  });
});
