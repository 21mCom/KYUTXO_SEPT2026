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
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
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
  renderWithSettingsProviders(<SettingsPage />);
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

  // A merge whose preview has TWO overrides in distinct categories (an exchange
  // entry renamed in-place and a mixer entry renamed in-place), each with a
  // search-distinct name. This lets us drive the order-of-operations edge where
  // a search term valid for one category's override lingers after switching to
  // a different category whose override the term no longer matches.
  async function openTwoCategoryOverrideDiff() {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const list = getBundledEntityList();
    const exchangeBase = list.find((e) => e.category === "exchange");
    const mixerBase = list.find((e) => e.category === "mixer");
    expect(exchangeBase).toBeTruthy();
    expect(mixerBase).toBeTruthy();
    expect(exchangeBase!.address).not.toBe(mixerBase!.address);

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const snapshot = JSON.stringify([
      // Override A: an exchange entry renamed, kept in the exchange category.
      { address: exchangeBase!.address, name: "Qwizzle Override Alpha", category: "exchange" },
      // Override B: a mixer entry renamed, kept in the mixer category.
      { address: mixerBase!.address, name: "Zorptast Override Beta", category: "mixer" },
    ]);
    await selectEntityFile("merge-two-category-overrides.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");
    return { exchangeBase: exchangeBase!, mixerBase: mixerBase! };
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

  it("composes the category dropdown and search box on the Brand-new tab: an intersecting combo leaves exactly one row, a disjoint combo leaves none", async () => {
    await openMergeDiff();

    // Baseline: both brand-new entries (Qwizzle Mixer / Zorptast Exchange).
    expect(addedTabText()).toContain("Brand-new (2)");

    // Category + search that agree on a single entry: the "mixer" category
    // matches only Qwizzle Mixer, and the "qwizzle" token matches that same
    // entry — so the intersection (not just each filter alone) is one row. The
    // exchange entry is excluded by BOTH the category and the search.
    setCategory("mixer");
    typeSearch("qwizzle");
    await waitFor(() => expect(addedTabText()).toContain("Brand-new (1)"));

    openAddedTab();
    const onlyRow = await screen.findByTestId("row-entity-diff-added-0");
    expect(within(onlyRow).getByText("Qwizzle Mixer")).toBeTruthy();
    // No second row, and the exchange entry is nowhere on screen.
    expect(screen.queryByTestId("row-entity-diff-added-1")).toBeNull();
    expect(screen.queryByText("Zorptast Exchange")).toBeNull();

    // Make the two filters disagree: keep the "mixer" category but search a
    // token unique to the *exchange* entry. The category excludes Zorptast and
    // the search excludes Qwizzle, so the intersection is empty — the label
    // drops to 0 and the brand-new empty (search) label shows.
    typeSearch("zorptast");
    await waitFor(() => expect(addedTabText()).toContain("Brand-new (0)"));
    expect(screen.queryByTestId("row-entity-diff-added-0")).toBeNull();
    expect(
      (await screen.findByTestId("text-entity-diff-empty-added")).textContent,
    ).toContain("No brand-new entries match your search.");
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

  // Order-of-operations edge: the search box, category dropdown, and override
  // list are independent state. A reviewer types a search term that is valid
  // for the currently-shown override, then switches the category to one whose
  // own override the stale search term no longer matches. The combined result
  // silently empties even though that category DOES have an override — which
  // could fool a reviewer into thinking the category has no overrides. Once the
  // stale search is cleared, the category's override must re-appear.
  it("empties the Overrides tab when a stale search term no longer matches the newly-selected category, then re-shows it once the search is cleared", async () => {
    await openTwoCategoryOverrideDiff();

    // Baseline: two overrides (one exchange, one mixer), both shown.
    expect(overridesTabText()).toContain("Overrides (2)");

    // Type a token unique to the exchange override. With the category still
    // "all" this narrows the Overrides tab to that single, matching override.
    typeSearch("qwizzle");
    await waitFor(() => expect(overridesTabText()).toContain("Overrides (1)"));
    expect(screen.getByTestId("row-entity-override-0")).toBeTruthy();
    expect(screen.getByText("Qwizzle Override Alpha")).toBeTruthy();

    // Now switch the category to "mixer". The mixer category has its own
    // override ("Zorptast Override Beta"), but the lingering "qwizzle" search
    // term does NOT match it — so the combined result is empty.
    setCategory("mixer");
    await waitFor(() => expect(overridesTabText()).toContain("Overrides (0)"));
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain("No overrides match your search.");
    expect(screen.queryByTestId("row-entity-override-0")).toBeNull();

    // Clearing the stale search must reveal the mixer category's override — it
    // was there all along, only hidden by the no-longer-valid search term.
    typeSearch("");
    await waitFor(() => expect(overridesTabText()).toContain("Overrides (1)"));
    expect(screen.getByTestId("row-entity-override-0")).toBeTruthy();
    expect(screen.getByText("Zorptast Override Beta")).toBeTruthy();
    expect(screen.queryByText("Qwizzle Override Alpha")).toBeNull();
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
  });
});

describe("SettingsPage — entity list import (merge mode) only-changed filter", () => {
  // Build an incoming snapshot entry that is byte-for-byte identical to a
  // bundled entry, so the merge surfaces it as a "no change" override
  // (changed: false). entriesEqual compares address/name/category/sourceNote,
  // so the source note must be replicated when present.
  function identical(e: { address: string; name: string; category: string; sourceNote?: string }) {
    const out: Record<string, string> = {
      address: e.address,
      name: e.name,
      category: e.category,
    };
    if (e.sourceNote != null) out.sourceNote = e.sourceNote;
    return out;
  }

  function overrideRows() {
    return screen.queryAllByTestId(/^row-entity-override-\d+$/);
  }
  function overridesTabText() {
    return screen.getByTestId("tab-entity-diff-overrides").textContent ?? "";
  }
  function toggleOnlyChanged() {
    fireEvent.click(screen.getByTestId("switch-overrides-only-changed"));
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

  // Build a merge whose preview has exactly two overrides — one that really
  // changes (an exchange entry renamed + re-categorised to gambling) and one
  // identical re-import of a *mixer* entry (changed: false). The distinct
  // categories (exchange/gambling vs mixer) and the controllable changed-side
  // name let us combine the "Only show changed" toggle with both the search box
  // and the category dropdown.
  async function openChangedPlusIdenticalDiff() {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const list = getBundledEntityList();
    const changedBase = list.find((e) => e.category === "exchange");
    const identicalBase = list.find((e) => e.category === "mixer");
    expect(changedBase).toBeTruthy();
    expect(identicalBase).toBeTruthy();
    expect(changedBase!.address).not.toBe(identicalBase!.address);

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const CHANGED_NAME = "Qwizzle Changed Override";
    const snapshot = JSON.stringify([
      // A real change: renamed + re-categorised exchange entry (changed: true).
      { address: changedBase!.address, name: CHANGED_NAME, category: "gambling" },
      // An identical re-import of a mixer entry (changed: false → "no change").
      identical(identicalBase!),
    ]);
    await selectEntityFile("merge-only-changed-filters.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");
    return {
      changedBase: changedBase!,
      identicalBase: identicalBase!,
      CHANGED_NAME,
    };
  }

  it("combines the toggle with the search box: ON after a search keeps only the changed override that still matches", async () => {
    const { CHANGED_NAME } = await openChangedPlusIdenticalDiff();

    // Baseline: 2 overrides, 1 of which actually changes.
    expect(overridesTabText()).toContain("Overrides (2, 1 changed)");
    expect(overrideRows()).toHaveLength(2);

    // Narrow by a token unique to the changed override's new name. The identical
    // mixer re-import does not match, so search alone leaves one override.
    typeSearch("qwizzle");
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();

    // Toggle ON: the single match is the changed override, so it survives and no
    // empty label is shown.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
  });

  it("combines the toggle with the search box: ON when search matches only an identical override shows the changed-only empty label", async () => {
    const { identicalBase } = await openChangedPlusIdenticalDiff();

    // Search by the identical override's address — unique to that row, so the
    // changed override drops out and only the identical (no-change) one remains.
    typeSearch(identicalBase.address);
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText("no change")).toBeTruthy();

    // Toggle ON: the only surviving search match is identical, so the list is
    // empty. Because searchedOverrides is non-empty, the *changed-only* empty
    // label must win over the generic search-no-match label.
    toggleOnlyChanged();
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain(
      "No overrides change anything — every match is identical to the bundled entry.",
    );
    expect(empty.textContent).not.toContain("No overrides match your search.");
    expect(overrideRows()).toHaveLength(0);
  });

  it("combines the toggle with the search box: ON when search matches nothing shows the search no-match label", async () => {
    await openChangedPlusIdenticalDiff();

    // A search that matches neither override empties searchedOverrides entirely.
    typeSearch("zzz-no-such-entity-anywhere");
    await waitFor(() => expect(overrideRows()).toHaveLength(0));

    // Toggle ON: searchedOverrides is now empty, so the changed-only label must
    // NOT show — the generic search-no-match label wins instead.
    toggleOnlyChanged();
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain("No overrides match your search.");
    expect(empty.textContent).not.toContain(
      "No overrides change anything",
    );
    expect(overrideRows()).toHaveLength(0);
  });

  it("combines the toggle with the category dropdown: ON under a category that only matches an identical override shows the changed-only empty label", async () => {
    await openChangedPlusIdenticalDiff();

    // The "mixer" category matches only the identical re-import (the changed
    // override is exchange → gambling). Search/category narrows to that one row.
    setCategory("mixer");
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText("no change")).toBeTruthy();

    // Toggle ON: the single mixer match is identical, so the changed-only label
    // appears — not the generic search-no-match label.
    toggleOnlyChanged();
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain(
      "No overrides change anything — every match is identical to the bundled entry.",
    );
    expect(empty.textContent).not.toContain("No overrides match your search.");
    expect(overrideRows()).toHaveLength(0);
  });

  it("combines the toggle with the category dropdown: ON under a category that matches the changed override keeps it visible", async () => {
    const { CHANGED_NAME } = await openChangedPlusIdenticalDiff();

    // The "gambling" category matches only the changed override (incoming side);
    // the identical mixer re-import drops out.
    setCategory("gambling");
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();

    // Toggle ON: the surviving category match is the changed override, so it
    // stays and no empty label is shown.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
  });

  it("narrows the list to the changed override(s) when toggled on, and restores the full list when toggled off", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const list = getBundledEntityList();
    const [bundled0, bundled1] = list;
    expect(bundled0).toBeTruthy();
    expect(bundled1).toBeTruthy();
    // Distinct addresses so both surface as separate override rows.
    expect(bundled0.address).not.toBe(bundled1.address);

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const CHANGED_NAME = "Changed Override Entity";
    const snapshot = JSON.stringify([
      // A real change: renamed + re-categorised bundled entry (changed: true).
      { address: bundled0.address, name: CHANGED_NAME, category: "gambling" },
      // An identical re-import of a bundled entry (changed: false → "no change").
      identical(bundled1),
    ]);
    await selectEntityFile("merge-only-changed.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // The tab trigger reports the total override count plus the changed count:
    // 2 overrides, of which 1 actually changes anything.
    expect(overridesTabText()).toContain("Overrides (2, 1 changed)");

    // Toggle OFF (default): both overrides render, including the identical one
    // which carries the "no change" badge.
    expect(overrideRows()).toHaveLength(2);
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(screen.getByText("no change")).toBeTruthy();

    // Toggle ON: only the changed override survives the filter.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    // The changed override is still present; the identical "no change" row is gone.
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(screen.queryByText("no change")).toBeNull();
    // The empty label must NOT show — there is still a matching changed override.
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
    // The tab trigger count is unaffected by the view filter.
    expect(overridesTabText()).toContain("Overrides (2, 1 changed)");

    // Toggle back OFF: the full override list (including the identical row) returns.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(2));
    expect(screen.getByText("no change")).toBeTruthy();
  });

  it("shows the distinct 'no overrides change anything' empty label when every override is identical", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const list = getBundledEntityList();
    const [bundled0, bundled1] = list;
    expect(bundled0).toBeTruthy();
    expect(bundled1).toBeTruthy();
    expect(bundled0.address).not.toBe(bundled1.address);

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    // Both overrides re-import the bundled entries verbatim, so none change.
    const snapshot = JSON.stringify([identical(bundled0), identical(bundled1)]);
    await selectEntityFile("merge-all-identical.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // 2 overrides, 0 of which change anything.
    expect(overridesTabText()).toContain("Overrides (2, 0 changed)");
    // Both identical rows render while the filter is off.
    expect(overrideRows()).toHaveLength(2);

    // Toggle ON: every override is filtered out, so the list shows the
    // changed-only empty label — NOT the generic search empty label.
    toggleOnlyChanged();
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain(
      "No overrides change anything — every match is identical to the bundled entry.",
    );
    expect(empty.textContent).not.toContain("No overrides match your search.");
    expect(overrideRows()).toHaveLength(0);
  });

  it("keeps a source-note-only override visible but hides an identical re-import when toggled on", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Two bundled entries that both carry a real source note: one drives a
    // source-note-only change, the other an identical re-import.
    const withNote = getBundledEntityList().filter((e) => e.sourceNote);
    expect(withNote.length).toBeGreaterThanOrEqual(2);
    const [first, second] = withNote;
    expect(first.address).not.toBe(second.address);
    expect(first.sourceNote).toBeTruthy();

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const NEW_NOTE = "Re-attributed provenance note for review";
    // Guard the fixture: the new note must actually differ from the bundled one,
    // otherwise this override would be identical and the test would be vacuous.
    expect(first.sourceNote).not.toBe(NEW_NOTE);
    const snapshot = JSON.stringify([
      // Override 0: same name + category, ONLY the source note changes.
      // entriesEqual compares sourceNote, so this is changed: true even though
      // name/category are untouched — exactly the attribution change reviewers
      // must not accidentally hide.
      {
        address: first.address,
        name: first.name,
        category: first.category,
        sourceNote: NEW_NOTE,
      },
      // Override 1: byte-for-byte identical re-import → changed: false.
      identical(second),
    ]);
    await selectEntityFile("merge-sourcenote-only-changed.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // A source-note-only difference still counts toward the "changed" total:
    // 2 overrides, 1 of which actually changes anything.
    expect(overridesTabText()).toContain("Overrides (2, 1 changed)");

    // Toggle OFF (default): both rows render. The source-note-changed override
    // surfaces its old → new note diff and carries NO "no change" badge; the
    // identical re-import carries the "no change" badge.
    expect(overrideRows()).toHaveLength(2);
    const noteDiff = screen.getByTestId("text-entity-override-sourcenote-0");
    expect(noteDiff.textContent).toContain(first.sourceNote!);
    expect(noteDiff.textContent).toContain(NEW_NOTE);
    expect(within(noteDiff).getByText(first.sourceNote!).className).toContain(
      "line-through",
    );
    expect(screen.getByText("no change")).toBeTruthy();

    // Toggle ON: the source-note-changed override survives the filter; the
    // identical re-import is hidden.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    // The surviving row is the source-note change — its diff line (with the new
    // note) is still on screen.
    const survivingNote = screen.getByTestId("text-entity-override-sourcenote-0");
    expect(survivingNote.textContent).toContain(NEW_NOTE);
    // The identical "no change" row is gone.
    expect(screen.queryByText("no change")).toBeNull();
    // A real changed override remains, so the empty label must NOT appear.
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
    // The tab trigger count is unaffected by the view filter.
    expect(overridesTabText()).toContain("Overrides (2, 1 changed)");

    // Toggle back OFF: the identical "no change" row returns.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(2));
    expect(screen.getByText("no change")).toBeTruthy();
  });

  it("shows the 'no overrides change anything' empty label when only source-note-bearing identical re-imports remain", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Re-import two source-note-bearing bundled entries verbatim (including
    // their notes) so both classify as changed: false.
    const withNote = getBundledEntityList().filter((e) => e.sourceNote);
    expect(withNote.length).toBeGreaterThanOrEqual(2);
    const [first, second] = withNote;
    expect(first.address).not.toBe(second.address);

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const snapshot = JSON.stringify([identical(first), identical(second)]);
    await selectEntityFile("merge-sourcenote-all-identical.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // Both carry source notes yet none changes anything.
    expect(overridesTabText()).toContain("Overrides (2, 0 changed)");
    expect(overrideRows()).toHaveLength(2);
    // No source-note diff line renders since the notes were preserved verbatim.
    expect(
      screen.queryByTestId("text-entity-override-sourcenote-0"),
    ).toBeNull();

    // Toggle ON: every override is filtered out, so the changed-only empty
    // label shows — NOT the generic search empty label.
    toggleOnlyChanged();
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain(
      "No overrides change anything — every match is identical to the bundled entry.",
    );
    expect(empty.textContent).not.toContain("No overrides match your search.");
    expect(overrideRows()).toHaveLength(0);
  });

  it("composes a search that matches BOTH a changed and an identical override with the toggle, narrowing the '(N changed)' label and leaving only the changed match", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // The shared search token is a real word lifted from a bundled entry's name.
    // That same word is then embedded in one changed override's *new* name so a
    // single search term matches both that changed override and the identical
    // re-import of the source entry — exercising the two filters composing, not
    // just narrowing to a lone row as the existing single-match tests do.
    const list = getBundledEntityList();
    const identicalBase = list.find(
      (e) => e.name.trim().split(/\s+/)[0].length >= 4,
    );
    expect(identicalBase).toBeTruthy();
    const sharedToken = identicalBase!.name.trim().split(/\s+/)[0];
    const tokenLower = sharedToken.toLowerCase();

    const mentionsToken = (e: { name: string; address: string }) =>
      e.name.toLowerCase().includes(tokenLower) ||
      e.address.toLowerCase().includes(tokenLower);

    // Two further distinct bundled entries drive real changes. The second one
    // (changedB) must NOT itself mention the shared token via its bundled
    // name/address, or it would survive the search and break the narrowing.
    const others = list.filter(
      (e) => e.address !== identicalBase!.address && !mentionsToken(e),
    );
    expect(others.length).toBeGreaterThanOrEqual(2);
    const changedA = others[0];
    const changedB = others[1];

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const CHANGED_A_NAME = `${sharedToken} Qwizzle Changed A`;
    const CHANGED_B_NAME = "Zorptast Changed B";
    // changedB's new name must not accidentally carry the shared token either.
    expect(CHANGED_B_NAME.toLowerCase()).not.toContain(tokenLower);

    const snapshot = JSON.stringify([
      // Changed AND matches the shared-token search (via its new name).
      { address: changedA.address, name: CHANGED_A_NAME, category: "gambling" },
      // Changed but does NOT match the shared-token search.
      { address: changedB.address, name: CHANGED_B_NAME, category: "gambling" },
      // Identical re-import (changed: false) that DOES match the search via its
      // bundled name.
      identical(identicalBase!),
    ]);
    await selectEntityFile("merge-search-plus-only-changed.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // Baseline (no search): 3 overrides, 2 of which actually change.
    expect(overridesTabText()).toContain("Overrides (3, 2 changed)");
    expect(overrideRows()).toHaveLength(3);

    // Search the shared token: matches changedA (new name) and the identical
    // re-import (bundled name), but not changedB. The tab label's total AND its
    // "(N changed)" portion must reflect the search-narrowed subset (2, 1) — not
    // the full override count (3, 2).
    typeSearch(sharedToken);
    await waitFor(() =>
      expect(overridesTabText()).toContain("Overrides (2, 1 changed)"),
    );
    expect(overrideRows()).toHaveLength(2);
    expect(screen.getByText(CHANGED_A_NAME)).toBeTruthy();
    expect(screen.getByText("no change")).toBeTruthy();
    expect(screen.queryByText(CHANGED_B_NAME)).toBeNull();

    // Toggle "Only show changed" ON: of the two search matches only changedA
    // changes, so the identical re-import drops and exactly one row remains. No
    // empty label appears because a real changed override still matches.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_A_NAME)).toBeTruthy();
    expect(screen.queryByText("no change")).toBeNull();
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();

    // The view-only toggle does not change the tab label: it still reports the
    // search-narrowed subset.
    expect(overridesTabText()).toContain("Overrides (2, 1 changed)");
  });

  it("composes all three filters (category + search + toggle): leaves exactly one changed override and narrows the '(N changed)' label", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // The identical re-import is a *gambling* entry whose first name word is a
    // usable (>=4 char) search token. Re-importing it verbatim keeps it
    // changed: false, and its bundled category/name let it match BOTH the
    // gambling category filter and the shared-token search.
    const list = getBundledEntityList();
    const identicalBase = list.find(
      (e) =>
        e.category === "gambling" &&
        e.name.trim().split(/\s+/)[0].length >= 4,
    );
    expect(identicalBase).toBeTruthy();
    const sharedToken = identicalBase!.name.trim().split(/\s+/)[0];
    const tokenLower = sharedToken.toLowerCase();

    const mentionsToken = (e: { name: string; address: string }) =>
      e.name.toLowerCase().includes(tokenLower) ||
      e.address.toLowerCase().includes(tokenLower);

    // The changed override is a distinct entry that does NOT itself mention the
    // shared token via its bundled name/address (it only matches the search via
    // its new name) and is re-categorised to gambling so it matches the filter.
    const changedBase = list.find(
      (e) => e.address !== identicalBase!.address && !mentionsToken(e),
    );
    expect(changedBase).toBeTruthy();

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    const CHANGED_NAME = `${sharedToken} Qwizzle Changed`;
    const snapshot = JSON.stringify([
      // Changed: renamed + re-categorised to gambling. Matches the token via its
      // new name and the gambling category via its incoming side.
      { address: changedBase!.address, name: CHANGED_NAME, category: "gambling" },
      // Identical re-import of a gambling entry. Matches the token via its
      // bundled name and gambling via its (unchanged) category. changed: false.
      identical(identicalBase!),
    ]);
    await selectEntityFile("merge-all-three-one-changed.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // Baseline: 2 overrides, 1 of which actually changes.
    expect(overridesTabText()).toContain("Overrides (2, 1 changed)");
    expect(overrideRows()).toHaveLength(2);

    // Apply the category dropdown AND the search box together: both overrides
    // are gambling-categorised and both match the shared token, so the
    // search-narrowed subset stays (2, 1 changed).
    setCategory("gambling");
    typeSearch(sharedToken);
    await waitFor(() =>
      expect(overridesTabText()).toContain("Overrides (2, 1 changed)"),
    );
    expect(overrideRows()).toHaveLength(2);

    // Flip the toggle ON as the third filter: of the two category+search
    // matches, only the changed override survives, leaving exactly one row.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(screen.queryByText("no change")).toBeNull();
    // A real changed override still matches, so no empty label appears.
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
    // The view-only toggle does not change the tab label: it still reflects the
    // category+search-narrowed subset.
    expect(overridesTabText()).toContain("Overrides (2, 1 changed)");
  });

  it("composes all three filters (category + search + toggle): leaving only an identical override shows the changed-only empty label", async () => {
    const { identicalBase } = await openChangedPlusIdenticalDiff();

    // Category "mixer" matches only the identical re-import (the changed
    // override is exchange → gambling), and searching its address — unique to
    // that same identical row — keeps the two non-toggle filters in agreement.
    setCategory("mixer");
    typeSearch(identicalBase.address);
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText("no change")).toBeTruthy();
    // The combined non-toggle subset is a single identical override (0 changed).
    expect(overridesTabText()).toContain("Overrides (1, 0 changed)");

    // Flip the toggle ON as the third filter: the only category+search match is
    // identical, so the list empties. Because searchedOverrides is non-empty,
    // the *changed-only* empty label must win over the generic search-no-match
    // label.
    toggleOnlyChanged();
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain(
      "No overrides change anything — every match is identical to the bundled entry.",
    );
    expect(empty.textContent).not.toContain("No overrides match your search.");
    expect(overrideRows()).toHaveLength(0);
  });

  // Transition behavior: a reviewer who narrows the diff *while the toggle is
  // ON* and then clears the filter must see the changed-override set re-expand.
  // The regression guarded here is the toggle silently turning itself off, or a
  // stale changed-only empty label lingering because filteredOverrides did not
  // recompute when the search/category cleared.
  function toggleState() {
    return screen
      .getByTestId("switch-overrides-only-changed")
      .getAttribute("data-state");
  }

  it("re-expands the changed overrides and drops the stale empty label when the search box is cleared with the toggle still ON", async () => {
    const { identicalBase, CHANGED_NAME } = await openChangedPlusIdenticalDiff();

    // Toggle ON first: only the lone changed override is shown.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(toggleState()).toBe("checked");

    // Narrow by a token unique to the identical re-import (its address), so the
    // changed override drops out. searchedOverrides is non-empty (the identical
    // one matches), so the changed-only empty label wins.
    typeSearch(identicalBase.address);
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain(
      "No overrides change anything — every match is identical to the bundled entry.",
    );
    expect(overrideRows()).toHaveLength(0);

    // Clear the search box: the full changed-override set must re-expand...
    typeSearch("");
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    // ...the toggle must stay ON (it is not tied to the filter state)...
    expect(toggleState()).toBe("checked");
    // ...and no stale empty label lingers.
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
  });

  it("re-expands the changed overrides and drops the stale empty label when the category is reset to 'all' with the toggle still ON", async () => {
    const { CHANGED_NAME } = await openChangedPlusIdenticalDiff();

    // Toggle ON first: only the lone changed override is shown.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(toggleState()).toBe("checked");

    // Narrow by the "mixer" category, which matches ONLY the identical re-import
    // (the changed override is exchange → gambling). With the toggle ON the list
    // empties to the changed-only label.
    setCategory("mixer");
    const empty = await screen.findByTestId("text-entity-overrides-empty");
    expect(empty.textContent).toContain(
      "No overrides change anything — every match is identical to the bundled entry.",
    );
    expect(overrideRows()).toHaveLength(0);

    // Reset the category back to "all": the changed-override set re-expands...
    setCategory("all");
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    // ...the toggle stays ON...
    expect(toggleState()).toBe("checked");
    // ...and no stale empty label lingers.
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
  });

  // Lifecycle behavior across dialog open/close: the "Only show changed" toggle
  // is a view filter scoped to a single preview. A reviewer who turns it ON,
  // cancels the import, then starts a *fresh* merge preview must NOT inherit the
  // ON state — otherwise the new dialog would silently hide identical re-imports
  // the reviewer expected to see. handleCancelEntityImport (and the fresh-preview
  // staging path) reset overridesOnlyChanged back to OFF.
  it("resets 'Only show changed' to OFF after the import is cancelled and a fresh merge preview is opened", async () => {
    const { CHANGED_NAME } = await openChangedPlusIdenticalDiff();

    // Turn the toggle ON: only the lone changed override remains visible.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(toggleState()).toBe("checked");

    // Cancel the import (button-cancel-entity-import → handleCancelEntityImport).
    // The preview dialog tears down.
    fireEvent.click(screen.getByTestId("button-cancel-entity-import"));
    await waitFor(() =>
      expect(screen.queryByTestId("text-preview-incoming")).toBeNull(),
    );

    // Start a fresh merge preview (the import mode is still "merge" after a
    // cancel). Reuse the same one-changed + one-identical fixture so the new
    // preview again has a changed override AND an identical "no change" re-import.
    const list = getBundledEntityList();
    const changedBase = list.find((e) => e.category === "exchange");
    const identicalBase = list.find((e) => e.category === "mixer");
    expect(changedBase).toBeTruthy();
    expect(identicalBase).toBeTruthy();

    const SECOND_CHANGED_NAME = "Zorptast Changed Override";
    const snapshot = JSON.stringify([
      { address: changedBase!.address, name: SECOND_CHANGED_NAME, category: "gambling" },
      identical(identicalBase!),
    ]);
    await selectEntityFile("merge-only-changed-reopen.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // The toggle must have reset to OFF on the new dialog — the previous ON
    // state does NOT carry over.
    expect(toggleState()).toBe("unchecked");

    // Because the filter reset, the full override list is shown: both the
    // changed override and the identical "no change" re-import are visible, with
    // no stale changed-only filtering carried over.
    expect(overrideRows()).toHaveLength(2);
    expect(screen.getByText(SECOND_CHANGED_NAME)).toBeTruthy();
    expect(screen.getByText("no change")).toBeTruthy();
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
  });

  // Apply→re-import lifecycle: a reviewer who turns the toggle ON, *applies* the
  // merge (handleConfirmEntityImport → applyEntitySnapshot), then immediately
  // starts another merge import must NOT inherit the ON state. The reset lives
  // in the fresh-preview staging path (handleEntityFileSelected), which runs on
  // every preview including the one after an apply — handleConfirmEntityImport
  // itself clears entityPreview but not the toggle, so a refactor that bypasses
  // the staging reset would silently hide identical re-imports in the second
  // preview.
  it("resets 'Only show changed' to OFF after the import is applied and a fresh merge preview is opened", async () => {
    const { CHANGED_NAME } = await openChangedPlusIdenticalDiff();

    // Turn the toggle ON: only the lone changed override remains visible.
    toggleOnlyChanged();
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(screen.getByText(CHANGED_NAME)).toBeTruthy();
    expect(toggleState()).toBe("checked");

    // Apply the import (button-confirm-entity-import → handleConfirmEntityImport
    // → applyEntitySnapshot). The preview dialog tears down on success.
    fireEvent.click(screen.getByTestId("button-confirm-entity-import"));
    await waitFor(() =>
      expect(screen.queryByTestId("text-preview-incoming")).toBeNull(),
    );

    // Start a fresh merge preview (the import mode is still "merge" after an
    // apply). The applied snapshot above re-categorised the exchange entry to
    // gambling and merged a brand-new mixer entry in, but the *bundled* fallback
    // entries the diff compares against are unchanged, so re-using two bundled
    // entries again yields a changed override + an identical "no change"
    // re-import in the second preview.
    const list = getBundledEntityList();
    const changedBase = list.find((e) => e.category === "exchange");
    const identicalBase = list.find((e) => e.category === "mixer");
    expect(changedBase).toBeTruthy();
    expect(identicalBase).toBeTruthy();

    const SECOND_CHANGED_NAME = "Zorptast Reapplied Override";
    const snapshot = JSON.stringify([
      { address: changedBase!.address, name: SECOND_CHANGED_NAME, category: "gambling" },
      identical(identicalBase!),
    ]);
    await selectEntityFile("merge-only-changed-reapply.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-overrides");

    // The toggle must have reset to OFF on the new dialog — the previous ON
    // state does NOT carry over across an apply.
    expect(toggleState()).toBe("unchecked");

    // Because the filter reset, the full override list is shown: both the
    // changed override and the identical "no change" re-import are visible, with
    // no stale changed-only filtering carried over from the applied import.
    expect(overrideRows()).toHaveLength(2);
    expect(screen.getByText(SECOND_CHANGED_NAME)).toBeTruthy();
    expect(screen.getByText("no change")).toBeTruthy();
    expect(screen.queryByTestId("text-entity-overrides-empty")).toBeNull();
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
