// @vitest-environment jsdom
//
// Component coverage for the *merge-mode* path of the Privacy Audit "Entity
// List" import confirmation dialog inside the Settings page. The pure
// preview/diff math (buildEntitySnapshotPreview) is unit-tested at the store
// layer; this file drives the actual dialog wiring that surfaces it so a
// regression in the merge UI (the "+X brand-new" / "Y override bundled"
// badges, the "After merge" count, the override note, and the Overrides tab's
// EntityOverrideList old→new rows) would be caught.
//
// We use the real entity-list-store + privacy-entity-list modules so the merge
// preview is computed against the actual bundled list. Only the auth context
// and the unrelated heavy sibling panels are stubbed.

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
// virtualized Overrides list would render zero rows and the old→new assertions
// could never run. Provide a minimal ResizeObserver and a non-zero
// getBoundingClientRect so the virtualizer produces its overscan window.
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
  // @tanstack/virtual-core sizes the scroll viewport from the element's
  // offsetWidth/offsetHeight (see getRect), which jsdom always reports as 0.
  // Override them so the virtualizer computes a non-empty visible range.
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
  // A no-op ResizeObserver is enough: virtual-core takes an initial synchronous
  // measurement from getRect (offsetWidth/offsetHeight) when it starts observing.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return FAKE_RECT;
  };
});

// useAuth throws outside an AuthProvider; the entity panel doesn't need it, so
// stub it to a benign value.
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
// interfere with the entity-list panel under test.
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
const { ActivityBusProvider } = await import("@/lib/activity-bus");
const { putSettings } = await import("@/lib/data/settings-crud");
const {
  resetActiveEntityList,
  getBundledEntityCount,
  getBundledEntityList,
} = await import("@/lib/privacy-entity-list");
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses that are NOT in the bundled list, so they count as
// brand-new in a merge preview.
const NEW_ADDR = {
  a: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  b: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
} as const;

function fakeFile(name: string, contents: string) {
  // The handler only uses file.name and file.text().
  return { name, text: async () => contents } as unknown as File;
}

async function selectEntityFile(name: string, contents: string) {
  const input = screen.getByTestId("input-entity-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(name, contents)] } });
}

function renderPage() {
  render(
    <ActivityBusProvider>
      <SettingsPage />
    </ActivityBusProvider>,
  );
}

beforeEach(async () => {
  // The real app always has a 'default' settings row; seed one so updateSettings
  // is not a no-op. A put replaces the whole row, clearing any prior snapshot.
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — entity list import (merge mode)", () => {
  it("shows brand-new + override badges, the after-merge count, and the override row", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const bundledCount = getBundledEntityCount();
    // Pick a real bundled entry so the incoming snapshot overrides it.
    const bundled = getBundledEntityList()[0];
    expect(bundled).toBeTruthy();

    // Switch to merge mode BEFORE selecting the file (the preview is computed at
    // selection time using the current mode).
    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const snapshot = JSON.stringify([
      // Overrides a bundled entry with a different name + category.
      { address: bundled.address, name: "Renamed Entity", category: "gambling" },
      // A brand-new entry not present in the bundled list.
      { address: NEW_ADDR.a, name: "Fresh Mixer", category: "mixer" },
    ]);
    await selectEntityFile("merge.json", snapshot);

    // Preview dialog appears.
    const incoming = await screen.findByTestId("text-preview-incoming");
    expect(incoming.textContent).toBe("2");

    // "After merge" count = bundled + 1 brand-new.
    expect(screen.getByTestId("text-preview-current").textContent).toBe(
      (bundledCount + 1).toLocaleString(),
    );

    // Merge-specific badges: 1 brand-new, 1 override bundled.
    expect(screen.getByTestId("badge-preview-added").textContent).toContain(
      "+1 brand-new",
    );
    expect(
      screen.getByTestId("badge-preview-overridden").textContent,
    ).toContain("1 override bundled");

    // The replace-mode badges should not be present in merge mode.
    expect(screen.queryByTestId("badge-preview-removed")).toBeNull();
    expect(screen.queryByTestId("badge-preview-changed")).toBeNull();

    // The override note is surfaced since at least one bundled entry is overridden.
    expect(screen.getByTestId("text-merge-override-note")).toBeTruthy();

    // Expand the affected-entries diff (defaults to the Overrides tab).
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));

    const overridesTab = await screen.findByTestId("tab-entity-diff-overrides");
    expect(overridesTab.textContent).toContain("Overrides (1)");
    expect(
      screen.getByTestId("tab-entity-diff-added").textContent,
    ).toContain("Brand-new (1)");

    // The Overrides tab lists the overridden entry old → new (name + category).
    const row = await screen.findByTestId("row-entity-override-0");
    const rowEl = within(row);
    // Old name (struck through) and new name.
    expect(rowEl.getByText(bundled.name)).toBeTruthy();
    expect(rowEl.getByText("Renamed Entity")).toBeTruthy();
    // Old category label and the new category label ("Gambling").
    expect(rowEl.getByText("Gambling")).toBeTruthy();
    // The overridden address is shown.
    expect(row.textContent).toContain(bundled.address);
  });

  it("reports zero overrides when the merge only adds brand-new entries", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const bundledCount = getBundledEntityCount();

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const snapshot = JSON.stringify([
      { address: NEW_ADDR.a, name: "New Exchange", category: "exchange" },
      { address: NEW_ADDR.b, name: "New Mixer", category: "mixer" },
    ]);
    await selectEntityFile("merge-new-only.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    // Both are brand-new; nothing overrides the bundled list.
    expect(screen.getByTestId("badge-preview-added").textContent).toContain(
      "+2 brand-new",
    );
    expect(
      screen.getByTestId("badge-preview-overridden").textContent,
    ).toContain("0 override bundled");

    // After-merge count = bundled + 2.
    expect(screen.getByTestId("text-preview-current").textContent).toBe(
      (bundledCount + 2).toLocaleString(),
    );

    // No override note when nothing is overridden.
    expect(screen.queryByTestId("text-merge-override-note")).toBeNull();

    // Expanding the diff shows an empty Overrides tab.
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    const overridesTab = await screen.findByTestId("tab-entity-diff-overrides");
    expect(overridesTab.textContent).toContain("Overrides (0)");
    expect(
      await screen.findByTestId("text-entity-overrides-empty"),
    ).toBeTruthy();
  });
});

describe("SettingsPage — entity list import (merge mode) diff filters", () => {
  // A merge whose preview has 1 override + 2 brand-new entries in distinct
  // categories, so search and category filters have something to narrow.
  async function openMergeDiff() {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const bundled = getBundledEntityList()[0];
    expect(bundled).toBeTruthy();

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const snapshot = JSON.stringify([
      // Overrides a bundled entry (re-categorised to gambling).
      { address: bundled.address, name: "Renamed Override Entity", category: "gambling" },
      // Two brand-new entries with unique, search-distinct names.
      { address: NEW_ADDR.a, name: "Qwizzle Mixer", category: "mixer" },
      { address: NEW_ADDR.b, name: "Zorptast Exchange", category: "exchange" },
    ]);
    await selectEntityFile("merge-filters.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");
    return { bundled };
  }

  function overridesTabText() {
    return screen.getByTestId("tab-entity-diff-overrides").textContent ?? "";
  }
  function addedTabText() {
    return screen.getByTestId("tab-entity-diff-added").textContent ?? "";
  }
  function typeSearch(value: string) {
    fireEvent.change(screen.getByTestId("input-entity-diff-search"), {
      target: { value },
    });
  }
  function setCategory(value: string) {
    fireEvent.change(screen.getByTestId("select-entity-diff-category"), {
      target: { value },
    });
  }
  // Radix Tabs default to "automatic" activation (a trigger activates when it
  // receives focus). jsdom's fireEvent.click doesn't move focus, so focus the
  // trigger explicitly to switch tabs.
  function openAddedTab() {
    const trigger = screen.getByTestId("tab-entity-diff-added");
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
  }

  it("narrows the override/brand-new tab counts and visible rows as the search box is typed", async () => {
    await openMergeDiff();

    // Baseline: 1 override, 2 brand-new. The Overrides tab is active by default
    // so its single row is on screen.
    expect(overridesTabText()).toContain("Overrides (1");
    expect(addedTabText()).toContain("Brand-new (2)");
    expect(screen.getByTestId("row-entity-override-0")).toBeTruthy();

    // A token unique to one brand-new entry: the override (different name +
    // bundled name/address) and the other brand-new entry don't match.
    typeSearch("qwizzle");

    await waitFor(() => expect(addedTabText()).toContain("Brand-new (1)"));
    expect(overridesTabText()).toContain("Overrides (0");

    // The override list is now empty (filtered out).
    expect(
      await screen.findByTestId("text-entity-overrides-empty"),
    ).toBeTruthy();

    // Switch to the Brand-new tab: only the matching entry's row is rendered.
    openAddedTab();
    const addedRow = await screen.findByTestId("row-entity-diff-added-0");
    expect(within(addedRow).getByText("Qwizzle Mixer")).toBeTruthy();
    expect(screen.queryByText("Zorptast Exchange")).toBeNull();
  });

  it("filters the override and brand-new lists by the category dropdown", async () => {
    const { bundled } = await openMergeDiff();
    // An override matches a category if either side (previous bundled category
    // or the incoming gambling category) equals it.
    const overridesUnder = (cat: string) =>
      cat === "gambling" || bundled.category === cat ? 1 : 0;

    // Gambling matches the override (incoming category) but neither brand-new
    // entry (mixer / exchange).
    setCategory("gambling");
    await waitFor(() => expect(overridesTabText()).toContain("Overrides (1"));
    expect(addedTabText()).toContain("Brand-new (0)");
    // The override row is still present on the (active) Overrides tab.
    expect(screen.getByTestId("row-entity-override-0")).toBeTruthy();
    // The Brand-new tab is empty under this category.
    openAddedTab();
    expect(
      (await screen.findByTestId("text-entity-diff-empty-added")).textContent,
    ).toContain("No brand-new entries match your search.");

    // Mixer matches only the "Qwizzle Mixer" brand-new entry; the exchange
    // entry drops out.
    setCategory("mixer");
    await waitFor(() => expect(addedTabText()).toContain("Brand-new (1)"));
    expect(overridesTabText()).toContain(
      `Overrides (${overridesUnder("mixer")}`,
    );
    const mixerRow = await screen.findByTestId("row-entity-diff-added-0");
    expect(within(mixerRow).getByText("Qwizzle Mixer")).toBeTruthy();
    expect(screen.queryByText("Zorptast Exchange")).toBeNull();

    // Exchange matches only the "Zorptast Exchange" brand-new entry.
    setCategory("exchange");
    await waitFor(() => expect(addedTabText()).toContain("Brand-new (1)"));
    const exchangeRow = await screen.findByTestId("row-entity-diff-added-0");
    expect(within(exchangeRow).getByText("Zorptast Exchange")).toBeTruthy();
    expect(screen.queryByText("Qwizzle Mixer")).toBeNull();
  });

  it("shows the empty-search labels on both tabs when nothing matches", async () => {
    await openMergeDiff();

    typeSearch("zzz-no-such-entity-anywhere");

    await waitFor(() => expect(overridesTabText()).toContain("Overrides (0"));
    expect(addedTabText()).toContain("Brand-new (0)");

    // Overrides tab (active by default) shows its no-match empty label.
    expect(
      (await screen.findByTestId("text-entity-overrides-empty")).textContent,
    ).toContain("No overrides match your search.");

    // Brand-new tab shows its own no-match empty label.
    openAddedTab();
    expect(
      (await screen.findByTestId("text-entity-diff-empty-added")).textContent,
    ).toContain("No brand-new entries match your search.");
  });
});

describe("SettingsPage — entity list import (merge mode) source-note diff", () => {
  it("renders the override source-note diff (old → new, '(none)' for absent notes) when the note changes", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Two bundled entries that both carry a real source note, so we can drive
    // both a present→different-present diff and a present→absent ("(none)") diff.
    const list = getBundledEntityList();
    const withNote = list.filter((e) => e.sourceNote);
    expect(withNote.length).toBeGreaterThanOrEqual(2);
    const [first, second] = withNote;
    expect(first.sourceNote).toBeTruthy();
    expect(second.sourceNote).toBeTruthy();

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const NEW_NOTE = "Updated provenance note for review";
    const snapshot = JSON.stringify([
      // Override 0: same name + category, only the source note changes
      // (present → a different present note).
      {
        address: first.address,
        name: first.name,
        category: first.category,
        sourceNote: NEW_NOTE,
      },
      // Override 1: same name + category, source note removed
      // (present → absent, so the new side renders "(none)").
      { address: second.address, name: second.name, category: second.category },
    ]);
    await selectEntityFile("merge-source-notes.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // Row 0: old (bundled) note struck through → new note.
    const note0 = await screen.findByTestId("text-entity-override-sourcenote-0");
    expect(note0.textContent).toContain("Source:");
    expect(note0.textContent).toContain(first.sourceNote!);
    expect(note0.textContent).toContain(NEW_NOTE);
    // The struck-through side carries the old note.
    expect(within(note0).getByText(first.sourceNote!).className).toContain(
      "line-through",
    );

    // Row 1: old note → "(none)" because the incoming entry omits it.
    const note1 = await screen.findByTestId("text-entity-override-sourcenote-1");
    expect(note1.textContent).toContain("Source:");
    expect(note1.textContent).toContain(second.sourceNote!);
    expect(note1.textContent).toContain("(none)");
  });

  it("renders no source-note line when the source note is unchanged", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const bundled = getBundledEntityList().find((e) => e.sourceNote);
    expect(bundled).toBeTruthy();
    expect(bundled!.sourceNote).toBeTruthy();

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    // Change only the display name; keep the source note identical to the
    // bundled entry so sourceNoteChanged is false.
    const snapshot = JSON.stringify([
      {
        address: bundled!.address,
        name: "Renamed But Same Source",
        category: bundled!.category,
        sourceNote: bundled!.sourceNote,
      },
    ]);
    await selectEntityFile("merge-unchanged-source.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // The override row still renders (the name changed)...
    const row = await screen.findByTestId("row-entity-override-0");
    expect(within(row).getByText("Renamed But Same Source")).toBeTruthy();
    // ...but no source-note diff line is present.
    expect(
      screen.queryByTestId("text-entity-override-sourcenote-0"),
    ).toBeNull();
  });
});
