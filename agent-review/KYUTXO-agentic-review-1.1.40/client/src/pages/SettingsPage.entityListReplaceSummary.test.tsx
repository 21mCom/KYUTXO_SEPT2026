// @vitest-environment jsdom
//
// Component coverage for the replace-mode summary badges (+X added, −Y removed,
// Z changed, W unchanged) of the Privacy Audit "Entity List" import
// confirmation dialog inside the Settings page. The merge-mode badges are
// covered by SettingsPage.entityListMerge.test.tsx and the per-category table
// by SettingsPage.entityListCategoryDiff.test.tsx; this file drives the
// replace-mode summary badges so a regression that swaps "added"/"removed" or
// miscounts "changed" vs "unchanged" would be caught before a user replaces the
// security-sensitive entity list.
//
// We use the real entity-list-store + privacy-entity-list modules. The active
// list (the baseline for a *replace* preview) is seeded with a known small set
// via setActiveEntityList so the summary counts are fully deterministic.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

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

// Valid mainnet addresses (used in the incoming snapshot, which IS validated).
const ADDR = {
  exchange: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  exchange2: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
  gambling: "1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv",
  mixerA: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  mixerB: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
} as const;

// The known baseline (replace mode compares against the active list).
const BASELINE: EntityEntry[] = [
  { address: ADDR.exchange, name: "Ex One", category: "exchange" },
  { address: ADDR.exchange2, name: "Ex Two", category: "exchange" },
  { address: ADDR.gambling, name: "Gam One", category: "gambling" },
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

describe("SettingsPage — entity list import (replace-mode summary badges)", () => {
  it("shows the correct added/removed/changed/unchanged counts for a mixed snapshot", async () => {
    renderPage();
    // Wait for the panel to finish its startup load before overriding the
    // active list (the load resets to bundled when there is no snapshot).
    await screen.findByTestId("badge-entity-source");

    // Seed a known baseline so the replace preview is deterministic.
    setActiveEntityList(BASELINE);

    // Replace mode is the default. The incoming snapshot is built to exercise
    // every bucket exactly once-or-more:
    //   - exchange  : same address, DIFFERENT name        → changed   (1)
    //   - exchange2 : identical entry                      → unchanged (1)
    //   - mixerA    : brand-new address                    → added
    //   - mixerB    : brand-new address                    → added     (2)
    //   - gambling  : in baseline but absent from snapshot → removed   (1)
    const snapshot = JSON.stringify([
      { address: ADDR.exchange, name: "Ex One RENAMED", category: "exchange" },
      { address: ADDR.exchange2, name: "Ex Two", category: "exchange" },
      { address: ADDR.mixerA, name: "Mix One", category: "mixer" },
      { address: ADDR.mixerB, name: "Mix Two", category: "mixer" },
    ]);
    await selectEntityFile("replace.json", snapshot);

    // Preview dialog appears. Incoming snapshot has 4 entries.
    const incoming = await screen.findByTestId("text-preview-incoming");
    expect(incoming.textContent).toBe("4");
    const confirmButton = screen.getByTestId("button-confirm-entity-import");
    expect(confirmButton.textContent).toContain("Replace list");
    expect(confirmButton.textContent).not.toContain("Merge list");

    // Each summary badge shows the count for its own bucket. We assert the
    // count is present in the correct badge so a swap of added/removed (or a
    // changed/unchanged miscount) is caught.
    expect(
      screen.getByTestId("badge-preview-added").textContent,
    ).toContain("2");
    expect(
      screen.getByTestId("badge-preview-added").textContent,
    ).toMatch(/added/i);

    expect(
      screen.getByTestId("badge-preview-removed").textContent,
    ).toContain("1");
    expect(
      screen.getByTestId("badge-preview-removed").textContent,
    ).toMatch(/removed/i);

    expect(
      screen.getByTestId("badge-preview-changed").textContent,
    ).toContain("1");
    expect(
      screen.getByTestId("badge-preview-changed").textContent,
    ).toMatch(/changed/i);

    expect(
      screen.getByTestId("badge-preview-unchanged").textContent,
    ).toContain("1");
    expect(
      screen.getByTestId("badge-preview-unchanged").textContent,
    ).toMatch(/unchanged/i);
  });

  it("counts a source-note-only change as changed, not unchanged", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Baseline: one entry with a source note, one without.
    setActiveEntityList([
      {
        address: ADDR.exchange,
        name: "Ex One",
        category: "exchange",
        sourceNote: "https://example.com/address/old",
      },
      { address: ADDR.exchange2, name: "Ex Two", category: "exchange" },
    ]);

    // Incoming: same names/categories, but the first entry's source note
    // differs (re-attribution). That alone must count as a change.
    const snapshot = JSON.stringify([
      {
        address: ADDR.exchange,
        name: "Ex One",
        category: "exchange",
        sourceNote: "https://example.com/address/new",
      },
      { address: ADDR.exchange2, name: "Ex Two", category: "exchange" },
    ]);
    await selectEntityFile("note-change.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    // Nothing added or removed; one re-attributed, one truly unchanged.
    expect(
      screen.getByTestId("badge-preview-added").textContent,
    ).toContain("0");
    expect(
      screen.getByTestId("badge-preview-removed").textContent,
    ).toContain("0");
    expect(
      screen.getByTestId("badge-preview-changed").textContent,
    ).toContain("1");
    expect(
      screen.getByTestId("badge-preview-unchanged").textContent,
    ).toContain("1");
  });
});
