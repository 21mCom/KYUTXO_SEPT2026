// @vitest-environment jsdom
//
// Component coverage for the *merge*-mode detail-row lists (the "Overrides" and
// "Brand-new" tabs) and their shared category filter inside the Privacy Audit
// "Entity List" import confirmation dialog on the Settings page.
//
// Sibling tests cover the dropdown's per-category *count labels* / disabled
// state (entityDiffCategoryOptions) and the *replace*-mode added/removed rows
// (entityReplaceDetailRows). What none of them drive is the merge dropdown's
// actual row narrowing: selecting a category must narrow both the Overrides
// list and the Brand-new list to the right rows — including an override whose
// previous and incoming categories differ, which must match on *either* side.
// A wiring regression (the category filter excluding the wrong override rows)
// would otherwise go unnoticed before a user merges into the security-sensitive
// entity list.

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
// virtualized Overrides / Brand-new lists would render zero rows and the
// row-level assertions could never run. Provide a minimal ResizeObserver and a
// non-zero getBoundingClientRect / offset size so the virtualizer produces its
// overscan window.
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

// A merge always diffs the incoming snapshot against the *bundled* list (not
// the active list a replace uses). The real bundled list is large and would
// make the merge preview unpredictable, so swap getBundledEntityList for a tiny
// known baseline while keeping every other export real.
const { MERGE_BUNDLED } = vi.hoisted(() => ({
  MERGE_BUNDLED: [
    // Overridden by the snapshot with a *different* category — exercises the
    // "matched on either override side" path (gambling -> darknet).
    { address: "13ozh1W6FDf8vtFsaLxTJtZgKtWm2WYBZC", name: "Bundled Recat", category: "gambling" },
    // Overridden by the snapshot with the same category (exchange -> exchange).
    { address: "1LRGtCGbJQNqmCBs3mmCdWdTCcEZBjDVf4", name: "Bundled Stable", category: "exchange" },
  ],
}));

vi.mock("@/lib/privacy-entity-list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy-entity-list")>();
  return {
    ...actual,
    getBundledEntityList: () => MERGE_BUNDLED,
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

// Radix RadioGroup also relies on roving tabindex / pointer behaviour, so swap
// it for plain radio inputs. This keeps the entityImportMode state path real so
// importing in "merge" mode actually computes a merge preview.
vi.mock("@/components/ui/radio-group", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{
    value?: string;
    onValueChange?: (v: string) => void;
  }>({});
  return {
    RadioGroup: ({ value, onValueChange, children }: any) =>
      React.createElement(Ctx.Provider, { value: { value, onValueChange } }, children),
    RadioGroupItem: ({ value, "data-testid": testid }: any) => {
      const ctx = React.useContext(Ctx);
      return React.createElement("input", {
        type: "radio",
        "data-testid": testid,
        checked: ctx.value === value,
        onChange: () => ctx.onValueChange?.(value),
      });
    },
  };
});

const SettingsPage = (await import("./SettingsPage")).default;
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
const { putSettings } = await import("@/lib/data/settings-crud");
const { resetActiveEntityList } = await import("@/lib/privacy-entity-list");
import type { Settings } from "@/lib/db-types";

// Distinct valid mainnet addresses (the incoming snapshot IS validated).
const ADDR = {
  exA: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  exB: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
  mixNew: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  payNew: "3Fh9p2W79ZHG54ettRJupkPTs23XcjrkT2",
  // Present in the bundled baseline with a *different* category — exercises the
  // "matched on either override side" path (gambling -> darknet).
  recat: "13ozh1W6FDf8vtFsaLxTJtZgKtWm2WYBZC",
  stable: "1LRGtCGbJQNqmCBs3mmCdWdTCcEZBjDVf4",
} as const;

// Incoming snapshot. Diff against MERGE_BUNDLED:
//   overrides = Recat (gambling -> darknet), Stable (exchange -> exchange)
//   added     = Added Exchange, Added Exchange Two (exchange), Added Mixer
//               (mixer), Added Payment (payment-service)
const SNAPSHOT = JSON.stringify([
  { address: ADDR.recat, name: "Recat New", category: "darknet" },
  { address: ADDR.stable, name: "Stable New", category: "exchange" },
  { address: ADDR.exA, name: "Added Exchange", category: "exchange" },
  { address: ADDR.exB, name: "Added Exchange Two", category: "exchange" },
  { address: ADDR.mixNew, name: "Added Mixer", category: "mixer" },
  { address: ADDR.payNew, name: "Added Payment", category: "payment-service" },
]);

function fakeFile(name: string, contents: string) {
  // The handler only uses file.name and file.text().
  return { name, text: async () => contents } as unknown as File;
}

function selectEntityFile(name: string, contents: string) {
  const input = screen.getByTestId("input-entity-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(name, contents)] } });
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

function overrideRows() {
  return screen.queryAllByTestId(/^row-entity-override-\d+$/);
}
function overridesText() {
  return overrideRows()
    .map((r) => r.textContent ?? "")
    .join("\n");
}
function addedRows() {
  return screen.queryAllByTestId(/^row-entity-diff-added-\d+$/);
}
function addedNames() {
  return addedRows().map(
    (r) =>
      within(r)
        .getByTestId(/^text-entity-diff-name-added-\d+$/)
        .textContent ?? "",
  );
}

async function openMergeDiff() {
  renderWithSettingsProviders(<SettingsPage />);
  // Wait for the panel to finish its startup load before importing.
  await screen.findByTestId("badge-entity-source");

  // Switch to merge mode, import the snapshot, and reveal the diff tabs
  // (collapsed by default). Merge diffs against the (mocked) bundled list.
  fireEvent.click(screen.getByTestId("radio-entity-merge"));
  selectEntityFile("merge.json", SNAPSHOT);

  await screen.findByTestId("text-preview-incoming");
  fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
  await screen.findByTestId("tab-entity-diff-overrides");
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

describe("SettingsPage — merge-mode override/brand-new detail rows", () => {
  it("renders every override and brand-new entry as its own detail row", async () => {
    await openMergeDiff();

    // Overrides tab is active by default: both overlapping entries have a row.
    expect(overrideRows()).toHaveLength(2);
    const overrideList = screen.getByTestId("list-entity-overrides");
    // Each override shows previous -> incoming name/category.
    expect(overrideList.textContent).toContain("Bundled Recat");
    expect(overrideList.textContent).toContain("Recat New");
    expect(overrideList.textContent).toContain("Bundled Stable");
    expect(overrideList.textContent).toContain("Stable New");
    // Brand-new entries never appear in the overrides list.
    expect(overrideList.textContent).not.toContain("Added Exchange");
    expect(overrideList.textContent).not.toContain("Added Mixer");

    // Switch to the Brand-new tab: all four added entries have a row.
    openTab("tab-entity-diff-added");
    const addedList = await screen.findByTestId("list-entity-diff-added");
    expect(addedRows()).toHaveLength(4);
    expect(addedNames().sort()).toEqual([
      "Added Exchange",
      "Added Exchange Two",
      "Added Mixer",
      "Added Payment",
    ]);
    // Override entries never appear in the brand-new list.
    expect(addedList.textContent).not.toContain("Recat New");
    expect(addedList.textContent).not.toContain("Stable New");
  });

  it("narrows the overrides and brand-new rows by the category dropdown", async () => {
    await openMergeDiff();

    // Exchange: only the Stable override matches (exchange both sides); the
    // Recat override (gambling -> darknet) is excluded.
    setCategory("exchange");
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(overridesText()).toContain("Stable New");
    expect(overridesText()).not.toContain("Recat");
    // Brand-new exchange entries: Added Exchange + Added Exchange Two.
    openTab("tab-entity-diff-added");
    await waitFor(() => expect(addedRows()).toHaveLength(2));
    expect(addedNames().sort()).toEqual([
      "Added Exchange",
      "Added Exchange Two",
    ]);

    // Mixer: no overrides, exactly one brand-new entry.
    setCategory("mixer");
    await waitFor(() => expect(addedRows()).toHaveLength(1));
    expect(within(addedRows()[0]).getByText("Added Mixer")).toBeTruthy();
    openTab("tab-entity-diff-overrides");
    await waitFor(() =>
      expect(screen.getByTestId("text-entity-overrides-empty")).toBeTruthy(),
    );
    expect(overrideRows()).toHaveLength(0);
  });

  it("matches a recategorized override on its previous OR incoming category", async () => {
    await openMergeDiff();

    // Recat changes gambling -> darknet. Filtering by the *previous* category
    // (gambling) must still surface it even though no incoming entry is
    // gambling, and there are no gambling brand-new entries.
    setCategory("gambling");
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(overridesText()).toContain("Bundled Recat");
    expect(overridesText()).toContain("Recat New");
    expect(overridesText()).not.toContain("Stable");
    openTab("tab-entity-diff-added");
    await waitFor(() =>
      expect(screen.getByTestId("text-entity-diff-empty-added")).toBeTruthy(),
    );
    expect(addedRows()).toHaveLength(0);

    // Filtering by the *incoming* category (darknet) surfaces the same single
    // override, again with no brand-new darknet entries.
    setCategory("darknet");
    openTab("tab-entity-diff-overrides");
    await waitFor(() => expect(overrideRows()).toHaveLength(1));
    expect(overridesText()).toContain("Recat New");
    expect(overridesText()).not.toContain("Stable");
    openTab("tab-entity-diff-added");
    await waitFor(() =>
      expect(screen.getByTestId("text-entity-diff-empty-added")).toBeTruthy(),
    );
    expect(addedRows()).toHaveLength(0);
  });
});
