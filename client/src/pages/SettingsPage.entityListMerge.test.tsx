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
