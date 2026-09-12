// @vitest-environment jsdom
//
// Component coverage for the per-category change breakdown ("By category"
// table) of the Privacy Audit "Entity List" import confirmation dialog inside
// the Settings page. The pure diff math (buildEntitySnapshotPreview's
// EntityCategoryDiff[]) is unit-tested at the store layer; this file drives the
// actual confirmation UI that renders it so a regression in that table (a wrong
// label, or swapped incoming/current columns) would be caught before a user
// replaces the security-sensitive entity list.
//
// We use the real entity-list-store + privacy-entity-list modules. The active
// list (the baseline for a *replace* preview) is seeded with a known small set
// via setActiveEntityList so the per-category counts are fully deterministic.

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
const { resetActiveEntityList, setActiveEntityList, getBundledEntityList } =
  await import("@/lib/privacy-entity-list");
import type { EntityEntry } from "@/lib/privacy-entity-list";
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses (used in the incoming snapshot, which IS validated).
const ADDR = {
  exchange: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
  mixerA: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  mixerB: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  gambling: "1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv",
  exchange2: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s",
} as const;

// The known baseline (replace mode compares against the active list):
//   exchange: 2, gambling: 1.
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

function selectMergeMode() {
  fireEvent.click(screen.getByTestId("radio-entity-merge"));
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

describe("SettingsPage — entity list import (per-category diff table)", () => {
  it("renders each category row with the correct label, current, and incoming counts", async () => {
    renderPage();
    // Wait for the panel to finish its startup load before overriding the
    // active list (the load resets to bundled when there is no snapshot).
    await screen.findByTestId("badge-entity-source");

    // Seed a known baseline so the replace preview's per-category counts are
    // deterministic: exchange=2, gambling=1.
    setActiveEntityList(BASELINE);

    // Replace mode is the default. The incoming snapshot:
    //   exchange: 1 (overlaps an existing address), mixer: 2 (brand new).
    const snapshot = JSON.stringify([
      { address: ADDR.exchange, name: "Ex One", category: "exchange" },
      { address: ADDR.mixerA, name: "Mix One", category: "mixer" },
      { address: ADDR.mixerB, name: "Mix Two", category: "mixer" },
    ]);
    await selectEntityFile("replace.json", snapshot);

    // Preview dialog appears.
    const incoming = await screen.findByTestId("text-preview-incoming");
    expect(incoming.textContent).toBe("3");

    // exchange: current 2, incoming 1.
    expect(
      screen.getByTestId("text-preview-category-label-exchange").textContent,
    ).toBe("Exchange");
    expect(
      screen.getByTestId("text-preview-category-current-exchange").textContent,
    ).toBe("2");
    expect(
      screen.getByTestId("text-preview-category-incoming-exchange").textContent,
    ).toBe("1");

    // gambling: present only in the current list (current 1, incoming 0).
    expect(
      screen.getByTestId("text-preview-category-label-gambling").textContent,
    ).toBe("Gambling");
    expect(
      screen.getByTestId("text-preview-category-current-gambling").textContent,
    ).toBe("1");
    expect(
      screen.getByTestId("text-preview-category-incoming-gambling").textContent,
    ).toBe("0");

    // mixer: present only in the incoming snapshot (current 0, incoming 2).
    expect(
      screen.getByTestId("text-preview-category-label-mixer").textContent,
    ).toBe("Mixer / CoinJoin Service");
    expect(
      screen.getByTestId("text-preview-category-current-mixer").textContent,
    ).toBe("0");
    expect(
      screen.getByTestId("text-preview-category-incoming-mixer").textContent,
    ).toBe("2");
  });

  it("does not render rows for categories absent from both lists", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    setActiveEntityList(BASELINE);

    const snapshot = JSON.stringify([
      { address: ADDR.exchange, name: "Ex One", category: "exchange" },
      { address: ADDR.mixerA, name: "Mix One", category: "mixer" },
      { address: ADDR.mixerB, name: "Mix Two", category: "mixer" },
    ]);
    await selectEntityFile("replace.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    // Only exchange, gambling, and mixer appear on either side.
    expect(screen.getByTestId("row-preview-category-exchange")).toBeTruthy();
    expect(screen.getByTestId("row-preview-category-gambling")).toBeTruthy();
    expect(screen.getByTestId("row-preview-category-mixer")).toBeTruthy();

    // Categories with no entry on either side are omitted entirely.
    for (const absent of [
      "payment-service",
      "scam",
      "darknet",
      "mining-pool",
      "p2p-exchange",
    ]) {
      expect(
        screen.queryByTestId(`row-preview-category-${absent}`),
      ).toBeNull();
    }
  });
});

describe("SettingsPage — entity list import (overall net change total row)", () => {
  it("replace: total Current/New columns match currentCount and incomingCount", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Baseline of 3 (exchange 2, gambling 1).
    setActiveEntityList(BASELINE);

    // Incoming snapshot of 3 entries.
    const snapshot = JSON.stringify([
      { address: ADDR.exchange, name: "Ex One", category: "exchange" },
      { address: ADDR.mixerA, name: "Mix One", category: "mixer" },
      { address: ADDR.mixerB, name: "Mix Two", category: "mixer" },
    ]);
    await selectEntityFile("replace.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    expect(screen.getByTestId("row-preview-total")).toBeTruthy();
    // Current column == currentCount (active list = 3).
    expect(
      screen.getByTestId("text-preview-total-current").textContent,
    ).toBe("3");
    // New column == incomingCount (snapshot = 3).
    expect(
      screen.getByTestId("text-preview-total-incoming").textContent,
    ).toBe("3");
  });

  it("replace: total delta is +N (green) on a net increase", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Baseline of 1 (gambling).
    setActiveEntityList([
      { address: ADDR.gambling, name: "Gam One", category: "gambling" },
    ]);

    // Incoming snapshot of 3 — net +2.
    const snapshot = JSON.stringify([
      { address: ADDR.exchange, name: "Ex One", category: "exchange" },
      { address: ADDR.mixerA, name: "Mix One", category: "mixer" },
      { address: ADDR.mixerB, name: "Mix Two", category: "mixer" },
    ]);
    await selectEntityFile("replace-increase.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    const delta = screen.getByTestId("text-preview-total-delta");
    expect(delta.textContent).toBe("+2");
    expect(delta.className).toContain("text-green-600");
  });

  it("replace: total delta is −N (red) on a net decrease", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Baseline of 3.
    setActiveEntityList(BASELINE);

    // Incoming snapshot of 1 — net −2.
    const snapshot = JSON.stringify([
      { address: ADDR.exchange, name: "Ex One", category: "exchange" },
    ]);
    await selectEntityFile("replace-decrease.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    const delta = screen.getByTestId("text-preview-total-delta");
    // U+2212 MINUS SIGN, not an ASCII hyphen.
    expect(delta.textContent).toBe("\u22122");
    expect(delta.className).toContain("text-red-600");
  });

  it("replace: total delta is 0 (muted) when the count is unchanged", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Baseline of 3.
    setActiveEntityList(BASELINE);

    // Incoming snapshot also of 3 (different addresses) — net 0.
    const snapshot = JSON.stringify([
      { address: ADDR.mixerA, name: "Mix One", category: "mixer" },
      { address: ADDR.mixerB, name: "Mix Two", category: "mixer" },
      { address: ADDR.gambling, name: "Gam One", category: "gambling" },
    ]);
    await selectEntityFile("replace-unchanged.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    const delta = screen.getByTestId("text-preview-total-delta");
    expect(delta.textContent).toBe("0");
    expect(delta.className).toContain("text-muted-foreground");
  });

  it("merge: total columns match counts and delta is +N (green) on a net increase", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Merge always compares against the bundled list, regardless of the active
    // list, so the baseline (Current/Bundled) is the bundled entry count.
    const bundledCount = getBundledEntityList().length;

    selectMergeMode();

    // Two brand-new addresses (not in the bundled list) — net +2.
    const snapshot = JSON.stringify([
      { address: ADDR.mixerA, name: "Mix One", category: "mixer" },
      { address: ADDR.mixerB, name: "Mix Two", category: "mixer" },
    ]);
    await selectEntityFile("merge-increase.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    // Current column == currentCount (bundled list length).
    expect(
      screen.getByTestId("text-preview-total-current").textContent,
    ).toBe(bundledCount.toLocaleString());
    // New column == incomingCount (snapshot = 2).
    expect(
      screen.getByTestId("text-preview-total-incoming").textContent,
    ).toBe("2");

    const delta = screen.getByTestId("text-preview-total-delta");
    expect(delta.textContent).toBe("+2");
    expect(delta.className).toContain("text-green-600");
  });

  it("merge: total delta is 0 (muted) when every incoming address already exists", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    selectMergeMode();

    // A single entry that already exists in the bundled list: a merge never
    // removes bundled entries and this address adds nothing — net 0.
    const existing = getBundledEntityList()[0];
    const snapshot = JSON.stringify([
      { address: existing.address, name: existing.name, category: existing.category },
    ]);
    await selectEntityFile("merge-unchanged.json", snapshot);

    await screen.findByTestId("text-preview-incoming");

    const delta = screen.getByTestId("text-preview-total-delta");
    expect(delta.textContent).toBe("0");
    expect(delta.className).toContain("text-muted-foreground");
  });
});
