// @vitest-environment jsdom
//
// Component coverage for the "Download entries (JSON)" recovery action on each
// Privacy Audit entity-list import-error group (Task #644 added it; this file
// proves it keeps working). The sibling SettingsPage.entityList.test.tsx covers
// the clipboard copy actions, but the *download* path — which writes the raw
// offending entries to a file via downloadBlob — had no automated coverage, so
// a future change could silently break the recovery flow.
//
// These tests drive the real Settings page to a failed import, expand the
// resulting error group, click button-download-entity-error-json-<kind>, and
// assert against the Blob handed to URL.createObjectURL that:
//   - the downloaded contents parse to a JSON array equal to the group's
//     rawEntry values (exactly the offending entries from the input file),
//   - the filename embeds the error kind so downloading several groups never
//     collides, and
//   - the button is hidden for a group whose errors carry no rawEntry.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// @tanstack/react-virtual needs ResizeObserver and real element dimensions to
// emit virtual rows. jsdom provides neither, so without these shims a
// virtualized error list would render zero rows. The large-group download test
// below crosses the virtualization threshold and relies on these to produce a
// real overscan window; the smaller tests stay below it but the Settings page
// still mounts layout-observing components, so the shims keep them from throwing.
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
const { putSettings } = await import("@/lib/data/settings-crud");
const { resetActiveEntityList } = await import("@/lib/privacy-entity-list");
import type { Settings } from "@/lib/db-types";

// A valid mainnet address so the offending entries fail ONLY on their category,
// landing them all in a single "unknown-category" group (which auto-opens).
const VALID_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

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

// Capture the Blob/filename handed to downloadBlob by spying on the browser
// primitives it uses (URL.createObjectURL + a triggered <a download>), mirroring
// privacy-report-export-text.test.ts. jsdom anchors don't navigate on click, but
// stub click anyway so the download trigger never throws.
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let createdAnchor: HTMLAnchorElement | null;
const FAKE_URL = "blob:fake-object-url";
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const originalCreateElement = document.createElement.bind(document);

beforeEach(async () => {
  // The real app always has a 'default' settings row; seed one so the panel
  // mounts cleanly. A put replaces the whole row, clearing any prior snapshot.
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();

  createObjectURL = vi.fn().mockReturnValue(FAKE_URL);
  revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

  createdAnchor = null;
  vi.spyOn(document, "createElement").mockImplementation(
    (tag: string, opts?: unknown) => {
      const el = originalCreateElement(tag as "a", opts as ElementCreationOptions);
      if (tag === "a") {
        createdAnchor = el as HTMLAnchorElement;
        (el as HTMLAnchorElement).click = vi.fn() as unknown as () => void;
      }
      return el;
    },
  );
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe("SettingsPage — entity-list import error 'Download entries (JSON)'", () => {
  it("downloads a JSON array equal to the group's rawEntry values, with a kind-stamped filename", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Three otherwise-valid entries whose only fault is an unknown category, so
    // they all fall into one "unknown-category" group (which auto-opens as the
    // sole group, surfacing its action bar without an extra expand click).
    const offending = [
      { address: VALID_ADDR, name: "Alpha", category: "not-a-category" },
      { address: VALID_ADDR, name: "Beta", category: "totally-bogus", sourceNote: "ref" },
      { address: VALID_ADDR, name: "Gamma", category: "nope" },
    ];
    selectEntityFile("bad-categories.json", JSON.stringify(offending));

    const downloadBtn = await screen.findByTestId(
      "button-download-entity-error-json-unknown-category",
    );
    fireEvent.click(downloadBtn);

    // downloadBlob handed exactly one Blob to URL.createObjectURL...
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");

    // ...and its contents parse to a JSON array equal to the rawEntry values,
    // i.e. exactly the offending entries from the input file (in order).
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(offending);

    // The filename embeds the error kind so multiple group downloads never
    // overwrite one another.
    expect(createdAnchor).not.toBeNull();
    expect(createdAnchor!.download).toBe(
      "entity-import-errors-unknown-category.json",
    );
    expect(createdAnchor!.getAttribute("href")).toBe(FAKE_URL);
  });

  it("stamps a different filename per error kind so two group downloads don't collide", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Two distinct problem types, each carrying rawEntry: an invalid address and
    // an unknown category. They form two separate groups with their own download
    // buttons and their own kind-stamped filenames.
    const offending = [
      { address: "not-a-valid-address", name: "Alpha", category: "exchange" },
      { address: VALID_ADDR, name: "Beta", category: "made-up" },
    ];
    selectEntityFile("mixed.json", JSON.stringify(offending));

    await screen.findByTestId("container-entity-errors");

    // Each group starts collapsed when there is more than one; expand both so
    // their action bars (and download buttons) render.
    fireEvent.click(
      screen.getByTestId("button-entity-error-group-invalid-address"),
    );
    fireEvent.click(
      screen.getByTestId("button-entity-error-group-unknown-category"),
    );

    fireEvent.click(
      await screen.findByTestId(
        "button-download-entity-error-json-invalid-address",
      ),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(createdAnchor!.download).toBe(
      "entity-import-errors-invalid-address.json",
    );
    const firstBlob = createObjectURL.mock.calls[0][0] as Blob;
    expect(JSON.parse(await firstBlob.text())).toEqual([offending[0]]);

    fireEvent.click(
      screen.getByTestId("button-download-entity-error-json-unknown-category"),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(createdAnchor!.download).toBe(
      "entity-import-errors-unknown-category.json",
    );
    const secondBlob = createObjectURL.mock.calls[1][0] as Blob;
    expect(JSON.parse(await secondBlob.text())).toEqual([offending[1]]);

    // The two downloads used distinct, kind-stamped filenames — no collision.
    expect("entity-import-errors-invalid-address.json").not.toBe(
      "entity-import-errors-unknown-category.json",
    );
  });

  it("downloads every offending entry of a large virtual-scrolled group, not just the mounted window", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Well over ENTITY_ERROR_VIRTUALIZE_THRESHOLD (100) entries that all fail the
    // same way (invalid address) so they land in a single "invalid-address" group
    // that auto-opens (sole group). Each entry-level error carries a rawEntry, so
    // the download button renders and its file should hold every offending entry.
    const ERROR_COUNT = 250;
    const offending = Array.from({ length: ERROR_COUNT }, (_, i) => ({
      address: `not-a-valid-address-${i}`,
      name: `Bad ${i}`,
      category: "exchange",
    }));
    selectEntityFile("many-bad.json", JSON.stringify(offending));

    await screen.findByTestId("container-entity-errors");

    // The list virtualizes: only a window of rows is mounted in the DOM, never
    // all 250. This is exactly the case where a regression could drop the
    // unmounted entries from the downloaded file.
    const mountedRows = screen.getAllByTestId(/^text-entity-error-\d+$/);
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(ERROR_COUNT);

    const downloadBtn = await screen.findByTestId(
      "button-download-entity-error-json-invalid-address",
    );
    fireEvent.click(downloadBtn);

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");

    // The downloaded file holds the FULL error count — every offending entry,
    // including the ones never mounted in the virtualized window — not just the
    // visible rows.
    const parsed = JSON.parse(await blob.text());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(ERROR_COUNT);
    expect(parsed).toEqual(offending);

    expect(createdAnchor!.download).toBe(
      "entity-import-errors-invalid-address.json",
    );
  });

  it("hides the download button for a group whose errors carry no rawEntry", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // An empty array yields a single "no-entries" structural error that is not
    // tied to any input entry, so it carries no rawEntry. The group auto-opens
    // (sole group) yet must NOT offer a JSON download.
    selectEntityFile("empty.json", JSON.stringify([]));

    await screen.findByTestId("group-entity-error-no-entries");

    // Group is open (its copy actions render) but the download button is absent.
    expect(
      screen.getByTestId("button-copy-entity-error-numbers-no-entries"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("button-download-entity-error-json-no-entries"),
    ).toBeNull();
    // The JSON copy button is likewise hidden when nothing carries a rawEntry.
    expect(
      screen.queryByTestId("button-copy-entity-error-json-no-entries"),
    ).toBeNull();

    // Nothing was downloaded.
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
