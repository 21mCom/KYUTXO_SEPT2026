// @vitest-environment jsdom
//
// Component coverage for the *higher-level summary numbers* of the Privacy
// Audit "Entity List" import confirmation dialog inside the Settings page:
//
//   - the "After merge" total (text-preview-current in merge mode), which must
//     equal bundled + brand-new across several snapshots and update live as the
//     selected snapshot changes,
//   - the override warning note (text-merge-override-note), which must appear
//     only when at least one bundled entry is overridden and carry the right
//     wording (singular/plural + "identical re-imports" tail),
//   - the replace ↔ merge recomputation of these summaries (label, value, and
//     which badges/note are present).
//
// The sibling SettingsPage.entityListMerge.test.tsx covers the badges and the
// diff tabs; this file deliberately drills into the summary math/wording so a
// regression there (which would mislead users about the resulting entry count)
// is caught. We use the real entity-list-store + privacy-entity-list modules so
// the preview is computed against the actual bundled list.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows; this suite never opens the virtualized diff, but the
// Settings page still mounts components that observe layout, so provide minimal
// shims to keep them from throwing.
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

// Radix Select doesn't open under jsdom; swap it for a minimal native <select>.
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

function selectEntityFile(name: string, contents: string) {
  const input = screen.getByTestId("input-entity-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(name, contents)] } });
}

// An incoming snapshot entry byte-for-byte identical to a bundled entry, so the
// merge surfaces it as a "no change" override (changed: false). entriesEqual
// compares address/name/category/sourceNote, so replicate the source note.
function identical(e: {
  address: string;
  name: string;
  category: string;
  sourceNote?: string;
}) {
  const out: Record<string, string> = {
    address: e.address,
    name: e.name,
    category: e.category,
  };
  if (e.sourceNote != null) out.sourceNote = e.sourceNote;
  return out;
}

function renderPage() {
  render(
    <ActivityBusProvider>
      <SettingsPage />
    </ActivityBusProvider>,
  );
}

function normalizedNote(): string {
  return (
    screen
      .getByTestId("text-merge-override-note")
      .textContent?.replace(/\s+/g, " ")
      .trim() ?? ""
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

describe("SettingsPage — entity list import (after-merge total)", () => {
  it("reports After merge = bundled + brand-new across several snapshots and updates live", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const bundledCount = getBundledEntityCount();
    const bundled0 = getBundledEntityList()[0];
    expect(bundled0).toBeTruthy();

    // Merge mode must be chosen BEFORE selecting a file: the preview is computed
    // at selection time from the current mode.
    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    // Each case re-uses the same open dialog: selecting a new file replaces the
    // staged preview, which is exactly the "updates as the snapshot changes"
    // path we want to exercise. brandNew is the number of incoming addresses not
    // in the bundled list; resultingCount must always be bundled + brandNew.
    const cases = [
      {
        name: "zero-new.json",
        // One override of a bundled entry → 0 brand-new.
        snapshot: [
          { address: bundled0.address, name: "Renamed Zero", category: "gambling" },
        ],
        incoming: 1,
        brandNew: 0,
      },
      {
        name: "one-new.json",
        snapshot: [
          { address: NEW_ADDR.a, name: "Fresh Mixer", category: "mixer" },
        ],
        incoming: 1,
        brandNew: 1,
      },
      {
        name: "two-new.json",
        snapshot: [
          { address: NEW_ADDR.a, name: "Fresh Mixer", category: "mixer" },
          { address: NEW_ADDR.b, name: "Fresh Exchange", category: "exchange" },
        ],
        incoming: 2,
        brandNew: 2,
      },
      {
        name: "override-plus-new.json",
        // Override + two brand-new → still only the two brand-new grow the list.
        snapshot: [
          { address: bundled0.address, name: "Renamed Mix", category: "gambling" },
          { address: NEW_ADDR.a, name: "Fresh Mixer", category: "mixer" },
          { address: NEW_ADDR.b, name: "Fresh Exchange", category: "exchange" },
        ],
        incoming: 3,
        brandNew: 2,
      },
    ];

    for (const c of cases) {
      selectEntityFile(c.name, JSON.stringify(c.snapshot));

      await waitFor(() =>
        expect(screen.getByTestId("text-preview-incoming").textContent).toBe(
          c.incoming.toLocaleString(),
        ),
      );

      // The "After merge" box: label + value + the "(from N bundled)" subtext.
      // Scope to the summary box (the label "Current list" also appears in the
      // active-list section) by reading the box that wraps text-preview-current.
      const box = screen.getByTestId("text-preview-current").parentElement!;
      expect(box.textContent).toContain("After merge");
      expect(screen.getByTestId("text-preview-current").textContent).toBe(
        (bundledCount + c.brandNew).toLocaleString(),
      );
      expect(box.textContent).toContain(
        `entries (from ${bundledCount.toLocaleString()} bundled)`,
      );

      // The brand-new badge mirrors the same count.
      expect(screen.getByTestId("badge-preview-added").textContent).toContain(
        `+${c.brandNew.toLocaleString()} brand-new`,
      );
    }
  });
});

describe("SettingsPage — entity list import (override warning note)", () => {
  it("omits the override note when the merge only adds brand-new entries", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    selectEntityFile(
      "only-new.json",
      JSON.stringify([
        { address: NEW_ADDR.a, name: "New Exchange", category: "exchange" },
        { address: NEW_ADDR.b, name: "New Mixer", category: "mixer" },
      ]),
    );

    await screen.findByTestId("text-preview-incoming");

    expect(
      screen.getByTestId("badge-preview-overridden").textContent,
    ).toContain("0 override bundled");
    expect(screen.queryByTestId("text-merge-override-note")).toBeNull();
  });

  it("shows the singular override note when exactly one bundled entry is overridden", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const bundled0 = getBundledEntityList()[0];
    expect(bundled0).toBeTruthy();

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    selectEntityFile(
      "one-override.json",
      JSON.stringify([
        // One real change to a bundled entry (changed: true) + a brand-new one.
        { address: bundled0.address, name: "Renamed One", category: "gambling" },
        { address: NEW_ADDR.a, name: "Fresh Mixer", category: "mixer" },
      ]),
    );

    await screen.findByTestId("text-preview-incoming");

    // 1 override, all of which changes → singular "address" / "an entry", no
    // "identical re-imports" tail.
    expect(normalizedNote()).toBe(
      "1 imported address already exist in the bundled list, but only 1 will actually change an entry. Review them below.",
    );
  });

  it("pluralizes the note and reports the identical-re-import tail for multiple overrides", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const list = getBundledEntityList();
    const [bundled0, bundled1] = list;
    expect(bundled0).toBeTruthy();
    expect(bundled1).toBeTruthy();
    expect(bundled0.address).not.toBe(bundled1.address);

    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    selectEntityFile(
      "two-overrides.json",
      JSON.stringify([
        // A real change (changed: true).
        { address: bundled0.address, name: "Renamed Two", category: "gambling" },
        // An identical re-import (changed: false).
        identical(bundled1),
      ]),
    );

    await screen.findByTestId("text-preview-incoming");

    // 2 overrides, 1 of which changes → plural "addresses", the parenthetical
    // tail names the single identical re-import.
    expect(normalizedNote()).toBe(
      "2 imported addresses already exist in the bundled list, but only 1 will actually change an entry (the other 1 is identical re-imports). Review them below.",
    );

    // Swap to a snapshot where BOTH overrides are identical re-imports: the note
    // updates live to "0 will actually change entries" with both in the tail.
    selectEntityFile(
      "all-identical.json",
      JSON.stringify([identical(bundled0), identical(bundled1)]),
    );

    await waitFor(() =>
      expect(normalizedNote()).toBe(
        "2 imported addresses already exist in the bundled list, but only 0 will actually change entries (the other 2 are identical re-imports). Review them below.",
      ),
    );
  });
});

describe("SettingsPage — entity list import (replace ↔ merge recomputation)", () => {
  it("recomputes the summary label, value, badges, and note when the mode changes", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const bundledCount = getBundledEntityCount();
    const bundled0 = getBundledEntityList()[0];
    expect(bundled0).toBeTruthy();

    // The same snapshot drives both modes: one override of a bundled entry plus
    // one brand-new entry.
    const snapshot = JSON.stringify([
      { address: bundled0.address, name: "Renamed Both", category: "gambling" },
      { address: NEW_ADDR.a, name: "Fresh Mixer", category: "mixer" },
    ]);

    // --- Replace mode (default) -------------------------------------------
    selectEntityFile("mode.json", snapshot);
    await screen.findByTestId("text-preview-incoming");

    // The second box reads "Current list" and shows the bundled count, NOT a
    // resulting count. Replace surfaces removed/changed/unchanged badges and no
    // override note.
    const replaceBox = screen.getByTestId("text-preview-current").parentElement!;
    expect(replaceBox.textContent).toContain("Current list");
    expect(replaceBox.textContent).not.toContain("After merge");
    expect(screen.getByTestId("text-preview-current").textContent).toBe(
      bundledCount.toLocaleString(),
    );
    expect(screen.getByTestId("badge-preview-added").textContent).toContain(
      "added",
    );
    expect(screen.getByTestId("badge-preview-removed")).toBeTruthy();
    expect(screen.getByTestId("badge-preview-changed")).toBeTruthy();
    expect(screen.queryByTestId("text-merge-override-note")).toBeNull();

    // --- Switch to merge mode --------------------------------------------
    // Close the dialog first so the import-mode radios are interactable, then
    // pick merge and re-select the same file (the preview is recomputed at
    // selection time using the new mode).
    fireEvent.click(screen.getByTestId("button-cancel-entity-import"));
    await waitFor(() =>
      expect(screen.queryByTestId("text-preview-incoming")).toBeNull(),
    );

    fireEvent.click(screen.getByTestId("radio-entity-merge"));
    selectEntityFile("mode.json", snapshot);
    await screen.findByTestId("text-preview-incoming");

    // Now the box reads "After merge" and shows bundled + 1 brand-new. The
    // replace-only badges are gone and the override note appears.
    const mergeBox = screen.getByTestId("text-preview-current").parentElement!;
    expect(mergeBox.textContent).toContain("After merge");
    expect(screen.getByTestId("text-preview-current").textContent).toBe(
      (bundledCount + 1).toLocaleString(),
    );
    expect(screen.getByTestId("badge-preview-added").textContent).toContain(
      "+1 brand-new",
    );
    expect(screen.queryByTestId("badge-preview-removed")).toBeNull();
    expect(screen.queryByTestId("badge-preview-changed")).toBeNull();
    expect(screen.getByTestId("text-merge-override-note")).toBeTruthy();
  });
});
