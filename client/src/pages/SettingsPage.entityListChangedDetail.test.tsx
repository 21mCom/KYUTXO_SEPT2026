// @vitest-environment jsdom
//
// Component coverage for the *changed-entries detail list* of the Privacy Audit
// "Entity List" import confirmation dialog (replace mode) inside the Settings
// page. The replace-mode summary *badges* (added/removed/changed/unchanged
// counts) are covered by SettingsPage.entityListReplaceSummary.test.tsx; this
// file drives the per-row detail list under the "Changed" tab, which shows
// *which* fields changed for each overlapping address (name / category /
// source note) and the exact before → after values.
//
// A regression here would be silent in the count badges: e.g. swapping the
// before/after order (showing the incoming value where the current one belongs,
// or vice versa), or flagging the wrong field as changed (a re-categorization
// rendered as a rename). Those are exactly the mislabelings a user reviews
// before replacing the security-sensitive entity list, so they need UI-level
// coverage.
//
// We use the real entity-list-store + privacy-entity-list modules. The active
// list (the baseline for a *replace* preview) is seeded with a known small set
// via setActiveEntityList so the diff is fully deterministic.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so without these shims the
// virtualized changed-entries list would render zero rows and the before/after
// assertions could never run. Provide a minimal ResizeObserver and a non-zero
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
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
const { putSettings } = await import("@/lib/data/settings-crud");
const { resetActiveEntityList, setActiveEntityList } = await import(
  "@/lib/privacy-entity-list"
);
import type { EntityEntry } from "@/lib/privacy-entity-list";
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses (the incoming snapshot IS validated).
const ADDR = {
  rename: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  recat: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
  renote: "1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv",
} as const;

const OLD_NOTE = "https://example.com/address/old";
const NEW_NOTE = "https://example.com/address/new";

// Baseline (active list) — replace mode compares the incoming snapshot against
// this. Each entry is set up to change exactly one field so the per-row change
// indicators can be asserted in isolation.
const BASELINE: EntityEntry[] = [
  { address: ADDR.rename, name: "Ex One", category: "exchange" },
  { address: ADDR.recat, name: "Ex Two", category: "exchange" },
  {
    address: ADDR.renote,
    name: "Gam One",
    category: "gambling",
    sourceNote: OLD_NOTE,
  },
];

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

// Radix Tabs default to "automatic" activation (a trigger activates when it
// receives focus). jsdom's fireEvent.click doesn't move focus, so focus the
// trigger explicitly to switch tabs.
function openChangedTab() {
  const trigger = screen.getByTestId("tab-entity-diff-changed");
  fireEvent.focus(trigger);
  fireEvent.click(trigger);
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

describe("SettingsPage — entity list import (replace-mode changed-entries detail)", () => {
  it("shows the correct before/after values and change indicators per changed entry", async () => {
    renderPage();
    // Wait for the panel to finish its startup load before overriding the
    // active list (the load resets to bundled when there is no snapshot).
    await screen.findByTestId("badge-entity-source");

    // Seed a known baseline so the replace preview is deterministic.
    setActiveEntityList(BASELINE);

    // Replace mode is the default. The incoming snapshot keeps every baseline
    // address but mutates exactly one field on each, in baseline order so the
    // changed-list rows are 0 (name), 1 (category), 2 (source note):
    //   - rename : new name, same category, no note         → nameChanged only
    //   - recat  : same name, new category                  → categoryChanged only
    //   - renote : same name/category, new source note      → sourceNoteChanged only
    const snapshot = JSON.stringify([
      { address: ADDR.rename, name: "Ex One RENAMED", category: "exchange" },
      { address: ADDR.recat, name: "Ex Two", category: "gambling" },
      {
        address: ADDR.renote,
        name: "Gam One",
        category: "gambling",
        sourceNote: NEW_NOTE,
      },
    ]);
    await selectEntityFile("changed.json", snapshot);

    // Preview dialog appears: 3 incoming, all 3 overlapping addresses changed.
    await screen.findByTestId("text-preview-incoming");
    expect(
      screen.getByTestId("badge-preview-changed").textContent,
    ).toContain("3");
    // Nothing was added or removed — all three are pre-existing changes.
    expect(
      screen.getByTestId("badge-preview-added").textContent,
    ).toContain("0");
    expect(
      screen.getByTestId("badge-preview-removed").textContent,
    ).toContain("0");

    // Expand the affected-entries diff and switch to the Changed tab.
    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    const changedTab = await screen.findByTestId("tab-entity-diff-changed");
    expect(changedTab.textContent).toContain("Changed (3)");
    openChangedTab();

    // --- Row 0: a rename (name changed only) ---
    const row0 = await screen.findByTestId("row-entity-diff-changed-0");
    expect(row0.textContent).toContain(ADDR.rename);

    const name0 = within(row0).getByTestId("text-entity-diff-name-changed-0");
    // Before (struck through) and after (incoming) are both shown, in order.
    const before0 = within(name0).getByText("Ex One");
    const after0 = within(name0).getByText("Ex One RENAMED");
    expect(before0.className).toContain("line-through");
    expect(after0.className).not.toContain("line-through");

    // Category did not change → a single category badge, no old→new pair.
    expect(within(row0).getByText("Exchange")).toBeTruthy();
    expect(within(row0).queryByText("Gambling")).toBeNull();
    // No source-note diff for this row.
    expect(
      within(row0).queryByTestId("text-entity-diff-sourcenote-changed-0"),
    ).toBeNull();

    // --- Row 1: a re-categorization (category changed only) ---
    const row1 = await screen.findByTestId("row-entity-diff-changed-1");
    expect(row1.textContent).toContain(ADDR.recat);

    // Name did not change → rendered without strike-through (just the name).
    const name1 = within(row1).getByTestId("text-entity-diff-name-changed-1");
    expect(name1.textContent).toBe("Ex Two");
    expect(name1.querySelector(".line-through")).toBeNull();

    // Both the old ("Exchange", struck through) and new ("Gambling") category
    // labels are shown, in before → after order.
    const oldCat = within(row1).getByText("Exchange");
    const newCat = within(row1).getByText("Gambling");
    expect(oldCat.className).toContain("line-through");
    expect(newCat.className).not.toContain("line-through");
    // No source-note diff for this row.
    expect(
      within(row1).queryByTestId("text-entity-diff-sourcenote-changed-1"),
    ).toBeNull();

    // --- Row 2: a re-attribution (source note changed only) ---
    const row2 = await screen.findByTestId("row-entity-diff-changed-2");
    expect(row2.textContent).toContain(ADDR.renote);

    // Name unchanged (no strike-through), category unchanged (single badge).
    const name2 = within(row2).getByTestId("text-entity-diff-name-changed-2");
    expect(name2.textContent).toBe("Gam One");
    expect(name2.querySelector(".line-through")).toBeNull();

    // The source-note diff row is present and shows old → new, in order.
    const note2 = within(row2).getByTestId(
      "text-entity-diff-sourcenote-changed-2",
    );
    const oldNote = within(note2).getByText(OLD_NOTE);
    const newNote = within(note2).getByText(NEW_NOTE);
    expect(oldNote.className).toContain("line-through");
    expect(newNote.className).not.toContain("line-through");
  });

  it("renders an added/removed source note as a (none) → value (or value → (none)) diff", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Baseline: one entry WITHOUT a note, one WITH a note.
    setActiveEntityList([
      { address: ADDR.rename, name: "No Note", category: "exchange" },
      {
        address: ADDR.renote,
        name: "Has Note",
        category: "gambling",
        sourceNote: OLD_NOTE,
      },
    ]);

    // Incoming: the first gains a note (none → value), the second loses it
    // (value → none). Names/categories are otherwise identical.
    const snapshot = JSON.stringify([
      {
        address: ADDR.rename,
        name: "No Note",
        category: "exchange",
        sourceNote: NEW_NOTE,
      },
      { address: ADDR.renote, name: "Has Note", category: "gambling" },
    ]);
    await selectEntityFile("note-diff.json", snapshot);

    await screen.findByTestId("text-preview-incoming");
    expect(
      screen.getByTestId("badge-preview-changed").textContent,
    ).toContain("2");

    fireEvent.click(screen.getByTestId("button-toggle-entity-diff"));
    await screen.findByTestId("tab-entity-diff-changed");
    openChangedTab();

    // Row 0: note added → "(none)" struck through, NEW_NOTE as the new value.
    const note0 = await screen.findByTestId(
      "text-entity-diff-sourcenote-changed-0",
    );
    const added = within(note0).getByText(NEW_NOTE);
    const addedFrom = within(note0).getByText("(none)");
    expect(addedFrom.className).toContain("line-through");
    expect(added.className).not.toContain("line-through");

    // Row 1: note removed → OLD_NOTE struck through, "(none)" as the new value.
    const note1 = await screen.findByTestId(
      "text-entity-diff-sourcenote-changed-1",
    );
    const removedFrom = within(note1).getByText(OLD_NOTE);
    const removedTo = within(note1).getByText("(none)");
    expect(removedFrom.className).toContain("line-through");
    expect(removedTo.className).not.toContain("line-through");
  });
});
