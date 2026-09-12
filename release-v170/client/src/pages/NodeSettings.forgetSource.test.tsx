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

const forgetNetworkSource = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/hooks/use-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-settings")>()),
  useSettings: () => ({
    desktopLockSettings: {
      idleTimeoutSeconds: 300,
      lockOnSuspend: true,
      lockOnResume: true,
      lockOnScreenLock: true,
    },
  }),
}));

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({
    nodeSettings: {
      id: "default",
      providerType: "custom-electrs",
      customUrl: "http://umbrel.local:3006/api",
      useTor: false,
      requestTimeout: 30000,
      network: "mainnet",
      allowLocalNetwork: true,
      trustedLocalHosts: ["umbrel.local"],
      useElectrum: false,
      networkPrivacyMode: "own-node",
      networkOnboardingStage: "complete",
      networkAccessEnabled: true,
    },
    updateSettings: vi.fn(async () => undefined),
    forgetNetworkSource,
    resetToDefaults: vi.fn(async () => undefined),
    isLoading: false,
  }),
}));

vi.mock("@/lib/electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/electron")>()),
  isElectron: () => false,
}));

import NodeSettings from "./NodeSettings";
import { renderWithProviders } from "@/test/testProviders";

afterEach(() => {
  cleanup();
  forgetNetworkSource.mockClear();
});

describe("NodeSettings forget source", () => {
  it("requires confirmation and explains that details are retained without fallback", async () => {
    renderWithProviders(<NodeSettings />);

    fireEvent.click(screen.getByTestId("button-forget-network-source"));

    expect(screen.getByTestId("dialog-forget-network-source").textContent).toContain(
      "server addresses, Tor settings, and connection preferences will remain available",
    );
    expect(screen.getByTestId("dialog-forget-network-source").textContent).toContain(
      "will not fall back to or contact any provider",
    );
    expect(forgetNetworkSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("button-confirm-forget-network-source"));

    await waitFor(() => {
      expect(forgetNetworkSource).toHaveBeenCalledTimes(1);
    });
  });
});