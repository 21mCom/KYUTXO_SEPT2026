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

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so without these shims the
// virtualized error list (used above ENTITY_ERROR_VIRTUALIZE_THRESHOLD errors)
// would render zero rows and the row assertions could never run. Provide a
// minimal ResizeObserver and non-zero layout so the virtualizer produces its
// overscan window.
const FAKE_RECT: DOMRect = {
  width: 400,
  height: 256,
  top: 0,
  left: 0,
  right: 400,
  bottom: 256,
  x: 0,
  y: 0,
  toJSON() {},
};

beforeAll(() => {
  // @tanstack/virtual-core sizes the scroll viewport from the element's
  // offsetWidth/offsetHeight (see getRect), which jsdom always reports as 0.
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 400;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 256;
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
const { ActivityBusProvider } = await import("@/lib/activity-bus");
const { putSettings, getSettings } = await import("@/lib/data/settings-crud");
const {
  resetActiveEntityList,
  getActiveEntitySource,
  getActiveEntityCount,
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

  it("merge mode: unions imported entries onto the bundled list and persists only user entries", async () => {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );

    // Starts on the bundled list.
    await screen.findByTestId("badge-entity-source");
    expect(getActiveEntitySource()).toBe("bundled");
    const bundledCount = getBundledEntityCount();

    // Choose the "Merge with bundled" mode before importing.
    fireEvent.click(screen.getByTestId("radio-entity-merge"));

    // Both addresses are new (not in the bundled list), so the merge adds two.
    const snapshot = JSON.stringify([
      { address: ADDR.a, name: "New Exchange", category: "exchange" },
      { address: ADDR.b, name: "New Mixer", category: "mixer" },
    ]);
    await selectEntityFile("snapshot.json", snapshot);

    // Preview dialog appears. For merge the baseline is the bundled list, and
    // "after merge" reflects bundled + the two new entries.
    const incoming = await screen.findByTestId("text-preview-incoming");
    expect(incoming.textContent).toBe("2");

    // Nothing applied until the user confirms.
    expect(getActiveEntitySource()).toBe("bundled");

    fireEvent.click(screen.getByTestId("button-confirm-entity-import"));

    // Active source flips to imported and the active count is bundled + new
    // entries — NOT just the two imported entries.
    await waitFor(() => expect(getActiveEntitySource()).toBe("imported"));
    await waitFor(() =>
      expect(screen.getByTestId("badge-entity-source").textContent).toBe("Imported"),
    );
    expect(getActiveEntityCount()).toBe(bundledCount + 2);

    // Persisted snapshot records merge mode and only the user-supplied entries
    // (so future bundled updates still flow through).
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot?.mode).toBe("merge");
    expect(settings?.entityListSnapshot?.entries).toHaveLength(2);
    expect(settings?.entityListSnapshot?.sourceLabel).toBe("snapshot.json");

    // Preview dialog closed.
    await waitFor(() =>
      expect(screen.queryByTestId("text-preview-incoming")).toBeNull(),
    );
  });

  it("warns about a mismatched source citation but still allows the import", async () => {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );

    await screen.findByTestId("badge-entity-source");

    // ADDR.a's source note cites ADDR.b — a copy/paste mistake we should flag.
    const snapshot = JSON.stringify([
      {
        address: ADDR.a,
        name: "New Exchange",
        category: "exchange",
        sourceNote: `https://www.walletexplorer.com/address/${ADDR.b}`,
      },
    ]);
    await selectEntityFile("snapshot.json", snapshot);

    // Preview still appears (valid) and the warning container is shown alongside it.
    await screen.findByTestId("text-preview-incoming");
    const warnings = await screen.findByTestId("container-entity-import-warnings");
    expect(warnings).toBeTruthy();
    const warningText = screen.getByTestId("text-entity-warning-0").textContent ?? "";
    expect(warningText).toContain("cites a different address");
    expect(warningText).toContain(ADDR.a);

    // The import can still be confirmed despite the warning.
    fireEvent.click(screen.getByTestId("button-confirm-entity-import"));
    await waitFor(() => expect(getActiveEntitySource()).toBe("imported"));
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

    // Error container is shown, with the two bad entries bucketed into their
    // problem-type groups (one invalid address, one missing category).
    const errors = await screen.findByTestId("container-entity-errors");
    expect(errors).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-invalid-address")).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-missing-category")).toBeTruthy();

    // Two distinct kinds means the groups collapse by default; expanding one
    // reveals its single offending entry row.
    expect(screen.queryByTestId("text-entity-error-0")).toBeNull();
    fireEvent.click(screen.getByTestId("button-entity-error-group-invalid-address"));
    await waitFor(() =>
      expect(screen.getByTestId("text-entity-error-0")).toBeTruthy(),
    );

    // No preview dialog and nothing applied.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot).toBeUndefined();
  });

  it("stays responsive with hundreds of errors: virtualizes the list and applies nothing", async () => {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );
    await screen.findByTestId("badge-entity-source");

    // Generate well over the virtualization threshold (100). Each entry has an
    // invalid address, which yields exactly one per-entry error, so the error
    // count equals the number of entries.
    const ERROR_COUNT = 250;
    const badEntries = Array.from({ length: ERROR_COUNT }, (_, i) => ({
      address: `not-a-valid-address-${i}`,
      name: `Bad ${i}`,
      category: "exchange",
    }));
    await selectEntityFile("many-bad.json", JSON.stringify(badEntries));

    // Error container appears with the full count (no cap).
    const errors = await screen.findByTestId("container-entity-errors");
    expect(errors.textContent).toContain(ERROR_COUNT.toLocaleString());

    // The virtualized list renders only a window of rows, not all 250. The first
    // rows are present (data-testid text-entity-error-0, -1, ...) while rows far
    // outside the visible window are not yet mounted.
    expect(screen.getByTestId("text-entity-error-0")).toBeTruthy();
    expect(screen.getByTestId("text-entity-error-1")).toBeTruthy();
    expect(screen.queryByTestId(`text-entity-error-${ERROR_COUNT - 1}`)).toBeNull();

    // The number of mounted error rows is a small window, confirming the list
    // is virtualized rather than rendering every row.
    const mountedRows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(ERROR_COUNT);

    // No preview dialog and nothing applied.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    const settings = await getSettings("default");
    expect(settings?.entityListSnapshot).toBeUndefined();
  });

  it("groups a mixed-error snapshot by problem type with the right counts, ordering, and expansion", async () => {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );
    await screen.findByTestId("badge-entity-source");

    // A file that hits three different error kinds with different multiplicities
    // so we can assert grouping, per-group counts, and most-common-first order:
    //   - unknown-category × 3  (valid address + name, bogus category)
    //   - invalid-address  × 2  (bad address, valid name + category)
    //   - missing-name     × 1  (valid address + category, empty name)
    // Reusing the same valid address across the unknown-category entries is safe
    // because only fully-valid entries are recorded for duplicate detection, so
    // these never collapse into spurious duplicate-address errors.
    const mixed = JSON.stringify([
      { address: ADDR.a, name: "Bogus One", category: "not-a-category" },
      { address: "totally-invalid-1", name: "Bad Addr One", category: "exchange" },
      { address: ADDR.b, name: "Bogus Two", category: "definitely-wrong" },
      { address: ADDR.a, name: "Bogus Three", category: "nope" },
      { address: "totally-invalid-2", name: "Bad Addr Two", category: "mixer" },
      { address: ADDR.b, name: "", category: "exchange" },
    ]);
    await selectEntityFile("mixed.json", mixed);

    // The error container appears with the total problem count (6).
    const container = await screen.findByTestId("container-entity-errors");
    expect(container.textContent).toContain("6 problems");

    // Each expected problem-type group heading is present with its count badge.
    expect(screen.getByTestId("group-entity-error-unknown-category")).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-invalid-address")).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-missing-name")).toBeTruthy();
    expect(
      screen.getByTestId("badge-entity-error-count-unknown-category").textContent,
    ).toBe("3");
    expect(
      screen.getByTestId("badge-entity-error-count-invalid-address").textContent,
    ).toBe("2");
    expect(
      screen.getByTestId("badge-entity-error-count-missing-name").textContent,
    ).toBe("1");

    // Groups are ordered most-common-first: unknown-category (3), then
    // invalid-address (2), then missing-name (1).
    const order = screen
      .getAllByTestId(/^group-entity-error-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "group-entity-error-unknown-category",
      "group-entity-error-invalid-address",
      "group-entity-error-missing-name",
    ]);

    // With multiple groups, every group starts collapsed — no offending entry
    // rows are rendered until a heading is expanded.
    expect(screen.queryByTestId("text-entity-error-0")).toBeNull();

    // Expanding the unknown-category group reveals exactly its three offending
    // entry rows (row indices are local to the expanded group).
    fireEvent.click(
      screen.getByTestId("button-entity-error-group-unknown-category"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("text-entity-error-0")).toBeTruthy(),
    );
    const rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows.length).toBe(3);
    // The revealed rows are the unknown-category failures, not some other kind.
    expect(container.textContent).toContain('Unknown category "not-a-category"');

    // Nothing was applied — still on the bundled list, no persisted snapshot.
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("auto-expands the only group when every error is the same kind", async () => {
    render(
      <ActivityBusProvider>
        <SettingsPage />
      </ActivityBusProvider>,
    );
    await screen.findByTestId("badge-entity-source");

    // Every entry has the same problem (invalid address), so there is a single
    // group with nothing to triage between — it should open automatically.
    const sameKind = JSON.stringify([
      { address: "totally-invalid-1", name: "One", category: "exchange" },
      { address: "totally-invalid-2", name: "Two", category: "exchange" },
    ]);
    await selectEntityFile("same-kind.json", sameKind);

    const group = await screen.findByTestId("group-entity-error-invalid-address");
    expect(group).toBeTruthy();
    expect(
      screen.getByTestId("badge-entity-error-count-invalid-address").textContent,
    ).toBe("2");

    // The single group is expanded without any click, so its offending rows are
    // already visible.
    expect(screen.getByTestId("text-entity-error-0")).toBeTruthy();
    expect(screen.getByTestId("text-entity-error-1")).toBeTruthy();
    expect(screen.getAllByTestId(/^text-entity-error-\d+$/).length).toBe(2);

    // Nothing applied.
    expect(getActiveEntitySource()).toBe("bundled");
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
