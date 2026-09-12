// @vitest-environment jsdom
//
// Component coverage for the *failure* branch of the Privacy Audit "Entity
// List" import dialog's confirm path. The sibling
// SettingsPage.entityListConfirm.test.tsx covers the success case (the active
// list ends up matching the preview). This file covers what happens when
// `applyEntitySnapshot` rejects (e.g. the underlying settings write fails):
// `handleConfirmEntityImport` must surface a destructive "Import failed" toast,
// keep the dialog open with the preview still visible, leave the previously
// active entity list untouched, and reset the applying state so the
// confirm/cancel buttons return to an enabled, non-spinning state.
//
// A regression here could silently swallow the error or wrongly close the
// dialog, leaving the user believing their import applied when it did not.

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

// Capture toasts so we can assert the destructive "Import failed" toast fires.
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

// Make the apply step reject to drive the failure branch, while keeping every
// other entity-list-store export (prepareEntitySnapshot, etc.) real so the
// dialog still reaches a valid preview exactly as in production.
const applyError = new Error("settings write failed");
vi.mock("@/lib/data/entity-list-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/data/entity-list-store")
  >("@/lib/data/entity-list-store");
  return {
    ...actual,
    applyEntitySnapshot: vi.fn().mockRejectedValue(applyError),
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
  resetActiveEntityList,
  getBundledEntityCount,
  getActiveEntityCount,
  getActiveEntitySource,
} = await import("@/lib/privacy-entity-list");
import type { Settings } from "@/lib/db-types";

// Valid mainnet addresses that are NOT in the bundled list, so they count as
// fresh entries in a replace preview.
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
  await putSettings({ id: "default" } as Settings, { skipNotification: true });
  resetActiveEntityList();
  toastSpy.mockClear();
});

afterEach(() => {
  cleanup();
  resetActiveEntityList();
});

describe("SettingsPage — entity list import (confirm failure)", () => {
  it("surfaces a destructive 'Import failed' toast, keeps the dialog open, leaves the active list unchanged, and re-enables the buttons", async () => {
    renderPage();
    await screen.findByTestId("badge-entity-source");

    // Sanity: nothing imported yet — the active list is the bundled fallback.
    const bundledCount = getBundledEntityCount();
    expect(getActiveEntitySource()).toBe("bundled");
    expect(getActiveEntityCount()).toBe(bundledCount);

    // Replace mode (default): the incoming snapshot becomes the whole list, so
    // a successful apply would replace it. We force apply to reject instead.
    const snapshot = [
      { address: NEW_ADDR.a, name: "Only Mixer", category: "mixer" },
      { address: NEW_ADDR.b, name: "Only Exchange", category: "exchange" },
    ];

    selectEntityFile("replace.json", JSON.stringify(snapshot));

    // Drive the dialog to a valid preview before confirming.
    await waitFor(() =>
      expect(screen.getByTestId("text-preview-incoming").textContent).toBe(
        snapshot.length.toLocaleString(),
      ),
    );

    fireEvent.click(screen.getByTestId("button-confirm-entity-import"));

    // The destructive "Import failed" toast is surfaced with the rejection
    // message (and never an "updated" success toast).
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Import failed",
          variant: "destructive",
        }),
      ),
    );
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Entity list updated" }),
    );

    // The dialog stays OPEN — the preview is still visible.
    expect(screen.getByTestId("text-preview-incoming")).not.toBeNull();

    // The previously active entity list is untouched (still the bundled list).
    expect(getActiveEntitySource()).toBe("bundled");
    expect(getActiveEntityCount()).toBe(bundledCount);

    // The confirm/cancel buttons return to an enabled, non-spinning state once
    // isApplyingEntities resets in the finally block.
    await waitFor(() => {
      expect(
        (screen.getByTestId("button-confirm-entity-import") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(
      (screen.getByTestId("button-cancel-entity-import") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    // No spinner remains in the confirm button.
    expect(
      screen
        .getByTestId("button-confirm-entity-import")
        .querySelector(".animate-spin"),
    ).toBeNull();
  });
});
