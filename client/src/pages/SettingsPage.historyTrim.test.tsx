// @vitest-environment jsdom
//
// Page-level coverage for the "large batch" confirmation guard on the Privacy
// Audit History retention limit (Task #554). The data-layer count helper
// (getPrivacyAuditHistoryCount) and the trim itself (trimPrivacyAuditHistory)
// are unit-tested elsewhere; this file drives the actual SettingsPage flow that
// wires them together:
//   - lowering the limit so >20 runs would be deleted pops a confirm dialog that
//     names the exact count, and applies nothing until the user confirms
//   - cancelling leaves the limit unchanged and deletes nothing
//   - confirming trims the runs and shows the removal toast
//   - a small trim (<=20 removed) applies immediately with no dialog
//
// We use the real Dexie database (fake-indexeddb), the real settings-crud and
// privacy-history-crud modules so the whole chain runs end to end. The Select is
// swapped for a native <select> (Radix Select doesn't open under jsdom), the
// toast is a spy, and the unrelated heavy sibling panels / auth context are
// stubbed so the test stays focused on the retention guard.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// A hoisted toast spy so the mocked useToast hands back the same fn we assert on.
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. The trigger's data-testid is forwarded onto the
// native <select> so the existing test id keeps working.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = (props: any) => {
    void props;
    return null;
  };
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children, disabled }: any) => {
      let testid: string | undefined;
      React.Children.forEach(children, (child: any) => {
        if (child && child.type && child.type.__isTrigger) {
          testid = child.props["data-testid"];
        }
      });
      return React.createElement(
        "select",
        {
          "data-testid": testid,
          value: value ?? "",
          disabled,
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) => React.createElement("option", { value }, children),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// useAuth throws outside an AuthProvider; this panel doesn't need it, so stub it.
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

// Unrelated heavy sibling panels (own DB queries / auth) — stub so they don't
// interfere with the retention guard under test.
vi.mock("@/components/VocabularyManager", () => ({ default: () => null }));
vi.mock("@/components/StripMarkersPanel", () => ({ default: () => null }));
vi.mock("@/components/MigrationAuditPanel", () => ({ default: () => null }));
vi.mock("@/components/LegacyRecoveryPanel", () => ({ default: () => null }));

const SettingsPage = (await import("./SettingsPage")).default;
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
const { putSettings, getSettings } = await import("@/lib/data/settings-crud");
const { getPrivacyAuditHistoryCount } = await import("@/lib/data/privacy-history-crud");
const { db } = await import("@/lib/database");
import type { Settings } from "@/lib/db-types";

beforeAll(() => {
  // Radix dialogs/selects call scrollIntoView, which jsdom doesn't implement.
  Element.prototype.scrollIntoView = vi.fn();
});

// Seed `count` audit runs directly (bypassing addPrivacyAuditHistoryEntry, which
// auto-trims to the retention limit) with increasing timestamps so the trim's
// oldest-first ordering is well defined.
async function seedRuns(count: number) {
  const base = 1_700_000_000_000;
  const rows = Array.from({ length: count }, (_, i) => ({
    timestamp: base + i * 60_000,
    score: 80,
    grade: "B",
    totalFindings: 0,
    transactionsAnalyzed: 1,
    addressesScanned: 1,
    severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    findingTypeCounts: {},
  }));
  await db.privacyAuditHistory.bulkAdd(rows as any);
}

beforeEach(async () => {
  // The real app always has a 'default' settings row; updateSettings is a no-op
  // when it's absent, so seed one before each test. A put replaces the whole
  // row, so this also clears any privacyHistoryLimit left by a prior test
  // (limit then falls back to the default of 30).
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  await db.privacyAuditHistory.clear();
  toastSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

async function lowerLimitTo(value: string) {
  const select = (await screen.findByTestId(
    "select-privacy-history-limit",
  )) as HTMLSelectElement;
  fireEvent.change(select, { target: { value } });
}

describe("SettingsPage — Privacy Audit History retention guard", () => {
  it("warns with the exact count before deleting a large batch and applies nothing yet", async () => {
    // 60 stored runs, default limit 30. Lowering to 10 would remove 50 (>20).
    await seedRuns(60);

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");

    // Confirm dialog appears naming the exact number of runs to be removed and
    // the count to be kept.
    const confirmBtn = await screen.findByTestId("button-confirm-history-trim");
    expect(confirmBtn).toBeTruthy();
    const dialog = confirmBtn.closest("[role='alertdialog']") ?? document.body;
    expect(dialog.textContent).toContain("50");
    expect(dialog.textContent).toContain("10");

    // Nothing removed and nothing persisted while the dialog is still open.
    expect(await getPrivacyAuditHistoryCount()).toBe(60);
    expect((await getSettings("default"))?.privacyHistoryLimit).toBeUndefined();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("cancelling the dialog leaves the limit unchanged and deletes nothing", async () => {
    await seedRuns(60);

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");
    fireEvent.click(await screen.findByTestId("button-cancel-history-trim"));

    // Dialog closes...
    await waitFor(() =>
      expect(screen.queryByTestId("button-confirm-history-trim")).toBeNull(),
    );

    // ...and the whole history survives with the limit untouched.
    expect(await getPrivacyAuditHistoryCount()).toBe(60);
    expect((await getSettings("default"))?.privacyHistoryLimit).toBeUndefined();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("confirming trims the runs and shows the removal toast", async () => {
    await seedRuns(60);

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");
    fireEvent.click(await screen.findByTestId("button-confirm-history-trim"));

    // Trim happens: only the most-recent 10 remain and the new limit persists.
    await waitFor(async () =>
      expect(await getPrivacyAuditHistoryCount()).toBe(10),
    );
    expect((await getSettings("default"))?.privacyHistoryLimit).toBe(10);

    // The removal toast reports how many runs were deleted (60 - 10 = 50).
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
    expect(titles.some((t) => t.includes("50") && /run/i.test(t))).toBe(true);

    // Dialog closed.
    await waitFor(() =>
      expect(screen.queryByTestId("button-confirm-history-trim")).toBeNull(),
    );
  });

  it("a small trim (<=20 removed) applies immediately with no dialog", async () => {
    // 25 runs, default limit 30. Lowering to 10 removes only 15 (<=20), so it
    // applies straight away with no confirmation step.
    await seedRuns(25);

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");

    // Trim applied directly: 10 remain, limit persisted, removal toast shown.
    await waitFor(async () =>
      expect(await getPrivacyAuditHistoryCount()).toBe(10),
    );
    expect((await getSettings("default"))?.privacyHistoryLimit).toBe(10);
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
    expect(titles.some((t) => t.includes("15") && /run/i.test(t))).toBe(true);

    // The confirmation dialog never appeared.
    expect(screen.queryByTestId("button-confirm-history-trim")).toBeNull();
  });
});
