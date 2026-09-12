// @vitest-environment jsdom
//
// Component coverage for the *failure* branch of the Privacy Audit "Entity
// List" panel's "Revert to bundled" action. The sibling
// SettingsPage.entityListConfirmFailure.test.tsx covers the import-confirm
// failure path; this file covers what happens when `resetEntitySnapshot`
// rejects (e.g. the underlying settings write fails): `handleResetEntities`
// must surface a destructive error toast, leave the previously active
// (imported) entity list untouched, and reset the resetting state so the
// "Revert to bundled" button returns to an enabled, non-spinning state.
//
// A regression here could silently swallow the error, leaving the user
// believing the list reverted to the bundled default when it did not.

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

// Capture toasts so we can assert the destructive error toast fires.
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

// Drive the failure branch by forcing the *real* settings write to reject,
// keeping `resetEntitySnapshot` (and the rest of entity-list-store) entirely
// real. This exercises the genuine production path: `resetEntitySnapshot`
// awaits `updateSettings` before touching the in-memory active list, so a write
// failure must leave the active (imported) list untouched. `getSettings` and
// `putSettings` stay real so the settings live-query and test seeding still
// work. The whole-module mock is shared by both entity-list-store (its
// `updateSettings` import) and use-settings (its `getSettings` live query).
const writeError = new Error("settings write failed");
vi.mock("@/lib/data/settings-crud", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/data/settings-crud")
  >("@/lib/data/settings-crud");
  return {
    ...actual,
    updateSettings: vi.fn().mockRejectedValue(writeError),
  };
});

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
const {
  setActiveEntityList,
  resetActiveEntityList,
  getActiveEntityCount,
  getActiveEntitySource,
} = await import("@/lib/privacy-entity-list");
import type { EntityEntry } from "@/lib/privacy-entity-list";
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses for a small imported snapshot (not the bundled list).
const IMPORTED_ENTRIES: EntityEntry[] = [
  {
    address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    name: "Only Mixer",
    category: "mixer",
  },
  {
    address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    name: "Only Exchange",
    category: "exchange",
  },
];

function renderPage() {
  renderWithSettingsProviders(<SettingsPage />);
}

beforeEach(async () => {
  // Persist a snapshot so the "Revert to bundled" button renders (it is gated
  // on settings.entityListSnapshot), and mark the active list as imported so we
  // can assert it stays imported after the failed revert.
  await putSettings(
    {
      id: "default",
      entityListSnapshot: {
        importedAt: Date.now(),
        mode: "replace",
        entries: IMPORTED_ENTRIES,
      },
    } as Settings,
    { skipNotification: true },
  );
  setActiveEntityList(IMPORTED_ENTRIES);
  toastSpy.mockClear();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — entity list revert to bundled (failure)", () => {
  it("surfaces a destructive error toast, leaves the active list unchanged, and re-enables the revert button", async () => {
    renderPage();

    // The revert button only appears when a snapshot is active.
    const revertButton = (await screen.findByTestId(
      "button-reset-entities",
    )) as HTMLButtonElement;

    // Sanity: the active list is the imported snapshot before the attempt.
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityCount()).toBe(IMPORTED_ENTRIES.length);

    fireEvent.click(revertButton);

    // The destructive error toast is surfaced (and never a success "Reverted"
    // toast).
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Error",
          variant: "destructive",
        }),
      ),
    );
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Reverted to bundled list" }),
    );

    // The previously active entity list is untouched (still the imported list).
    expect(getActiveEntitySource()).toBe("imported");
    expect(getActiveEntityCount()).toBe(IMPORTED_ENTRIES.length);

    // The revert button returns to an enabled, non-spinning state once
    // isResettingEntities resets in the finally block.
    await waitFor(() =>
      expect(
        (screen.getByTestId("button-reset-entities") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(
      screen.getByTestId("button-reset-entities").querySelector(".animate-spin"),
    ).toBeNull();
  });
});
