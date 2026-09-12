// @vitest-environment jsdom
//
// Component coverage for the *added* and *removed* detail-row lists (and their
// shared search + category filters) of the replace-mode Privacy Audit "Entity
// List" import confirmation dialog inside the Settings page.
//
// The replace-mode summary badges, the per-category table, and the diff-filter
// *tab counts* are covered elsewhere (SettingsPage.entityListReplaceSummary /
// entityListCategoryDiff / entityDiffFilter). Those filter tests deliberately
// assert on the TabsTrigger count labels rather than the virtualized rows
// (which need real layout). This file drives the actual rendered Added/Removed
// rows so a regression in the filter wiring — search matching the wrong field,
// or the category filter excluding the wrong rows — is caught at the UI level
// before a user replaces the security-sensitive entity list.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import {
  screen,
  fireEvent,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so without these shims the
// virtualized Added/Removed lists would render zero rows and the row-level
// assertions could never run. Provide a minimal ResizeObserver and a non-zero
// getBoundingClientRect / offset size so the virtualizer produces its overscan
// window.
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
const { resetActiveEntityList, setActiveEntityList } = await import(
  "@/lib/privacy-entity-list"
);
import type { EntityEntry } from "@/lib/privacy-entity-list";
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses (the incoming snapshot IS validated; the baseline is
// set directly but we keep them valid for realism / symmetry).
const ADDR = {
  exA: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  exB: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
  exOld: "1EdiJAgeX91JvVie2LbHgNXhP4pdMxAUdn",
  gamOld: "1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv",
  mixNew: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  mixOld: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  stable: "1LRGtCGbJQNqmCBs3mmCdWdTCcEZBjDVf4",
} as const;

// Baseline = the active list a *replace* preview diffs against. Everything here
// except "Stable Exchange" is absent from the snapshot, so it becomes removed.
const BASELINE: EntityEntry[] = [
  { address: ADDR.exOld, name: "Removed Exchange", category: "exchange" },
  { address: ADDR.gamOld, name: "Removed Gambling", category: "gambling" },
  { address: ADDR.mixOld, name: "Removed Mixer", category: "mixer" },
  { address: ADDR.stable, name: "Stable Exchange", category: "exchange" },
];

// Incoming snapshot. Diff against BASELINE:
//   added   = Added Exchange (exchange), Added Exchange Two (exchange),
//             Added Mixer (mixer)                                   -> 3
//   removed = Removed Exchange (exchange), Removed Gambling (gambling),
//             Removed Mixer (mixer)                                 -> 3
//   Stable Exchange is unchanged (present, identical, on both sides).
const SNAPSHOT = JSON.stringify([
  { address: ADDR.exA, name: "Added Exchange", category: "exchange" },
  { address: ADDR.exB, name: "Added Exchange Two", category: "exchange" },
  { address: ADDR.mixNew, name: "Added Mixer", category: "mixer" },
  { address: ADDR.stable, name: "Stable Exchange", category: "exchange" },
]);

function fakeFile(name: string, contents: string) {
  // The handler only uses file.name and file.text().
  return { name, text: async () => contents } as unknown as File;
}

function selectEntityFile(name: string, contents: string) {
  const input = screen.getByTestId("input-entity-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(name, contents)] } });
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

// Radix Tabs default to "automatic" activation (a trigger activates on focus).
// jsdom's fireEvent.click doesn't move focus, so focus the trigger explicitly.
function openTab(testid: string) {
  const trigger = screen.getByTestId(testid);
  fireEvent.focus(trigger);
  fireEvent.click(trigger);
}

function addedRows() {
  return screen.queryAllByTestId(/^row-entity-diff-added-\d+$/);
}
function removedRows() {
  return screen.queryAllByTestId(/^row-entity-diff-removed-\d+$/);
}
function addedNames() {
  return addedRows().map(
    (r) =>
      within(r)
        .getByTestId(/^text-entity-diff-name-added-\d+$/)
        .textContent ?? "",
  );
}

async function openReplaceDiff() {
  renderWithSettingsProviders(<SettingsPage />);
  // Wait for the panel to finish its startup load before overriding the active
  // list (the load resets to bundled when there is no snapshot).
  await screen.findByTestId("badge-entity-source");

  // Seed the small known baseline, then import the snapshot (replace is the
  // default mode) and reveal the diff tabs (collapsed by default).
  setActiveEntityList(BASELINE);
  selectEntityFile("replace.json", SNAPSHOT);

  await screen.findByTestId("text-preview-incoming");
  fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
  await screen.findByTestId("tab-entity-diff-added");
}

beforeEach(async () => {
  // The real app always has a 'default' settings row; seed one so the panel
  // initializes cleanly with no persisted snapshot.
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — replace-mode added/removed detail rows", () => {
  it("renders every added and removed entry as its own detail row", async () => {
    await openReplaceDiff();

    // Added tab is active by default: all three added entries have a row.
    expect(addedRows()).toHaveLength(3);
    const addedList = screen.getByTestId("list-entity-diff-added");
    expect(addedList.textContent).toContain("Added Exchange");
    expect(addedList.textContent).toContain("Added Exchange Two");
    expect(addedList.textContent).toContain("Added Mixer");
    // Unchanged / removed entries never appear in the Added list.
    expect(addedList.textContent).not.toContain("Stable Exchange");
    expect(addedList.textContent).not.toContain("Removed");

    // Switch to the Removed tab: all three removed entries have a row.
    openTab("tab-entity-diff-removed");
    const removedList = await screen.findByTestId("list-entity-diff-removed");
    expect(removedRows()).toHaveLength(3);
    expect(removedList.textContent).toContain("Removed Exchange");
    expect(removedList.textContent).toContain("Removed Gambling");
    expect(removedList.textContent).toContain("Removed Mixer");
    expect(removedList.textContent).not.toContain("Stable Exchange");
    expect(removedList.textContent).not.toContain("Added");
  });

  it("narrows the added and removed rows by the diff search (name and address)", async () => {
    await openReplaceDiff();

    // A name fragment unique to one added entry leaves only that row.
    typeSearch("Added Mixer");
    await waitFor(() => expect(addedRows()).toHaveLength(1));
    expect(
      within(addedRows()[0]).getByText("Added Mixer"),
    ).toBeTruthy();

    // The search box is shared across tabs: the same fragment empties the
    // Removed tab (no removed entry is named "Added Mixer").
    openTab("tab-entity-diff-removed");
    expect(
      (await screen.findByTestId("text-entity-diff-empty-removed")).textContent,
    ).toContain("No removed entries match your search.");

    // Search by address fragment instead: the removed exchange address matches
    // exactly one removed row and no added row.
    typeSearch(ADDR.gamOld);
    await waitFor(() => expect(removedRows()).toHaveLength(1));
    expect(
      within(removedRows()[0]).getByText("Removed Gambling"),
    ).toBeTruthy();

    openTab("tab-entity-diff-added");
    expect(
      (await screen.findByTestId("text-entity-diff-empty-added")).textContent,
    ).toContain("No added entries match your search.");
  });

  it("narrows the added and removed rows by the category dropdown", async () => {
    await openReplaceDiff();

    // Exchange: two added rows (Added Exchange / Added Exchange Two), one
    // removed row (Removed Exchange).
    setCategory("exchange");
    await waitFor(() => expect(addedRows()).toHaveLength(2));
    expect(addedNames().sort()).toEqual([
      "Added Exchange",
      "Added Exchange Two",
    ]);
    openTab("tab-entity-diff-removed");
    await waitFor(() => expect(removedRows()).toHaveLength(1));
    expect(within(removedRows()[0]).getByText("Removed Exchange")).toBeTruthy();

    // Mixer: one added row, one removed row.
    setCategory("mixer");
    await waitFor(() => expect(removedRows()).toHaveLength(1));
    expect(within(removedRows()[0]).getByText("Removed Mixer")).toBeTruthy();
    openTab("tab-entity-diff-added");
    await waitFor(() => expect(addedRows()).toHaveLength(1));
    expect(within(addedRows()[0]).getByText("Added Mixer")).toBeTruthy();

    // Gambling: only a removed entry exists; the Added tab is empty.
    setCategory("gambling");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-diff-empty-added"),
      ).toBeTruthy(),
    );
    expect(addedRows()).toHaveLength(0);
    openTab("tab-entity-diff-removed");
    await waitFor(() => expect(removedRows()).toHaveLength(1));
    expect(within(removedRows()[0]).getByText("Removed Gambling")).toBeTruthy();
  });
});
