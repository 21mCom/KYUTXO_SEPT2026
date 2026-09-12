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
const privacyHistoryCrud = await import("@/lib/data/privacy-history-crud");
const { getPrivacyAuditHistoryCount, getPrivacyAuditHistory } =
  privacyHistoryCrud;
const useSettings = await import("@/hooks/use-settings");
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
  vi.restoreAllMocks();
});

async function lowerLimitTo(value: string) {
  const select = (await screen.findByTestId(
    "select-privacy-history-limit",
  )) as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
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

    // The exact set of timestamps we seeded — after a cancel these must all
    // still be present, untouched. (No silent partial deletion.)
    const base = 1_700_000_000_000;
    const seededTimestamps = Array.from(
      { length: 60 },
      (_, i) => base + i * 60_000,
    );

    renderWithSettingsProviders(<SettingsPage />);

    const select = (await screen.findByTestId(
      "select-privacy-history-limit",
    )) as HTMLSelectElement;
    // The limit before any change (default 30, since none is persisted).
    const priorLimit = select.value;
    expect(priorLimit).toBe("30");

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

    // The surviving runs are EXACTLY the original seeded set — every timestamp
    // is still there, nothing was partially deleted.
    const remaining = await getPrivacyAuditHistory();
    const remainingTimestamps = remaining.map((r) => r.timestamp).sort((a, b) => a - b);
    expect(remainingTimestamps).toEqual(seededTimestamps);

    // The Select snaps back to the prior limit (not the rejected value of 10),
    // so a misclick is fully reversible.
    expect(
      (screen.getByTestId("select-privacy-history-limit") as HTMLSelectElement)
        .value,
    ).toBe(priorLimit);
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

  it("trims immediately to the new limit, keeping the most recent runs (oldest first)", async () => {
    // 25 runs, default limit 30. Lowering to 10 removes 15 (<=20), applying
    // straight away. seedRuns gives strictly increasing timestamps, so the 10
    // survivors must be the newest 10 (timestamps for indices 15..24).
    await seedRuns(25);

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");

    // The existing history is trimmed down to the new limit right away.
    await waitFor(async () =>
      expect(await getPrivacyAuditHistoryCount()).toBe(10),
    );

    const base = 1_700_000_000_000;
    const remaining = await getPrivacyAuditHistory();
    const timestamps = remaining.map((r) => r.timestamp);
    // Exactly the newest 10 timestamps survive; everything older was removed.
    expect(timestamps).toEqual(
      Array.from({ length: 10 }, (_, i) => base + (15 + i) * 60_000),
    );
  });

  it("raising the limit leaves existing runs untouched", async () => {
    // 25 runs, default limit 30. Raising to 50 removes nothing.
    await seedRuns(25);

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("50");

    // The new (higher) limit persists but no run is deleted and no toast fires.
    await waitFor(async () =>
      expect((await getSettings("default"))?.privacyHistoryLimit).toBe(50),
    );
    expect(await getPrivacyAuditHistoryCount()).toBe(25);
    expect(toastSpy).not.toHaveBeenCalled();
    // No confirmation dialog for a no-op (nothing would be removed).
    expect(screen.queryByTestId("button-confirm-history-trim")).toBeNull();
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

  it("still trims (and reports the removal) when the preview count lookup throws (Task #688)", async () => {
    // 60 stored runs, default limit 30. Lowering to 10 would normally remove 50
    // (>20), which is a large batch that would pop the confirmation dialog. But
    // here the count preview (getPrivacyAuditHistoryCount) throws, so the guard
    // can't compute removeCount. The retention guard must fail safe by applying
    // the trim directly — never silently skipping it, and never bypassing the
    // confirmation in a way that loses history without telling the user.
    await seedRuns(60);

    // Make the *preview* lookup reject once (the call inside
    // handlePrivacyHistoryLimitChange). The fallback applyPrivacyHistoryLimit
    // path doesn't read the count, so a single one-time rejection is enough;
    // the spy falls back to the real implementation for any later call.
    const countSpy = vi
      .spyOn(privacyHistoryCrud, "getPrivacyAuditHistoryCount")
      .mockRejectedValueOnce(new Error("count unavailable"));

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");

    // The preview was attempted and failed.
    await waitFor(() => expect(countSpy).toHaveBeenCalled());

    // No confirmation dialog: with no count, the guard falls through to applying
    // the trim directly rather than showing (or skipping) the dialog.
    expect(screen.queryByTestId("button-confirm-history-trim")).toBeNull();

    // The trim still happened: only the most-recent 10 remain and the new limit
    // persists. (Use the real count helper for this assertion — the destructured
    // reference points at the original implementation, not the spy.)
    await waitFor(async () =>
      expect(await getPrivacyAuditHistoryCount()).toBe(10),
    );
    expect((await getSettings("default"))?.privacyHistoryLimit).toBe(10);

    // And the removal toast still reports how many runs were deleted (60-10=50),
    // so the user is never left thinking nothing happened.
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
    expect(titles.some((t) => t.includes("50") && /run/i.test(t))).toBe(true);
  });

  it("warns the user (and shows no success toast) when the trim itself fails (Task #857)", async () => {
    // 25 runs, default limit 30. Lowering to 10 removes only 15 (<=20), so it
    // applies straight away with no confirmation step — i.e. it goes directly
    // through applyPrivacyHistoryLimit -> updatePrivacyHistoryLimit.
    await seedRuns(25);

    // Force the trim to fail. A failed trim must never pass silently: the user
    // would otherwise believe old runs were removed when they weren't.
    const trimSpy = vi
      .spyOn(useSettings, "updatePrivacyHistoryLimit")
      .mockRejectedValueOnce(new Error("trim failed"));

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");

    // The trim was attempted and rejected.
    await waitFor(() => expect(trimSpy).toHaveBeenCalledWith(10));

    // A destructive error toast tells the user the update failed.
    await waitFor(() => {
      const destructive = toastSpy.mock.calls.find(
        (c) => c[0]?.variant === "destructive",
      );
      expect(destructive?.[0]?.description).toBe(
        "Failed to update retention limit",
      );
    });

    // No success/removal toast ever fires — the user is not told runs were
    // removed when the trim actually failed.
    const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
    expect(titles.some((t) => /run/i.test(t))).toBe(false);
    expect(
      toastSpy.mock.calls.some((c) => c[0]?.variant !== "destructive"),
    ).toBe(false);

    // Nothing was removed (the rejecting spy short-circuited before any delete).
    expect(await getPrivacyAuditHistoryCount()).toBe(25);
  });

  it("snaps the Select back to the prior limit when the trim itself fails (Task #942)", async () => {
    // 25 runs, default limit 30. Lowering to 10 removes only 15 (<=20), so it
    // applies directly through applyPrivacyHistoryLimit -> updatePrivacyHistoryLimit
    // with no confirmation step. When that trim throws, the error toast fires —
    // but the Select must NOT stay stuck on the failed value (10); it has to
    // return to the previously persisted limit (30), exactly like a cancel does.
    await seedRuns(25);

    const trimSpy = vi
      .spyOn(useSettings, "updatePrivacyHistoryLimit")
      .mockRejectedValueOnce(new Error("trim failed"));

    renderWithSettingsProviders(<SettingsPage />);

    const select = (await screen.findByTestId(
      "select-privacy-history-limit",
    )) as HTMLSelectElement;
    // The limit before any change (default 30, since none is persisted).
    const priorLimit = select.value;
    expect(priorLimit).toBe("30");

    await lowerLimitTo("10");

    // The trim was attempted and rejected.
    await waitFor(() => expect(trimSpy).toHaveBeenCalledWith(10));

    // A destructive error toast tells the user the update failed.
    await waitFor(() => {
      const destructive = toastSpy.mock.calls.find(
        (c) => c[0]?.variant === "destructive",
      );
      expect(destructive?.[0]?.description).toBe(
        "Failed to update retention limit",
      );
    });

    // The Select reflects the prior limit (30), NOT the value that failed to
    // apply (10) — a failed trim is just as reversible as a cancel.
    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            "select-privacy-history-limit",
          ) as HTMLSelectElement
        ).value,
      ).toBe(priorLimit),
    );

    // And nothing was persisted, so the limit really is still the old one.
    expect((await getSettings("default"))?.privacyHistoryLimit).toBeUndefined();
  });

  it("warns the user when a large-batch trim fails after the user confirms (Task #857)", async () => {
    // 60 runs, default limit 30. Lowering to 10 removes 50 (>20), which pops the
    // confirmation dialog. Confirming routes through applyPrivacyHistoryLimit,
    // where the trim then fails — the user must still be warned.
    await seedRuns(60);

    const trimSpy = vi
      .spyOn(useSettings, "updatePrivacyHistoryLimit")
      .mockRejectedValueOnce(new Error("trim failed"));

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");
    fireEvent.click(await screen.findByTestId("button-confirm-history-trim"));

    await waitFor(() => expect(trimSpy).toHaveBeenCalledWith(10));

    // Destructive error toast shown, no success/removal toast.
    await waitFor(() => {
      const destructive = toastSpy.mock.calls.find(
        (c) => c[0]?.variant === "destructive",
      );
      expect(destructive?.[0]?.description).toBe(
        "Failed to update retention limit",
      );
    });
    const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
    expect(titles.some((t) => /run/i.test(t))).toBe(false);

    // History is intact since the trim rejected.
    expect(await getPrivacyAuditHistoryCount()).toBe(60);
  });

  it("restores a missing default settings row before saving the retention limit", async () => {
    // 25 runs, default limit 30. Lowering to 10 removes only 15 (<=20), so the
    // guard skips the confirm dialog and applies the trim directly. Start with
    // the canonical row missing to exercise the page's settings recovery path.
    await seedRuns(25);
    // Remove the row that beforeEach seeded.
    const { clearSettings } = await import("@/lib/data/settings-crud");
    await clearSettings({ skipNotification: true });
    expect(await getSettings("default")).toBeUndefined();

    renderWithSettingsProviders(<SettingsPage />);

    const select = (await screen.findByTestId(
      "select-privacy-history-limit",
    )) as HTMLSelectElement;
    // With no persisted row the Select shows the default limit (30).
    const priorLimit = select.value;
    expect(priorLimit).toBe("30");

    await lowerLimitTo("10");

    // The recovered row accepts the update and the trim reports its exact work.
    await waitFor(() => {
      const success = toastSpy.mock.calls.find(
        (c) => c[0]?.title === "Removed 15 older runs",
      );
      expect(success?.[0]?.description).toBe(
        "Older Privacy Audit runs beyond the new limit were deleted.",
      );
    });

    expect((await getSettings("default"))?.privacyHistoryLimit).toBe(10);
    expect(await getPrivacyAuditHistoryCount()).toBe(10);

    // The control reflects the recovered, persisted value.
    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            "select-privacy-history-limit",
          ) as HTMLSelectElement
        ).value,
      ).toBe("10"),
    );
  });

  it("surfaces a destructive error toast (and reports no removal) when the underlying data-layer trim rejects (Task #868)", async () => {
    // 25 runs, default limit 30. Lowering to 10 removes only 15 (<=20), so the
    // guard skips the confirm dialog and applies the trim directly. Unlike the
    // Task #857 tests above (which mock updatePrivacyHistoryLimit itself), this
    // spies the data-layer trimPrivacyAuditHistory so the REAL
    // updatePrivacyHistoryLimit runs and must propagate the failure up to the
    // user — never silently doing nothing and never falsely reporting a removal.
    await seedRuns(25);

    // updatePrivacyHistoryLimit (in use-settings) calls trimPrivacyAuditHistory
    // as a live-binding named import from this same module, so spying on the
    // namespace makes that call reject. One-time rejection is enough.
    const trimSpy = vi
      .spyOn(privacyHistoryCrud, "trimPrivacyAuditHistory")
      .mockRejectedValueOnce(new Error("trim failed"));

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");

    // The trim was attempted and rejected.
    await waitFor(() => expect(trimSpy).toHaveBeenCalled());

    // No confirmation dialog for a small batch.
    expect(screen.queryByTestId("button-confirm-history-trim")).toBeNull();

    // The destructive error toast fires...
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const errorCall = toastSpy.mock.calls.find(
      (c) => c[0]?.variant === "destructive",
    );
    expect(errorCall).toBeTruthy();
    expect(errorCall?.[0]?.description).toMatch(/retention limit/i);

    // ...and no toast ever claims runs were removed.
    const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
    expect(titles.some((t) => /removed/i.test(t))).toBe(false);

    // The data is untouched: a failed trim must not delete any runs. (Use the
    // real count helper — the destructured ref points at the original impl.)
    expect(await getPrivacyAuditHistoryCount()).toBe(25);
  });

  it("rolls the saved limit back when the data-layer trim fails, so persisted state matches the 'failed' toast (Task #959)", async () => {
    // 25 runs, default limit 30. Lowering to 10 removes only 15 (<=20), so the
    // guard skips the confirm dialog and applies the trim directly through the
    // REAL updatePrivacyHistoryLimit. updatePrivacyHistoryLimit persists the new
    // limit and trims in one atomic transaction: when the trim throws, the limit
    // write must roll back too. Otherwise the user is told the update "failed"
    // while privacyHistoryLimit is silently saved as 10 and the on-disk history
    // stays at 25 — the persisted state and the toast would disagree.
    await seedRuns(25);

    // No limit is persisted yet (beforeEach seeds a bare 'default' row), so the
    // effective limit is the default of 30.
    expect((await getSettings("default"))?.privacyHistoryLimit).toBeUndefined();

    // Make the data-layer trim reject once, after updatePrivacyHistoryLimit has
    // already written the new limit inside the transaction.
    const trimSpy = vi
      .spyOn(privacyHistoryCrud, "trimPrivacyAuditHistory")
      .mockRejectedValueOnce(new Error("trim failed"));

    renderWithSettingsProviders(<SettingsPage />);

    await lowerLimitTo("10");

    // The trim was attempted and rejected.
    await waitFor(() => expect(trimSpy).toHaveBeenCalled());

    // The destructive error toast tells the user the update failed.
    await waitFor(() => {
      const destructive = toastSpy.mock.calls.find(
        (c) => c[0]?.variant === "destructive",
      );
      expect(destructive?.[0]?.description).toMatch(/retention limit/i);
    });

    // CONTRACT: the failed trim rolled the limit write back, so the persisted
    // state matches the "failed" toast — privacyHistoryLimit is NOT left saved
    // as the rejected value (10); it stays unset (the default of 30 applies).
    expect((await getSettings("default"))?.privacyHistoryLimit).toBeUndefined();

    // And the history is intact: nothing was removed.
    expect(await getPrivacyAuditHistoryCount()).toBe(25);
    const titles = toastSpy.mock.calls.map((c) => c[0]?.title ?? "");
    expect(titles.some((t) => /removed/i.test(t))).toBe(false);
  });
});
