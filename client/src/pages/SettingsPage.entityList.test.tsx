// @vitest-environment jsdom
//
// Integration coverage for the Privacy Audit "Entity List" panel inside the
// Settings page (Task #432). The store-level apply/persist functions
// (entity-list-store) and the pure preview/diff logic are unit tested
// elsewhere; this file drives the actual UI that wires them together:
//   - choosing a JSON file -> validation -> preview confirmation dialog
//   - confirming the swap -> active source flips to "imported" + persisted
//   - importing an invalid snapshot -> per-entry errors, nothing applied
//   - "Revert to bundled" -> bundled list restored, persisted snapshot cleared
//
// We use the real Dexie database (fake-indexeddb), the real entity-list-store,
// settings-crud and privacy-entity-list modules, so the whole chain runs end to
// end and useSettings' live query reactively flips the panel's badge. Only the
// auth context and the unrelated heavy sibling panels are stubbed so the test
// stays focused on the entity-list panel.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

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
const { putSettings, getSettings } = await import("@/lib/data/settings-crud");
const {
  resetActiveEntityList,
  getActiveEntitySource,
  getBundledEntityCount,
} = await import("@/lib/privacy-entity-list");
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses that are NOT in the bundled list so the preview shows
// a non-zero "added" count.
const ADDR = {
  a: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  b: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
} as const;

function fakeFile(name: string, contents: string) {
  // The handler only uses file.name and file.text(); a minimal stand-in avoids
  // relying on jsdom's Blob.text() implementation.
  return { name, text: async () => contents } as unknown as File;
}

async function selectEntityFile(name: string, contents: string) {
  const input = screen.getByTestId("input-entity-file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fakeFile(name, contents)] } });
}

beforeEach(async () => {
  // The real app always has a 'default' settings row; updateSettings is a no-op
  // when it's absent, so seed one before each test. A put replaces the whole
  // row, so this also clears any entityListSnapshot left by a prior test.
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — Privacy Audit Entity List panel", () => {
  it("imports a valid snapshot: preview shows counts, confirm flips source to imported", async () => {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );

    // Starts on the bundled list.
    const badge = await screen.findByTestId("badge-entity-source");
    expect(badge.textContent).toBe("Bundled");
    expect(getActiveEntitySource()).toBe("bundled");

    const snapshot = JSON.stringify([
      { address: ADDR.a, name: "New Exchange", category: "exchange" },
      { address: ADDR.b, name: "New Mixer", category: "mixer" },
    ]);
    await selectEntityFile("snapshot.json", snapshot);

    // Preview dialog appears with the incoming/current counts and the diff badges.
    const incoming = await screen.findByTestId("text-preview-incoming");
    expect(incoming.textContent).toBe("2");
    expect(screen.getByTestId("text-preview-current").textContent).toBe(
      getBundledEntityCount().toLocaleString(),
    );
    // Both addresses are new, so "added" is 2.
    expect(screen.getByTestId("badge-preview-added").textContent).toContain("2");
    expect(screen.getByTestId("badge-preview-removed")).toBeTruthy();

    // Nothing is applied until the user confirms.
    expect(getActiveEntitySource()).toBe("bundled");

    fireEvent.click(screen.getByTestId("button-confirm-entity-import"));

    // Active source flips to imported and the badge reflects it (live query).
    await waitFor(() => expect(getActiveEntitySource()).toBe("imported"));
    await waitFor(() =>
      expect(screen.getByTestId("badge-entity-source").textContent).toBe("Imported"),
    );

    // Persisted to the settings record.
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot?.entries).toHaveLength(2);
    expect(settings?.entityListSnapshot?.sourceLabel).toBe("snapshot.json");

    // Preview dialog closed.
    await waitFor(() =>
      expect(screen.queryByTestId("text-preview-incoming")).toBeNull(),
    );
  });

  it("surfaces per-entry errors for an invalid snapshot and applies nothing", async () => {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );
    await screen.findByTestId("badge-entity-source");

    const badSnapshot = JSON.stringify([
      { address: "not-a-valid-address", name: "Bad", category: "exchange" },
      { address: ADDR.a, name: "Missing Category", category: "" },
    ]);
    await selectEntityFile("bad.json", badSnapshot);

    // Error container is shown with per-entry messages (one per bad entry).
    const errors = await screen.findByTestId("container-entity-errors");
    expect(errors).toBeTruthy();
    expect(screen.getByTestId("text-entity-error-0")).toBeTruthy();
    expect(screen.getByTestId("text-entity-error-1")).toBeTruthy();

    // No preview dialog and nothing applied.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot).toBeUndefined();
  });

  it("reverts to the bundled list and clears the persisted snapshot", async () => {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );
    await screen.findByTestId("badge-entity-source");

    // Import a valid snapshot first.
    const snapshot = JSON.stringify([
      { address: ADDR.a, name: "New Exchange", category: "exchange" },
    ]);
    await selectEntityFile("snapshot.json", snapshot);
    await screen.findByTestId("button-confirm-entity-import");
    fireEvent.click(screen.getByTestId("button-confirm-entity-import"));

    await waitFor(() =>
      expect(screen.getByTestId("badge-entity-source").textContent).toBe("Imported"),
    );
    expect((await getSettings("default"))?.entityListSnapshot).toBeDefined();

    // Now revert.
    fireEvent.click(screen.getByTestId("button-reset-entities"));

    await waitFor(() => expect(getActiveEntitySource()).toBe("bundled"));
    await waitFor(() =>
      expect(screen.getByTestId("badge-entity-source").textContent).toBe("Bundled"),
    );
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot).toBeUndefined();
  });

  it("exports the current list as a downloadable JSON file", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const createObjectURL = vi.fn(() => {
      const url = `blob:mock-${created.length}`;
      created.push(url);
      return url;
    });
    const revokeObjectURL = vi.fn((url: string) => revoked.push(url));
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    // Don't actually trigger a navigation in jsdom.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      render(
        <ActivityBusProvider>
          <SettingsPage />
        </ActivityBusProvider>,
      );
      await screen.findByTestId("badge-entity-source");

      fireEvent.click(screen.getByTestId("button-export-entities"));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      // A Blob was handed to createObjectURL and the anchor was clicked.
      const blobArg = createObjectURL.mock.calls[0][0] as Blob;
      expect(blobArg).toBeInstanceOf(Blob);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      // The object URL is revoked after the download is triggered.
      expect(revoked).toEqual(created);
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
