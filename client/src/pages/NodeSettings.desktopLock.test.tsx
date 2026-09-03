// @vitest-environment jsdom
import "fake-indexeddb/auto";

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;

const updateDesktopLockSettings = vi.hoisted(() => vi.fn(async () => undefined));
const updateNodeSettings = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/data/settings-crud", () => ({
  updateDesktopLockSettings,
}));

vi.mock("@/hooks/use-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-settings")>();
  return {
    ...actual,
    useSettings: () => ({
      desktopLockSettings: {
        idleTimeoutSeconds: 300,
        lockOnSuspend: true,
        lockOnResume: true,
        lockOnScreenLock: true,
      },
    }),
  };
});

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({
    nodeSettings: {
      id: "default",
      providerType: "mempool-space",
      useTor: false,
      requestTimeout: 30000,
      network: "mainnet",
      allowLocalNetwork: false,
      trustedLocalHosts: [],
      useElectrum: false,
    },
    updateSettings: updateNodeSettings,
    resetToDefaults: vi.fn(async () => undefined),
    isLoading: false,
  }),
}));

vi.mock("@/lib/electron", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/electron")>();
  return {
    ...actual,
    isElectron: () => true,
    getElectronAPI: () => ({}),
  };
});

import NodeSettings from "./NodeSettings";
import { renderWithProviders } from "@/test/testProviders";

afterEach(() => {
  cleanup();
  updateDesktopLockSettings.mockClear();
  updateNodeSettings.mockClear();
});

describe("NodeSettings desktop vault lock controls", () => {
  it("shows secure defaults and saves a complete policy after a toggle", async () => {
    renderWithProviders(<NodeSettings />);

    expect(screen.getByTestId("card-desktop-vault-lock")).toBeTruthy();
    expect(screen.getByTestId("select-idle-lock-timeout").textContent).toContain("After 5 minutes");
    expect(screen.getByTestId("switch-lock-on-suspend").getAttribute("data-state")).toBe("checked");
    expect(screen.getByTestId("switch-lock-on-resume").getAttribute("data-state")).toBe("checked");
    expect(screen.getByTestId("switch-lock-on-screen-lock").getAttribute("data-state")).toBe("checked");

    fireEvent.click(screen.getByTestId("switch-lock-on-screen-lock"));
    fireEvent.click(screen.getByTestId("button-save-settings"));

    await waitFor(() => {
      expect(updateDesktopLockSettings).toHaveBeenCalledWith({
        idleTimeoutSeconds: 300,
        lockOnSuspend: true,
        lockOnResume: true,
        lockOnScreenLock: false,
      });
    });
    expect(updateNodeSettings).not.toHaveBeenCalled();
  });
});