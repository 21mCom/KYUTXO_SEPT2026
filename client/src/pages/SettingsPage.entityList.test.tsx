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

// The entity-error copy buttons fire a success / destructive toast alongside
// the clipboard write (Task #538). Capture toast() so we can assert the exact
// "Copied to clipboard" / "Copy failed" feedback, not just the clipboard call.
const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

// Unrelated heavy sibling panels (own DB queries / auth) — stub so they don't
// interfere with the entity-list panel under test.
vi.mock("@/components/VocabularyManager", () => ({ default: () => null }));
vi.mock("@/components/StripMarkersPanel", () => ({ default: () => null }));
vi.mock("@/components/MigrationAuditPanel", () => ({ default: () => null }));
vi.mock("@/components/LegacyRecoveryPanel", () => ({ default: () => null }));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way — this lets the "problem type" dropdown
// (select-entity-error-kind) be driven with fireEvent.change. The filter state
// path itself stays real. Mirrors the approach in SettingsPage.entityDiffFilter.
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

const SettingsPageModule = await import("./SettingsPage");
const SettingsPage = SettingsPageModule.default;
const { resetEntityErrorOpenState } = SettingsPageModule;
const { renderWithSettingsProviders } = await import(
  "@/test/settingsTestProviders"
);
const { putSettings, getSettings } = await import("@/lib/data/settings-crud");
const {
  resetActiveEntityList,
  setActiveEntityList,
  getActiveEntitySource,
  getActiveEntityCount,
  getBundledEntityCount,
  getBundledEntityList,
} = await import("@/lib/privacy-entity-list");
import type { EntityEntry } from "@/lib/privacy-entity-list";
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

// The error-list filter box and the "problem type" dropdown.
function setErrorFilter(value: string) {
  fireEvent.change(screen.getByTestId("input-entity-error-filter"), {
    target: { value },
  });
}
function setErrorKind(value: string) {
  // The Radix <Select> exposes its value through a change event on the trigger
  // (same approach the import-diff category filter test uses).
  fireEvent.change(screen.getByTestId("select-entity-error-kind"), {
    target: { value },
  });
}

// The warning/error UI renders AddressLink (clickable cited addresses), which
// calls useRecordPreview and throws outside a RecordPreviewProvider. Wrap the
// page in both providers so those clickable links can mount.
function renderSettingsPage() {
  return renderWithSettingsProviders(<SettingsPage />);
}

beforeEach(async () => {
  // The real app always has a 'default' settings row; updateSettings is a no-op
  // when it's absent, so seed one before each test. A put replaces the whole
  // row, so this also clears any entityListSnapshot left by a prior test.
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();
  // Module-level triage state persists across mounts within a JS session; clear
  // it between tests so a prior test's expand/collapse choices never leak in.
  resetEntityErrorOpenState();
  toastMock.mockClear();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — Privacy Audit Entity List panel", () => {
  it("imports a valid snapshot: preview shows counts, confirm flips source to imported", async () => {
    renderSettingsPage();

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

  it("renders the per-category change column with the right sign and color for growing, shrinking, and unchanged categories", async () => {
    // Reuse real (valid) bundled addresses so the incoming snapshot passes
    // validation; their categories here are reassigned freely since validation
    // only checks the address, a known category, and no duplicate addresses.
    const addrs = getBundledEntityList()
      .slice(0, 8)
      .map((e) => e.address);
    expect(new Set(addrs).size).toBe(8);

    // Stage a known active baseline (replace mode compares against the active
    // list): exchange ×3, mixer ×2, gambling ×1.
    const baseline: EntityEntry[] = [
      { address: addrs[0], name: "Cur Ex 1", category: "exchange" },
      { address: addrs[1], name: "Cur Ex 2", category: "exchange" },
      { address: addrs[2], name: "Cur Ex 3", category: "exchange" },
      { address: addrs[3], name: "Cur Mix 1", category: "mixer" },
      { address: addrs[4], name: "Cur Mix 2", category: "mixer" },
      { address: addrs[5], name: "Cur Gamble 1", category: "gambling" },
    ];

    renderWithSettingsProviders(<SettingsPage />);
    await screen.findByTestId("badge-entity-source");

    // Set the baseline AFTER render but BEFORE selecting the file, since the
    // preview is computed from the active list at selection time.
    setActiveEntityList(baseline);

    // Incoming snapshot (default "replace" mode):
    //   exchange ×5  -> delta +2 (growing)
    //   mixer    ×1  -> delta -1 (shrinking)
    //   gambling ×1  -> delta  0 (unchanged)
    const snapshot = JSON.stringify([
      { address: addrs[0], name: "Ex 1", category: "exchange" },
      { address: addrs[1], name: "Ex 2", category: "exchange" },
      { address: addrs[2], name: "Ex 3", category: "exchange" },
      { address: addrs[6], name: "Ex 4", category: "exchange" },
      { address: addrs[7], name: "Ex 5", category: "exchange" },
      { address: addrs[3], name: "Mix 1", category: "mixer" },
      { address: addrs[5], name: "Gamble 1", category: "gambling" },
    ]);
    await selectEntityFile("snapshot.json", snapshot);

    // Preview dialog appears with the by-category breakdown.
    await screen.findByTestId("text-preview-incoming");

    // Growing category: "+2" in the increase (green) color.
    const exchangeDelta = screen.getByTestId("text-preview-category-delta-exchange");
    expect(exchangeDelta.textContent).toBe("+2");
    expect(exchangeDelta.className).toContain("text-green-600");

    // Shrinking category: a real minus sign (U+2212) + magnitude, in the
    // decrease (red) color.
    const mixerDelta = screen.getByTestId("text-preview-category-delta-mixer");
    expect(mixerDelta.textContent).toBe("\u22121");
    expect(mixerDelta.className).toContain("text-red-600");

    // Unchanged category: a plain "0" in the muted (neutral) color, with no
    // increase/decrease color applied.
    const gamblingDelta = screen.getByTestId("text-preview-category-delta-gambling");
    expect(gamblingDelta.textContent).toBe("0");
    expect(gamblingDelta.className).toContain("text-muted-foreground");
    expect(gamblingDelta.className).not.toContain("text-green-600");
    expect(gamblingDelta.className).not.toContain("text-red-600");
  });

  it("merge mode: unions imported entries onto the bundled list and persists only user entries", async () => {
    renderSettingsPage();

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

  it("merge mode: override badge and note split genuinely-changed overrides from identical re-imports", async () => {
    renderSettingsPage();

    await screen.findByTestId("badge-entity-source");

    // Pull two real bundled entries to overlap with. One is re-imported
    // byte-for-byte (a no-op), the other only differs by display name (a
    // genuine change). A brand-new address rounds out the snapshot.
    const bundled = getBundledEntityList();
    const identical = bundled[0];
    const toChange = bundled[1];

    const snapshot = JSON.stringify([
      // Brand-new address (not in the bundled list) -> added.
      { address: ADDR.a, name: "New Exchange", category: "exchange" },
      // Identical re-import of a bundled entry -> override but NOT changed.
      {
        address: identical.address,
        name: identical.name,
        category: identical.category,
        ...(identical.sourceNote ? { sourceNote: identical.sourceNote } : {}),
      },
      // Same address as a bundled entry but a different name -> changed override.
      {
        address: toChange.address,
        name: `${toChange.name} (renamed)`,
        category: toChange.category,
        ...(toChange.sourceNote ? { sourceNote: toChange.sourceNote } : {}),
      },
    ]);

    fireEvent.click(screen.getByTestId("radio-entity-merge"));
    await selectEntityFile("snapshot.json", snapshot);

    // Preview dialog appears.
    await screen.findByTestId("text-preview-incoming");

    // Two of the three imported addresses overlap the bundled list, but only one
    // of them actually differs. The badge reports the total override count plus
    // the changed suffix.
    const overriddenBadge = screen.getByTestId("badge-preview-overridden");
    expect(overriddenBadge.textContent).toContain("2 override bundled");
    expect(overriddenBadge.textContent).toContain("(1 changed)");

    // The note explains only the changed override will alter an entry and calls
    // out the identical re-import remainder.
    const note = screen.getByTestId("text-merge-override-note");
    const noteText = note.textContent ?? "";
    expect(noteText).toContain("2 imported addresses already exist in the bundled list");
    expect(noteText).toContain("only 1 will actually change");
    expect(noteText).toContain("the other 1 is identical re-imports");
  });

  it("warns about a mismatched source citation but still allows the import", async () => {
    renderSettingsPage();

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

  it("renders each cited mismatch address as a clickable AddressLink (base58 + bech32)", async () => {
    // The warning list renders cited addresses via <AddressLink>, which depends
    // on RecordPreviewProvider (for the click-to-open behaviour). Wrap the page
    // in it so the real link + copy controls mount.
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      renderWithSettingsProviders(<SettingsPage />);

      await screen.findByTestId("badge-entity-source");

      // A single entry whose source note cites two OTHER addresses — one legacy
      // base58 (mixed case, contains chars base58 excludes from bech32) and one
      // bech32 — so both citation alphabets are exercised. AddressLink derives
      // its test ids from the first 8 chars of each cited address.
      const CITED_BASE58 = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
      const CITED_BECH32 = ADDR.b;
      const snapshot = JSON.stringify([
        {
          address: ADDR.a,
          name: "New Exchange",
          category: "exchange",
          sourceNote:
            `https://www.walletexplorer.com/address/${CITED_BASE58} ` +
            `https://www.walletexplorer.com/address/${CITED_BECH32}`,
        },
      ]);
      await selectEntityFile("snapshot.json", snapshot);

      // The warning surfaces both cited addresses as interactive AddressLinks
      // (link button + copy button), not plain text.
      await screen.findByTestId("container-entity-import-warnings");

      const base58Link = await screen.findByTestId(
        `link-address-${CITED_BASE58.slice(0, 8)}`,
      );
      const base58Copy = screen.getByTestId(
        `button-copy-address-${CITED_BASE58.slice(0, 8)}`,
      );
      const bech32Link = screen.getByTestId(
        `link-address-${CITED_BECH32.slice(0, 8)}`,
      );
      const bech32Copy = screen.getByTestId(
        `button-copy-address-${CITED_BECH32.slice(0, 8)}`,
      );
      expect(base58Link).toBeTruthy();
      expect(bech32Link).toBeTruthy();

      // The copy controls copy the FULL cited address, proving these are real
      // AddressLink controls wired to the clipboard rather than truncated labels.
      fireEvent.click(base58Copy);
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(CITED_BASE58));
      fireEvent.click(bech32Copy);
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(CITED_BECH32));

      // The link itself is clickable (navigates to the record preview); with no
      // matching record it resolves without throwing.
      fireEvent.click(base58Link);
      fireEvent.click(bech32Link);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("surfaces per-entry errors for an invalid snapshot and applies nothing", async () => {
    renderSettingsPage();
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

  it("copies a group's entry numbers and reasons as plain text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      renderSettingsPage();
      await screen.findByTestId("badge-entity-source");

      // Three entries that all fail the same way (invalid address) so they fall
      // into a single group, which opens by default.
      const badSnapshot = JSON.stringify([
        { address: "bad-0", name: "A", category: "exchange" },
        { address: "bad-1", name: "B", category: "exchange" },
        { address: "bad-2", name: "C", category: "exchange" },
      ]);
      await selectEntityFile("bad.json", badSnapshot);
      await screen.findByTestId("container-entity-errors");

      // Copy just the entry numbers (1-based positions, newline separated).
      fireEvent.click(screen.getByTestId("button-copy-entity-error-numbers-invalid-address"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(writeText).toHaveBeenLastCalledWith("Entry 1\nEntry 2\nEntry 3");

      // Copy the entries with their reasons.
      fireEvent.click(screen.getByTestId("button-copy-entity-error-details-invalid-address"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      const detailText = writeText.mock.calls[1][0] as string;
      const lines = detailText.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("Entry 1:");
      expect(lines[0]).toContain("bad-0");
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("fires a success toast when an entity-error copy succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      renderSettingsPage();
      await screen.findByTestId("badge-entity-source");

      const badSnapshot = JSON.stringify([
        { address: "bad-0", name: "A", category: "exchange" },
      ]);
      await selectEntityFile("bad.json", badSnapshot);
      await screen.findByTestId("container-entity-errors");

      // Importing the bad snapshot itself raises a validation toast; clear it so
      // the assertions only see the copy button's own toast.
      toastMock.mockClear();
      fireEvent.click(screen.getByTestId("button-copy-entity-error-numbers-invalid-address"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      // The clipboard write must be paired with the success toast.
      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Copied to clipboard" }),
        ),
      );
      expect(toastMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      );
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("fires a destructive 'Copy failed' toast when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    // copyTextToClipboard falls back to document.execCommand("copy") when
    // writeText rejects; force that to fail too so the handler reports failure.
    const originalExec = document.execCommand;
    document.execCommand = vi.fn().mockReturnValue(false);

    try {
      renderSettingsPage();
      await screen.findByTestId("badge-entity-source");

      const badSnapshot = JSON.stringify([
        { address: "bad-0", name: "A", category: "exchange" },
      ]);
      await selectEntityFile("bad.json", badSnapshot);
      await screen.findByTestId("container-entity-errors");

      // Importing the bad snapshot itself raises a validation toast; clear it so
      // the assertions only see the copy button's own toast.
      toastMock.mockClear();
      fireEvent.click(screen.getByTestId("button-copy-entity-error-numbers-invalid-address"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Copy failed",
            variant: "destructive",
          }),
        ),
      );
      expect(toastMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Copied to clipboard" }),
      );
    } finally {
      document.execCommand = originalExec;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("copies every entry number in a large virtual-scrolled group, not just rendered rows", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      renderSettingsPage();
      await screen.findByTestId("badge-entity-source");

      const ERROR_COUNT = 250;
      const badEntries = Array.from({ length: ERROR_COUNT }, (_, i) => ({
        address: `bad-${i}`,
        name: `Bad ${i}`,
        category: "exchange",
      }));
      await selectEntityFile("many-bad.json", JSON.stringify(badEntries));
      await screen.findByTestId("container-entity-errors");

      // Only a window of rows is mounted (virtualized), but copy must cover all.
      const mountedRows = screen.getAllByTestId(/^text-entity-error-\d+$/);
      expect(mountedRows.length).toBeLessThan(ERROR_COUNT);

      fireEvent.click(screen.getByTestId("button-copy-entity-error-numbers-invalid-address"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copied = writeText.mock.calls[0][0] as string;
      expect(copied.split("\n")).toHaveLength(ERROR_COUNT);
      expect(copied.startsWith("Entry 1\n")).toBe(true);
      expect(copied.endsWith(`Entry ${ERROR_COUNT}`)).toBe(true);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("stays responsive with hundreds of errors: virtualizes the list and applies nothing", async () => {
    renderSettingsPage();
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
    renderSettingsPage();
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

  it("keeps one huge collapsed group virtualized while small groups stay closed", async () => {
    renderWithSettingsProviders(<SettingsPage />);
    await screen.findByTestId("badge-entity-source");

    // The realistic "messy paste": one problem type dominates with hundreds of
    // occurrences while a couple of others have a handful. Because there are
    // multiple groups, none auto-expands — the big group starts collapsed and
    // only virtualizes its window after the user opens it.
    //   - invalid-address  × 150 (bad address, valid name + category)
    //   - unknown-category × 3   (valid address + name, bogus category)
    //   - missing-name     × 1   (valid address + category, empty name)
    // Reusing valid addresses across the unknown-category / missing-name entries
    // is safe: only fully-valid entries are recorded for duplicate detection, so
    // these never collapse into spurious duplicate-address errors.
    const BIG_COUNT = 150;
    const bigKind = Array.from({ length: BIG_COUNT }, (_, i) => ({
      address: `totally-invalid-${i}`,
      name: `Bad Addr ${i}`,
      category: "exchange",
    }));
    const mixed = JSON.stringify([
      ...bigKind,
      { address: ADDR.a, name: "Bogus One", category: "not-a-category" },
      { address: ADDR.b, name: "Bogus Two", category: "definitely-wrong" },
      { address: ADDR.a, name: "Bogus Three", category: "nope" },
      { address: ADDR.b, name: "", category: "exchange" },
    ]);
    await selectEntityFile("messy-paste.json", mixed);

    // The container reports the full, uncapped total (150 + 3 + 1 = 154).
    const TOTAL = BIG_COUNT + 4;
    const container = await screen.findByTestId("container-entity-errors");
    expect(container.textContent).toContain(`${TOTAL.toLocaleString()} problem`);

    // All three problem-type groups are present, most-common first.
    const order = screen
      .getAllByTestId(/^group-entity-error-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "group-entity-error-invalid-address",
      "group-entity-error-unknown-category",
      "group-entity-error-missing-name",
    ]);

    // The big group's count badge shows the full count, not a virtualization cap.
    expect(
      screen.getByTestId("badge-entity-error-count-invalid-address").textContent,
    ).toBe(BIG_COUNT.toLocaleString());
    expect(
      screen.getByTestId("badge-entity-error-count-unknown-category").textContent,
    ).toBe("3");
    expect(
      screen.getByTestId("badge-entity-error-count-missing-name").textContent,
    ).toBe("1");

    // With multiple groups every group starts collapsed: no offending rows are
    // mounted, and each heading reports aria-expanded="false".
    expect(screen.queryByTestId("text-entity-error-0")).toBeNull();
    expect(
      screen
        .getByTestId("button-entity-error-group-invalid-address")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("button-entity-error-group-missing-name")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // Expand only the big group. It exceeds the virtualization threshold, so it
    // renders just a window of rows: the first rows mount, far rows do not, and
    // the mounted count is far below the full total.
    fireEvent.click(
      screen.getByTestId("button-entity-error-group-invalid-address"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("text-entity-error-0")).toBeTruthy(),
    );
    expect(screen.getByTestId("text-entity-error-1")).toBeTruthy();
    expect(screen.queryByTestId(`text-entity-error-${BIG_COUNT - 1}`)).toBeNull();
    const mountedRows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(BIG_COUNT);

    // The revealed rows are the invalid-address failures, not another kind.
    expect(container.textContent).toContain('Invalid Bitcoin address "totally-invalid-0"');

    // The small groups stay collapsed even after opening the big one.
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("button-entity-error-group-missing-name")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // Nothing was applied — still on the bundled list, no persisted snapshot.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("auto-expands the only group when every error is the same kind", async () => {
    renderSettingsPage();
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
    renderSettingsPage();
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

  it("filtering jumps straight to a buried entry: entry # and reason text open the right group (even the big virtualized one) and hide the rest", async () => {
    renderSettingsPage();
    await screen.findByTestId("badge-entity-source");

    // A realistic "messy paste": one problem type dominates with 150 bad
    // addresses (well over the 100-entry virtualization threshold) plus a couple
    // of small groups. Reusing the valid ADDR.a/ADDR.b across the small entries
    // is safe — only fully-valid entries are recorded for duplicate detection,
    // so the invalid-category / missing-name entries never collapse into spurious
    // duplicate-address errors.
    //   - invalid-address  × 150 (indices 0..149  -> entries 1..150)
    //   - unknown-category × 3   (indices 150..152)
    //   - missing-name     × 1   (index 153)
    const BIG_COUNT = 150;
    const bigKind = Array.from({ length: BIG_COUNT }, (_, i) => ({
      address: `totally-invalid-${i}`,
      name: `Bad Addr ${i}`,
      category: "exchange",
    }));
    const mixed = JSON.stringify([
      ...bigKind,
      { address: ADDR.a, name: "Bogus One", category: "not-a-category" },
      { address: ADDR.b, name: "Bogus Two", category: "definitely-wrong" },
      { address: ADDR.a, name: "Bogus Three", category: "nope" },
      { address: ADDR.b, name: "", category: "exchange" },
    ]);
    await selectEntityFile("messy-paste.json", mixed);

    await screen.findByTestId("container-entity-errors");

    // Multiple groups => every group starts collapsed; no offending rows mount
    // and no match-count line is shown until the user filters.
    expect(screen.queryByTestId("text-entity-error-0")).toBeNull();
    expect(screen.queryByTestId("text-entity-error-match-count")).toBeNull();

    // --- Entry-number jump deep into the large virtualized group ---
    // Entry 75 -> index 74 -> address "totally-invalid-74", buried mid-way
    // through the 150-entry group, far outside any virtual window.
    setErrorFilter("75");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    // The invalid-address group auto-opened and shows exactly the one match.
    let rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Entry 75");
    expect(rows[0].textContent).toContain('Invalid Bitcoin address "totally-invalid-74"');
    // Non-matching groups are gone entirely (filtered out, not just collapsed).
    expect(screen.getByTestId("group-entity-error-invalid-address")).toBeTruthy();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // --- Reason-text fragment that lands on the LAST entry of the big group ---
    // (index 149 -> entry 150) — a row that would normally be off-screen, proving
    // filtering surfaces a match anywhere inside the virtualized group.
    setErrorFilter("totally-invalid-149");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Entry 150");
    expect(rows[0].textContent).toContain('Invalid Bitcoin address "totally-invalid-149"');
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // --- Reason fragment that picks out a single buried small-group entry ---
    setErrorFilter("not-a-category");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Unknown category "not-a-category"');
    expect(screen.getByTestId("group-entity-error-unknown-category")).toBeTruthy();
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // --- "Problem type" dropdown narrows to one group (text filter cleared) ---
    setErrorFilter("");
    setErrorKind("missing-name");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    expect(screen.getByTestId("group-entity-error-missing-name")).toBeTruthy();
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Missing "name"');

    // Selecting the big problem type narrows to it and KEEPS it virtualized
    // (150 matches > threshold), so only a window of rows mounts.
    setErrorKind("invalid-address");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("150 matching entries."),
    );
    expect(screen.getByTestId("group-entity-error-invalid-address")).toBeTruthy();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();
    const windowRows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(windowRows.length).toBeGreaterThan(0);
    expect(windowRows.length).toBeLessThan(BIG_COUNT);

    // Throughout all this triage, nothing was applied — still on the bundled
    // list with no persisted snapshot, and no preview dialog ever opened.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("a filter that matches nothing says so plainly: 'No matching entries.', zero rows, no open group, nothing applied", async () => {
    renderSettingsPage();
    await screen.findByTestId("badge-entity-source");

    // A small mixed snapshot so there are multiple problem-type groups (each
    // starts collapsed) to filter against.
    //   - invalid-address  × 2 (entries 1, 2)
    //   - unknown-category × 1 (entry 3)
    //   - missing-name     × 1 (entry 4)
    const mixed = JSON.stringify([
      { address: "totally-invalid-a", name: "Bad One", category: "exchange" },
      { address: "totally-invalid-b", name: "Bad Two", category: "exchange" },
      { address: ADDR.a, name: "Bogus", category: "not-a-category" },
      { address: ADDR.b, name: "", category: "exchange" },
    ]);
    await selectEntityFile("messy-paste.json", mixed);

    await screen.findByTestId("container-entity-errors");

    // Multiple groups => all collapsed, no rows mounted, no match-count line yet.
    expect(screen.queryByTestId("text-entity-error-0")).toBeNull();
    expect(screen.queryByTestId("text-entity-error-match-count")).toBeNull();

    // --- Entry number nobody has => empty result ---
    setErrorFilter("999");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("No matching entries."),
    );
    // No offending row is mounted and every group is filtered away (not just
    // collapsed) — so nothing looks expanded.
    expect(screen.queryByTestId(/^text-entity-error-\d+$/)).toBeNull();
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // --- Reason text nobody matches => still empty ---
    setErrorFilter("zzz-no-such-reason");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("No matching entries."),
    );
    expect(screen.queryByTestId(/^text-entity-error-\d+$/)).toBeNull();

    // --- A "problem type" that can't satisfy the non-matching text filter ---
    // The text filter still rules everything out even once a kind is chosen.
    setErrorKind("invalid-address");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("No matching entries."),
    );
    expect(screen.queryByTestId(/^text-entity-error-\d+$/)).toBeNull();
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // Filtering is pure triage — nothing was ever applied: no preview dialog
    // opened, still on the bundled list, and no snapshot was persisted.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("clearing the filter brings every problem back: the match-count line disappears and all groups reappear collapsed, nothing applied", async () => {
    renderSettingsPage();
    await screen.findByTestId("badge-entity-source");

    // A small mixed snapshot so there are multiple problem-type groups (each
    // starts collapsed) to filter and then un-filter:
    //   - invalid-address  × 2 (entries 1, 2)
    //   - unknown-category × 1 (entry 3)
    //   - missing-name     × 1 (entry 4)
    const mixed = JSON.stringify([
      { address: "totally-invalid-a", name: "Bad One", category: "exchange" },
      { address: "totally-invalid-b", name: "Bad Two", category: "exchange" },
      { address: ADDR.a, name: "Bogus", category: "not-a-category" },
      { address: ADDR.b, name: "", category: "exchange" },
    ]);
    await selectEntityFile("messy-paste.json", mixed);

    await screen.findByTestId("container-entity-errors");

    // Baseline (unfiltered): all three groups present and collapsed, no rows
    // mounted, no match-count line.
    expect(screen.getByTestId("group-entity-error-invalid-address")).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-unknown-category")).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-missing-name")).toBeTruthy();
    expect(screen.queryByTestId(/^text-entity-error-\d+$/)).toBeNull();
    expect(screen.queryByTestId("text-entity-error-match-count")).toBeNull();

    // Drive the panel into the worst-case "looks like the import vanished" state:
    // a reason fragment nobody matches AND a chosen problem type, which collapses
    // everything to the "No matching entries." line with every group filtered out
    // of the DOM. This is exactly the state a user would clear their filter to
    // escape.
    setErrorFilter("zzz-no-such-reason");
    setErrorKind("invalid-address");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("No matching entries."),
    );
    expect(screen.queryByTestId(/^text-entity-error-\d+$/)).toBeNull();
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // --- Reset the "problem type" dropdown back to "All problem types" while the
    // non-matching text filter is still active. A filter is still active (the
    // text), so the match-count line stays and nothing is shown yet. ---
    setErrorKind("all");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("No matching entries."),
    );
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // --- Clear the text filter too: filterActive flips to false, completing the
    // round-trip back to the fully unfiltered view. ---
    setErrorFilter("");

    // The match-count line disappears entirely once no filter is active — it must
    // not linger with a stale count (the regression this guards against).
    await waitFor(() =>
      expect(screen.queryByTestId("text-entity-error-match-count")).toBeNull(),
    );

    // Every problem-type group reappears — the import was never lost.
    expect(screen.getByTestId("group-entity-error-invalid-address")).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-unknown-category")).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-missing-name")).toBeTruthy();

    // ...and all groups are collapsed again, exactly like the baseline: no
    // offending rows are auto-mounted and each heading reports
    // aria-expanded="false".
    expect(screen.queryByTestId(/^text-entity-error-\d+$/)).toBeNull();
    expect(
      screen
        .getByTestId("button-entity-error-group-invalid-address")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("button-entity-error-group-missing-name")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // Triage only — nothing was ever applied: no preview dialog opened, still on
    // the bundled list, and no snapshot was persisted.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("a subset filter that auto-expands one group re-collapses it once the filter is cleared, matching the baseline", async () => {
    renderSettingsPage();
    await screen.findByTestId("badge-entity-source");

    // A mixed snapshot so the matching group has MORE than one entry (the subset
    // case): the filter will surface only one of the two invalid-address entries
    // while leaving the other groups out of the DOM entirely.
    //   - invalid-address  × 2 (entries 1, 2)
    //   - unknown-category × 1 (entry 3)
    //   - missing-name     × 1 (entry 4)
    const mixed = JSON.stringify([
      { address: "totally-invalid-a", name: "Bad One", category: "exchange" },
      { address: "totally-invalid-b", name: "Bad Two", category: "exchange" },
      { address: ADDR.a, name: "Bogus", category: "not-a-category" },
      { address: ADDR.b, name: "", category: "exchange" },
    ]);
    await selectEntityFile("messy-paste.json", mixed);

    await screen.findByTestId("container-entity-errors");

    // Baseline: all groups present and collapsed, no rows mounted.
    expect(
      screen
        .getByTestId("button-entity-error-group-invalid-address")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByTestId(/^text-entity-error-\d+$/)).toBeNull();

    // Filter to a MATCHING SUBSET: "totally-invalid-a" hits only entry 1's
    // message, so the invalid-address group stays mounted and auto-expands while
    // the other groups drop out of the DOM. This is the gap Task #757 left open
    // (it only covered a filter that matched nothing).
    setErrorFilter("totally-invalid-a");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    expect(
      screen
        .getByTestId("button-entity-error-group-invalid-address")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    let rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Invalid Bitcoin address "totally-invalid-a"');
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // Clear the filter: filterActive flips false, so the auto-open intent clears
    // and the previously-expanded (and still-mounted) invalid-address group must
    // collapse back to the baseline rather than staying stuck open.
    setErrorFilter("");
    await waitFor(() =>
      expect(screen.queryByTestId("text-entity-error-match-count")).toBeNull(),
    );

    // The matching group is collapsed again with no offending rows mounted, and
    // matches the rest of the (always-collapsed) baseline groups.
    await waitFor(() =>
      expect(
        screen
          .getByTestId("button-entity-error-group-invalid-address")
          .getAttribute("aria-expanded"),
      ).toBe("false"),
    );
    expect(screen.queryByTestId(/^text-entity-error-\d+$/)).toBeNull();
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("button-entity-error-group-missing-name")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // Triage only — nothing was applied.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("remembers a manually-expanded group across a filter round-trip while an only-auto-expanded group still re-collapses", async () => {
    renderSettingsPage();
    await screen.findByTestId("badge-entity-source");

    // Two distinct groups so we can drive them independently:
    //   - invalid-address  × 1 (entry 1)  → the user will MANUALLY expand this
    //   - unknown-category × 1 (entry 2)  → only ever auto-expanded by a filter
    const mixed = JSON.stringify([
      { address: "totally-invalid-a", name: "Bad One", category: "exchange" },
      { address: ADDR.a, name: "Bogus", category: "not-a-category" },
    ]);
    await selectEntityFile("messy-paste.json", mixed);

    await screen.findByTestId("container-entity-errors");

    // Baseline: both groups present and collapsed.
    expect(
      screen
        .getByTestId("button-entity-error-group-invalid-address")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // The user MANUALLY expands the invalid-address group (a deliberate choice,
    // not driven by any filter). The unknown-category group is left untouched.
    fireEvent.click(
      screen.getByTestId("button-entity-error-group-invalid-address"),
    );
    expect(
      screen
        .getByTestId("button-entity-error-group-invalid-address")
        .getAttribute("aria-expanded"),
    ).toBe("true");

    // Apply a filter that surfaces only the unknown-category entry. This forces
    // the auto-open intent on, so the (still-mounted) unknown-category group
    // auto-expands while the invalid-address group drops out of the DOM.
    setErrorFilter("not-a-category");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();

    // Clear the filter: the auto-open intent clears, completing the round-trip.
    setErrorFilter("");
    await waitFor(() =>
      expect(screen.queryByTestId("text-entity-error-match-count")).toBeNull(),
    );

    // The manually-expanded group survives the round-trip — it is still open.
    await waitFor(() =>
      expect(
        screen
          .getByTestId("button-entity-error-group-invalid-address")
          .getAttribute("aria-expanded"),
      ).toBe("true"),
    );
    // The group that was only ever auto-expanded by the filter re-collapses to
    // the baseline (Task #822 behavior preserved).
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // Triage only — nothing was applied.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("remembers a manually-expanded group after the panel unmounts and remounts (same import session), and a brand-new import starts collapsed", async () => {
    // Two distinct groups so the baseline is collapsed (nothing auto-opens):
    //   - invalid-address  × 1 (entry 1)  → the user MANUALLY expands this
    //   - unknown-category × 1 (entry 2)  → left collapsed
    const mixed = JSON.stringify([
      { address: "totally-invalid-a", name: "Bad One", category: "exchange" },
      { address: ADDR.a, name: "Bogus", category: "not-a-category" },
    ]);

    // --- First visit: import, manually expand one group. ---
    const first = renderSettingsPage();
    await first.findByTestId("badge-entity-source");
    await selectEntityFile("messy-paste.json", mixed);
    await screen.findByTestId("container-entity-errors");

    // Baseline: both groups collapsed.
    expect(
      screen
        .getByTestId("button-entity-error-group-invalid-address")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // The user manually expands the invalid-address group.
    fireEvent.click(
      screen.getByTestId("button-entity-error-group-invalid-address"),
    );
    expect(
      screen
        .getByTestId("button-entity-error-group-invalid-address")
        .getAttribute("aria-expanded"),
    ).toBe("true");

    // --- Leave Settings entirely: unmount the whole page (and the panel). ---
    first.unmount();
    expect(screen.queryByTestId("list-entity-errors")).toBeNull();

    // --- Return to Settings and re-import the SAME file (same session). The
    // manually-expanded group must come back already open, while the untouched
    // group stays collapsed. ---
    const second = renderSettingsPage();
    await second.findByTestId("badge-entity-source");
    await selectEntityFile("messy-paste.json", mixed);
    await screen.findByTestId("container-entity-errors");

    await waitFor(() =>
      expect(
        screen
          .getByTestId("button-entity-error-group-invalid-address")
          .getAttribute("aria-expanded"),
      ).toBe("true"),
    );
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // --- A brand-new (different) import starts from the clean collapsed
    // baseline rather than inheriting the prior import's triage state. ---
    const fresh = JSON.stringify([
      { address: "different-bad-x", name: "Other One", category: "exchange" },
      { address: ADDR.b, name: "Other Two", category: "still-not-a-category" },
    ]);
    await selectEntityFile("other-paste.json", fresh);
    await screen.findByTestId("container-entity-errors");

    await waitFor(() =>
      expect(
        screen
          .getByTestId("button-entity-error-group-invalid-address")
          .getAttribute("aria-expanded"),
      ).toBe("false"),
    );
    expect(
      screen
        .getByTestId("button-entity-error-group-unknown-category")
        .getAttribute("aria-expanded"),
    ).toBe("false");

    // Triage only — nothing was applied.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("combines the reason filter and problem-type dropdown with AND: only entries matching both survive, and a fragment from another kind drops the count to zero", async () => {
    renderSettingsPage();
    await screen.findByTestId("badge-entity-source");

    // A snapshot where the token "alpha" appears in error messages of TWO
    // different kinds, so neither control alone equals their intersection:
    //   invalid-address × 3  -> messages embed the bad address
    //     "bad-alpha-1", "bad-alpha-2" (contain "alpha")
    //     "bad-beta-1"                 (no "alpha")
    //   unknown-category × 2  -> messages embed the bogus category
    //     "alpha-cat" (contains "alpha"), "gamma-cat" (no "alpha")
    // Reusing ADDR.a/ADDR.b across the unknown-category entries is safe: only
    // fully-valid entries are recorded for duplicate detection, so a bad
    // category never collapses into a spurious duplicate-address error. None of
    // the valid category names embedded in the unknown-category message contain
    // "alpha"/"beta"/"gamma", so those fragments only match where intended.
    const mixed = JSON.stringify([
      { address: "bad-alpha-1", name: "Bad Alpha One", category: "exchange" },
      { address: "bad-alpha-2", name: "Bad Alpha Two", category: "exchange" },
      { address: "bad-beta-1", name: "Bad Beta One", category: "exchange" },
      { address: ADDR.a, name: "Cat One", category: "alpha-cat" },
      { address: ADDR.b, name: "Cat Two", category: "gamma-cat" },
    ]);
    await selectEntityFile("combined.json", mixed);

    const container = await screen.findByTestId("container-entity-errors");
    expect(container.textContent).toContain("5 problems");

    // --- Text "alpha" alone spans BOTH kinds (3: two invalid-address + one
    // unknown-category). ---
    setErrorFilter("alpha");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("3 matching entries."),
    );
    expect(screen.getByTestId("group-entity-error-invalid-address")).toBeTruthy();
    expect(screen.getByTestId("group-entity-error-unknown-category")).toBeTruthy();

    // --- Kind "invalid-address" alone matches all 3 invalid addresses. ---
    setErrorFilter("");
    setErrorKind("invalid-address");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("3 matching entries."),
    );

    // --- Combined (AND): kind invalid-address + text "alpha" surfaces ONLY the
    // intersection (2), which is fewer than either control alone (3 and 3). ---
    setErrorFilter("alpha");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("2 matching entries."),
    );
    // The unknown-category "alpha-cat" entry is excluded by the kind filter even
    // though its message contains "alpha".
    expect(screen.getByTestId("group-entity-error-invalid-address")).toBeTruthy();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    const rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row.textContent).toContain("alpha");
      expect(row.textContent).toContain("Invalid Bitcoin address");
    });

    // --- A fragment that exists ONLY in a different kind drops the combined
    // count to zero while invalid-address stays selected. ---
    setErrorFilter("gamma");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("No matching entries."),
    );
    expect(screen.queryAllByTestId(/^text-entity-error-\d+$/)).toHaveLength(0);
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();

    // Proof the "gamma" fragment really does exist (in unknown-category): clear
    // the kind back to "all" and it surfaces the one unknown-category match —
    // so it was the AND, not a missing token, that zeroed the count above.
    setErrorKind("all");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    expect(screen.getByTestId("group-entity-error-unknown-category")).toBeTruthy();
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();

    // Throughout the triage nothing was applied — no preview dialog, still on
    // the bundled list, and no persisted snapshot.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
  });

  it("a numeric 'jump to entry #N' still obeys the problem-type dropdown: the same entry # is hidden under the wrong kind and surfaces only under its own kind", async () => {
    renderSettingsPage();
    await screen.findByTestId("badge-entity-source");

    // A mixed snapshot where each kind owns a distinct slice of the GLOBAL,
    // 1-based entry numbering (entry # = array index + 1), so a given entry
    // number lives in exactly one problem-type group:
    //   invalid-address  × 3  -> indices 0,1,2 -> entries 1,2,3
    //   unknown-category × 2  -> indices 3,4   -> entries 4,5
    //   missing-name     × 1  -> index   5     -> entry   6
    // Reusing ADDR.a across the unknown-category (index 3) and missing-name
    // (index 5) entries is safe: neither is fully valid, so neither is recorded
    // for duplicate detection and ADDR.a never collapses into a spurious
    // duplicate-address error.
    const mixed = JSON.stringify([
      { address: "totally-invalid-1", name: "Bad One", category: "exchange" },
      { address: "totally-invalid-2", name: "Bad Two", category: "exchange" },
      { address: "totally-invalid-3", name: "Bad Three", category: "exchange" },
      { address: ADDR.a, name: "Cat One", category: "first-bad-cat" },
      { address: ADDR.b, name: "Cat Two", category: "second-bad-cat" },
      { address: ADDR.a, name: "", category: "exchange" },
    ]);
    await selectEntityFile("numeric-jump.json", mixed);

    const container = await screen.findByTestId("container-entity-errors");
    expect(container.textContent).toContain("6 problems");

    // Entry 5 -> index 4 -> the unknown-category "second-bad-cat" row. Picking
    // a DIFFERENT kind (invalid-address, which owns only entries 1–3) must make
    // the numeric jump fall inside the kind filter, not bypass it: zero matches.
    setErrorFilter("5");
    setErrorKind("invalid-address");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("No matching entries."),
    );
    expect(screen.queryAllByTestId(/^text-entity-error-\d+$/)).toHaveLength(0);
    // The invalid-address group is filtered away entirely (entry 5 isn't in it),
    // not merely collapsed — proving the entry-number jump didn't leak a row
    // from the wrong group.
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-unknown-category")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // Now select the kind that actually contains entry 5: exactly that one row
    // surfaces, with the matching entry # and reason text.
    setErrorKind("unknown-category");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    let rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Entry 5");
    expect(rows[0].textContent).toContain('Unknown category "second-bad-cat"');
    expect(screen.getByTestId("group-entity-error-unknown-category")).toBeTruthy();
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();
    expect(screen.queryByTestId("group-entity-error-missing-name")).toBeNull();

    // Proof the zero count above was the AND with the wrong kind — not a bogus
    // entry number: with the kind cleared back to "all", entry 5 still resolves
    // to that same single unknown-category row.
    setErrorKind("all");
    await waitFor(() =>
      expect(
        screen.getByTestId("text-entity-error-match-count").textContent,
      ).toBe("1 matching entry."),
    );
    rows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Entry 5");
    expect(rows[0].textContent).toContain('Unknown category "second-bad-cat"');
    expect(screen.getByTestId("group-entity-error-unknown-category")).toBeTruthy();
    expect(screen.queryByTestId("group-entity-error-invalid-address")).toBeNull();

    // Throughout the triage nothing was applied — no preview dialog, still on
    // the bundled list, and no persisted snapshot.
    expect(screen.queryByTestId("text-preview-incoming")).toBeNull();
    expect(getActiveEntitySource()).toBe("bundled");
    expect((await getSettings("default"))?.entityListSnapshot).toBeUndefined();
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
      renderSettingsPage();
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
