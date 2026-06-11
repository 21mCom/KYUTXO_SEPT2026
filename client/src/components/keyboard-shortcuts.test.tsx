// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { ActivityPulseDot } from "./ActivityPulseDot";
import { ActivityBusProvider } from "@/lib/activity-bus";
import {
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * These tests guard the hand-maintained shortcuts registry (config/shortcuts.ts)
 * against drift: they dispatch the documented key chords as real keydown events
 * and assert the live handlers respond. If a handler is removed or its key chord
 * changes without the registry being updated, the matching test fails.
 */

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

function dispatchKeyDown(
  target: Window | HTMLElement,
  init: KeyboardEventInit,
) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

describe("Shortcut: ? opens the keyboard shortcuts reference", () => {
  it("opens the dialog when ? is pressed", () => {
    render(<KeyboardShortcutsDialog />);
    expect(screen.queryByTestId("dialog-keyboard-shortcuts")).toBeNull();

    dispatchKeyDown(window, { key: "?" });

    expect(screen.getByTestId("dialog-keyboard-shortcuts")).toBeTruthy();
  });

  it("ignores ? while focus is in a text input", () => {
    render(
      <>
        <input data-testid="some-input" />
        <KeyboardShortcutsDialog />
      </>,
    );

    const input = screen.getByTestId("some-input") as HTMLInputElement;
    input.focus();
    dispatchKeyDown(input, { key: "?" });

    expect(screen.queryByTestId("dialog-keyboard-shortcuts")).toBeNull();
  });

  it("ignores ? when a modifier key is held", () => {
    render(<KeyboardShortcutsDialog />);

    dispatchKeyDown(window, { key: "?", ctrlKey: true });
    expect(screen.queryByTestId("dialog-keyboard-shortcuts")).toBeNull();
  });
});

function SidebarStateProbe() {
  const { state } = useSidebar();
  return <div data-testid="sidebar-state">{state}</div>;
}

describe("Shortcut: Cmd/Ctrl+B toggles the sidebar", () => {
  it("toggles the sidebar with Ctrl+B", () => {
    render(
      <SidebarProvider>
        <SidebarStateProbe />
      </SidebarProvider>,
    );

    expect(screen.getByTestId("sidebar-state").textContent).toBe("expanded");

    dispatchKeyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByTestId("sidebar-state").textContent).toBe("collapsed");

    dispatchKeyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByTestId("sidebar-state").textContent).toBe("expanded");
  });

  it("toggles the sidebar with Cmd (meta)+B", () => {
    render(
      <SidebarProvider>
        <SidebarStateProbe />
      </SidebarProvider>,
    );

    expect(screen.getByTestId("sidebar-state").textContent).toBe("expanded");

    dispatchKeyDown(window, { key: "b", metaKey: true });
    expect(screen.getByTestId("sidebar-state").textContent).toBe("collapsed");
  });

  it("does not toggle the sidebar for B without a modifier", () => {
    render(
      <SidebarProvider>
        <SidebarStateProbe />
      </SidebarProvider>,
    );

    dispatchKeyDown(window, { key: "b" });
    expect(screen.getByTestId("sidebar-state").textContent).toBe("expanded");
  });
});

describe("Shortcut: Alt+A toggles the activity monitor", () => {
  it("opens the activity monitor popover on Alt+A", () => {
    render(
      <ActivityBusProvider>
        <ActivityPulseDot />
      </ActivityBusProvider>,
    );

    expect(screen.queryByTestId("popover-activity-monitor")).toBeNull();

    dispatchKeyDown(window, { key: "a", altKey: true });
    expect(screen.getByTestId("popover-activity-monitor")).toBeTruthy();

    dispatchKeyDown(window, { key: "a", altKey: true });
    expect(screen.queryByTestId("popover-activity-monitor")).toBeNull();
  });

  it("does not open the activity monitor for A without Alt", () => {
    render(
      <ActivityBusProvider>
        <ActivityPulseDot />
      </ActivityBusProvider>,
    );

    dispatchKeyDown(window, { key: "a" });
    expect(screen.queryByTestId("popover-activity-monitor")).toBeNull();
  });
});
