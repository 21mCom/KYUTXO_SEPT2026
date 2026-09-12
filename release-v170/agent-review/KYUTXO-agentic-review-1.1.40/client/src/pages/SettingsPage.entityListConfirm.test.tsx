// @vitest-environment jsdom
//
// Component coverage for the *confirm* path of the Privacy Audit "Entity List"
// import dialog inside the Settings page. The sibling
// SettingsPage.entityListSummary.test.tsx covers the previewed numbers (the
// "After merge" total, override note, badges) and the cancel path is exercised
// elsewhere, but actually clicking "Confirm entity list import" and verifying
// the *applied* active list had no component-level coverage. A regression here
// would let the dialog show a correct preview yet apply the wrong list.
//
// These tests drive the real dialog to a valid preview, click
// button-confirm-entity-import, and then assert against the real
// entity-list-store + privacy-entity-list modules that the resulting ACTIVE
// list is exactly what was previewed:
//   - merge mode: bundled + brand-new (== the previewed resultingCount), and
//     the brand-new entries are actually present in the active list,
//   - replace mode: the active list equals the incoming snapshot exactly,
//   - the dialog closes and the Settings panel reflects the import (badge flips
//     to "Imported", the active count text matches the previewed numbers).

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows; these tests never open the virtualized diff, but the
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
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
const { putSettings, getSettings } = await import("@/lib/data/settings-crud");
const {
  resetActiveEntityList,
  getBundledEntityCount,
  getBundledEntityList,
  getActiveEntityList,
  getActiveEntityCount,
  getActiveEntitySource,
} = await import("@/lib/privacy-entity-list");
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses that are NOT in the bundled list, so they count as
// brand-new in a merge preview / fresh entries in a replace.
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

describe("SettingsPage — entity list import (confirm applies the merge)", () => {
  it("applies a merge so the active list is bundled + brand-new, matching the previewed After merge total", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    const bundledCount = getBundledEntityCount();
    const bundled0 = getBundledEntityList()[0];
    expect(bundled0).toBeTruthy();

    // Merge mode must be chosen BEFORE selecting a file: the preview is computed
    // at selection time from the current mode.
    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    // One override of a bundled entry (does not grow the list) + two brand-new
    // entries (which do). The previewed "After merge" must therefore be
    // bundled + 2, and that is what confirm must produce.
    const snapshot = [
      { address: bundled0.address, name: "Renamed Mix", category: "gambling" },
      { address: NEW_ADDR.a, name: "Fresh Mixer", category: "mixer" },
      { address: NEW_ADDR.b, name: "Fresh Exchange", category: "exchange" },
    ];
    const expectedResulting = bundledCount + 2;

    selectEntityFile("merge.json", JSON.stringify(snapshot));

    // Wait for the preview and confirm the previewed "After merge" number is the
    // one we expect before clicking confirm.
    await waitFor(() =>
      expect(screen.getByTestId("text-preview-current").textContent).toBe(
        expectedResulting.toLocaleString(),
      ),
    );

    fireEvent.click(screen.getByTestId("button-confirm-entity-import"));

    // Dialog closes on success.
    await waitFor(() =>
      expect(screen.queryByTestId("text-preview-incoming")).toBeNull(),
    );

    // The applied ACTIVE list is exactly the previewed resulting count...
    expect(getActiveEntityCount()).toBe(expectedResulting);
    expect(getActiveEntityList()).toHaveLength(expectedResulting);
    expect(getActiveEntitySource()).toBe("imported");

    // ...and the brand-new entries are actually present, with the override
    // applied on top of the bundled entry.
    const activeByAddr = new Map(
      getActiveEntityList().map((e) => [e.address, e]),
    );
    expect(activeByAddr.get(NEW_ADDR.a)?.name).toBe("Fresh Mixer");
    expect(activeByAddr.get(NEW_ADDR.b)?.name).toBe("Fresh Exchange");
    expect(activeByAddr.get(bundled0.address)?.name).toBe("Renamed Mix");
    expect(activeByAddr.get(bundled0.address)?.category).toBe("gambling");

    // The Settings panel reflects the import: the badge flips to "Imported" and
    // the active-list text reports the 3 imported entries on top of bundled.
    await waitFor(() =>
      expect(screen.getByTestId("badge-entity-source").textContent).toContain(
        "Imported",
      ),
    );
    expect(screen.getByTestId("text-entity-count").textContent).toBe(
      snapshot.length.toLocaleString(),
    );

    // Only the user-supplied entries are persisted (so bundled updates still
    // flow through), tagged with the merge mode.
    const persisted = (await getSettings("default"))?.entityListSnapshot;
    expect(persisted?.mode).toBe("merge");
    expect(persisted?.entries).toHaveLength(snapshot.length);
  });

  it("applies a replace so the active list equals the incoming snapshot exactly", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Replace mode is the default; the incoming snapshot becomes the entire
    // active list regardless of the bundled contents.
    const snapshot = [
      { address: NEW_ADDR.a, name: "Only Mixer", category: "mixer" },
      { address: NEW_ADDR.b, name: "Only Exchange", category: "exchange" },
    ];

    selectEntityFile("replace.json", JSON.stringify(snapshot));

    // Replace shows "Current list" (the baseline), and incoming == snapshot.
    await waitFor(() =>
      expect(screen.getByTestId("text-preview-incoming").textContent).toBe(
        snapshot.length.toLocaleString(),
      ),
    );

    fireEvent.click(screen.getByTestId("button-confirm-entity-import"));

    await waitFor(() =>
      expect(screen.queryByTestId("text-preview-incoming")).toBeNull(),
    );

    // The active list is exactly the incoming snapshot — no bundled entries.
    expect(getActiveEntityCount()).toBe(snapshot.length);
    const active = getActiveEntityList();
    expect(active).toHaveLength(snapshot.length);
    expect(new Set(active.map((e) => e.address))).toEqual(
      new Set(snapshot.map((e) => e.address)),
    );
    expect(getActiveEntityList().find((e) => e.address === NEW_ADDR.a)?.name).toBe(
      "Only Mixer",
    );
    expect(getActiveEntitySource()).toBe("imported");

    // The panel reflects the replace: "Imported", count == snapshot length.
    await waitFor(() =>
      expect(screen.getByTestId("badge-entity-source").textContent).toContain(
        "Imported",
      ),
    );
    expect(screen.getByTestId("text-entity-count").textContent).toBe(
      snapshot.length.toLocaleString(),
    );

    const persisted = (await getSettings("default"))?.entityListSnapshot;
    expect(persisted?.mode).toBe("replace");
    expect(persisted?.entries).toHaveLength(snapshot.length);
  });
});
