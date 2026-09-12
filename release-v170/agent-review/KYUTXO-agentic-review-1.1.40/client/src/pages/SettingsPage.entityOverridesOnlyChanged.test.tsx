// @vitest-environment jsdom
//
// Coverage for the "Only show changed" toggle (data-testid
// `switch-overrides-only-changed`) inside the *merge-mode* entity-list import
// confirmation dialog (Settings > Privacy Audit Entity List). A merge can
// override bundled entries with an incoming entry that is byte-for-byte
// identical to the bundled one (same name / category / source note) — those are
// no-op overrides. The toggle hides those identical overrides so the user only
// sees the overrides that actually change something.
//
// The sibling tests cover the category dropdown + text search; this file drives
// the toggle and how it combines with both. We assert on the rendered override
// rows (the toggle narrows `filteredOverrides`, which feeds the virtualized
// list) and on the Overrides tab's "N changed" label.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so without these shims the
// virtualized Overrides list renders zero rows and the row assertions could
// never run. Provide a minimal ResizeObserver and a non-zero rect.
const FAKE_RECT: DOMRect = {
  width: 400,
  height: 500,
  top: 0,
  left: 0,
  right: 400,
  bottom: 500,
  x: 0,
  y: 0,
  toJSON() {},
};

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 400;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 500;
    },
  });
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return FAKE_RECT;
  };
});

// useAuth throws outside an AuthProvider; the entity panel doesn't need it.
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

// Unrelated heavy sibling panels — stub so they don't interfere.
vi.mock("@/components/VocabularyManager", () => ({ default: () => null }));
vi.mock("@/components/StripMarkersPanel", () => ({ default: () => null }));
vi.mock("@/components/MigrationAuditPanel", () => ({ default: () => null }));
vi.mock("@/components/LegacyRecoveryPanel", () => ({ default: () => null }));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. The category-filter state path stays real.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = () => null;
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children }: any) => {
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
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) =>
      React.createElement("option", { value }, children),
  };
});

const SettingsPage = (await import("./SettingsPage")).default;
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
const { putSettings } = await import("@/lib/data/settings-crud");
const { resetActiveEntityList, getBundledEntityList } = await import(
  "@/lib/privacy-entity-list"
);
import type { EntityEntry } from "@/lib/privacy-entity-list";
import type { Settings } from "@/lib/db-types";

// Four real bundled exchange entries (looked up by address at runtime so the
// "identical" overrides copy the exact bundled name / category / sourceNote and
// therefore register as no-op overrides).
const ADDR = {
  c0: "1EdiJAgeX91JvVie2LbHgNXhP4pdMxAUdn", // "796"
  c1: "1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv", // "Banx"
  i0: "13ozh1W6FDf8vtFsaLxTJtZgKtWm2WYBZC", // "BitBargain.co.uk"
  i1: "12HLwCH3haK8nA8J7hGtraxM3PgjXyt48a", // "BitcoinVietnam.com.vn"
} as const;

function bundled(address: string): EntityEntry {
  const found = getBundledEntityList().find((e) => e.address === address);
  if (!found) throw new Error(`bundled entry not found: ${address}`);
  return found;
}

function fakeFile(name: string, contents: string) {
  return { name, text: async () => contents } as unknown as File;
}

function selectEntityFile(name: string, contents: string) {
  const input = screen.getByTestId("input-entity-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(name, contents)] } });
}

function renderPage() {
  renderWithSettingsProviders(<SettingsPage />);
}

function overridesTabText() {
  return screen.getByTestId("tab-entity-diff-overrides").textContent ?? "";
}

function toggleOnlyChanged() {
  fireEvent.click(screen.getByTestId("switch-overrides-only-changed"));
}

function setCategory(value: string) {
  fireEvent.change(screen.getByTestId("select-entity-diff-category"), {
    target: { value },
  });
}

function typeSearch(value: string) {
  fireEvent.change(screen.getByTestId("input-entity-diff-search"), {
    target: { value },
  });
}

// Count the currently rendered override rows (testids are indexed within the
// filtered array, so a contiguous count reflects what the toggle/filters show).
function overrideRowCount() {
  return screen.queryAllByTestId(/^row-entity-override-\d+$/).length;
}

// An override row shows the previous name (struck through) AND the incoming
// name, so an identical override renders its name twice. Use a count check
// instead of getByText (which throws on multiple matches).
function hasText(text: string) {
  return screen.queryAllByText(text).length > 0;
}

// Opens the merge diff with a snapshot of 4 overrides: 2 that actually change
// the bundled entry (C0 renamed + recategorised to gambling, C1 renamed) and 2
// that are byte-for-byte identical to the bundled entry (I0, I1).
async function openMergeDiff() {
  renderPage();
  await screen.findByTestId("badge-entity-source");

  const c0 = bundled(ADDR.c0);
  const c1 = bundled(ADDR.c1);
  const i0 = bundled(ADDR.i0);
  const i1 = bundled(ADDR.i1);

  fireEvent.click(screen.getByTestId("radio-entity-merge"));

  const snapshot = JSON.stringify([
    // Changed: new name + new category.
    { address: c0.address, name: "Zorptast Renamed", category: "gambling", sourceNote: c0.sourceNote },
    // Changed: new name only (category unchanged).
    { address: c1.address, name: "Qwizzle Renamed", category: c1.category, sourceNote: c1.sourceNote },
    // Identical no-op overrides (exact copies of the bundled entries).
    { ...i0 },
    { ...i1 },
  ]);
  selectEntityFile("overrides.json", snapshot);

  await screen.findByTestId("text-preview-incoming");
  fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
  await screen.findByTestId("tab-entity-diff-overrides");

  return { c0, c1, i0, i1 };
}

beforeEach(async () => {
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — merge overrides 'Only show changed' toggle", () => {
  it("narrows the Overrides list to only changed overrides and back", async () => {
    await openMergeDiff();

    // 4 overrides, 2 of which change the bundled entry. The label always reports
    // both the total and the changed count regardless of the toggle.
    expect(overridesTabText()).toContain("Overrides (4, 2 changed)");

    // Toggle is off by default: all four override rows are present, including
    // the identical no-op overrides.
    expect(overrideRowCount()).toBe(4);
    expect(hasText("BitBargain.co.uk")).toBe(true);
    expect(hasText("BitcoinVietnam.com.vn")).toBe(true);
    expect(hasText("Zorptast Renamed")).toBe(true);
    expect(hasText("Qwizzle Renamed")).toBe(true);

    // Turn the toggle on: only the two changed overrides remain.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRowCount()).toBe(2));
    expect(hasText("Zorptast Renamed")).toBe(true);
    expect(hasText("Qwizzle Renamed")).toBe(true);
    // The identical no-op overrides are hidden.
    expect(hasText("BitBargain.co.uk")).toBe(false);
    expect(hasText("BitcoinVietnam.com.vn")).toBe(false);
    // The tab label is unaffected — it always reports the full counts.
    expect(overridesTabText()).toContain("Overrides (4, 2 changed)");

    // Turn it back off: all four rows return.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRowCount()).toBe(4));
    expect(hasText("BitBargain.co.uk")).toBe(true);
  });

  it("shows the no-op empty label when a category has only identical overrides and the toggle is on", async () => {
    const { i0 } = await openMergeDiff();

    // Filter to the identical overrides' (exchange) category — but that also
    // includes the changed ones, so first narrow with a search that matches only
    // an identical override.
    typeSearch("bitbargain");
    await waitFor(() => expect(overridesTabText()).toContain("Overrides (1, 0 changed)"));
    // The single matching override (identical) is shown while the toggle is off.
    expect(hasText("BitBargain.co.uk")).toBe(true);

    // With the toggle on, that identical override is hidden and the dedicated
    // "every match is identical" empty label is shown.
    toggleOnlyChanged();
    expect(
      (await screen.findByTestId("text-entity-overrides-empty")).textContent,
    ).toContain("No overrides change anything");
    expect(hasText("BitBargain.co.uk")).toBe(false);

    // Sanity: the category of that identical override is the exchange category.
    expect(i0.category).toBe("exchange");
  });

  it("combines with the category dropdown", async () => {
    await openMergeDiff();

    // Toggle on first: only the two changed overrides across all categories.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRowCount()).toBe(2));

    // Narrow to the "gambling" category: only C0 (re-categorised to gambling)
    // matches, and it is a changed override, so one row remains.
    setCategory("gambling");
    await waitFor(() => expect(overrideRowCount()).toBe(1));
    expect(hasText("Zorptast Renamed")).toBe(true);
    expect(hasText("Qwizzle Renamed")).toBe(false);
    // Only override under gambling, and it is changed, so the equal-count label
    // form (no ", N changed" suffix) is used.
    expect(overridesTabText()).toContain("Overrides (1)");

    // Back to "all": both changed overrides are visible again (toggle still on).
    setCategory("all");
    await waitFor(() => expect(overrideRowCount()).toBe(2));
  });

  it("combines with the text search", async () => {
    await openMergeDiff();

    // A token unique to one changed override.
    typeSearch("zorptast");
    await waitFor(() => expect(overridesTabText()).toContain("Overrides (1)"));
    expect(overrideRowCount()).toBe(1);
    expect(hasText("Zorptast Renamed")).toBe(true);

    // Toggle on keeps the changed match visible.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRowCount()).toBe(1));
    expect(hasText("Zorptast Renamed")).toBe(true);

    // Search a token unique to an identical override: with the toggle on it is
    // filtered out (no-op), so nothing is shown.
    typeSearch("bitcoinvietnam");
    await waitFor(() =>
      expect(screen.queryByTestId("text-entity-overrides-empty")).toBeTruthy(),
    );
    expect(overrideRowCount()).toBe(0);

    // Turning the toggle off reveals the identical override that matches the
    // search.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRowCount()).toBe(1));
    expect(hasText("BitcoinVietnam.com.vn")).toBe(true);
  });
});
