// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
const nodeSettingsCrudMocks = vi.hoisted(() => ({
  getNodeSettings: vi.fn(async () => undefined),
  putNodeSettings: vi.fn(async () => undefined),
  updateNodeSettings: vi.fn(async () => undefined),
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) =>
    mockQueryReturn === undefined
      ? undefined
      : { settings: mockQueryReturn === null ? undefined : mockQueryReturn },
}));

vi.mock("@/lib/database", () => ({
  db: {
    nodeSettings: {
      get: vi.fn(() => Promise.resolve(undefined)),
      update: vi.fn(),
      put: vi.fn(),
    },
  },
  DEFAULT_TRUSTED_LOCAL_HOSTS: ["127.0.0.1", "localhost"],
}));

vi.mock("@/lib/data/node-settings-crud", () => nodeSettingsCrudMocks);

vi.mock("@/lib/tor-proxy-settings-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tor-proxy-settings-sync")>()),
  syncTorProxySettings: vi.fn(async () => true),
}));

import { useNodeSettings, getDefaultNodeSettings } from "./use-node-settings";
import { assertNetworkAccessAllowed, setRuntimeNetworkSettings } from "@/lib/network-privacy";

beforeEach(() => {
  vi.useFakeTimers();
  mockQueryReturn = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useNodeSettings", () => {
  it("returns default settings when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useNodeSettings());
    expect(result.current.nodeSettings.providerType).toBe("mempool-space");
    expect(result.current.nodeSettings.useTor).toBe(false);
    expect(result.current.nodeSettings.network).toBe("mainnet");
    expect(result.current.nodeSettings.allowLocalNetwork).toBe(false);
  });

  it("isLoading is true when settings are undefined and timeout has not elapsed", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useNodeSettings());
    expect(result.current.isLoading).toBe(true);
  });

  it("isLoading becomes false after timeout when settings remain undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useNodeSettings());

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.nodeSettings.networkAccessEnabled).toBe(false);
    expect(result.current.nodeSettings.networkOnboardingStage).toBe("source");
    expect(() => assertNetworkAccessAllowed(result.current.nodeSettings)).toThrow(
      "No network source is configured",
    );
  });

  it("merges loaded settings with defaults", () => {
    mockQueryReturn = {
      id: "default",
      providerType: "custom",
      useTor: true,
      requestTimeout: 60000,
      network: "testnet",
    };
    const { result } = renderHook(() => useNodeSettings());
    expect(result.current.nodeSettings.providerType).toBe("custom");
    expect(result.current.nodeSettings.useTor).toBe(true);
    expect(result.current.nodeSettings.requestTimeout).toBe(60000);
    expect(result.current.nodeSettings.network).toBe("testnet");
    expect(result.current.nodeSettings.useElectrum).toBe(false);
  });

  it("defaults allowLocalNetwork to false for existing users without the field", () => {
    mockQueryReturn = {
      id: "default",
      providerType: "mempool-space",
      useTor: false,
      requestTimeout: 30000,
      network: "mainnet",
    };
    const { result } = renderHook(() => useNodeSettings());
    expect(result.current.nodeSettings.allowLocalNetwork).toBe(false);
  });

  it("defaults trustedLocalHosts when not present in saved settings", () => {
    mockQueryReturn = {
      id: "default",
      providerType: "mempool-space",
      useTor: false,
      requestTimeout: 30000,
      network: "mainnet",
    };
    const { result } = renderHook(() => useNodeSettings());
    expect(result.current.nodeSettings.trustedLocalHosts).toEqual(["127.0.0.1", "localhost"]);
  });

  it("isLoading is false when settings are loaded", () => {
    mockQueryReturn = { id: "default", providerType: "mempool-space" };
    const { result } = renderHook(() => useNodeSettings());
    expect(result.current.isLoading).toBe(false);
  });

  it("treats a confirmed missing legacy row as loaded legacy defaults", () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useNodeSettings());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.nodeSettings.networkOnboardingStage).toBeUndefined();
    expect(() => assertNetworkAccessAllowed(result.current.nodeSettings)).not.toThrow();
  });

  it("exposes updateSettings, forgetNetworkSource, resetToDefaults, and setConnectionStatus functions", () => {
    mockQueryReturn = { id: "default", providerType: "mempool-space" };
    const { result } = renderHook(() => useNodeSettings());
    expect(typeof result.current.updateSettings).toBe("function");
    expect(typeof result.current.forgetNetworkSource).toBe("function");
    expect(typeof result.current.resetToDefaults).toBe("function");
    expect(typeof result.current.setConnectionStatus).toBe("function");
  });

  it("atomically returns a configured source to setup-required offline mode", async () => {
    mockQueryReturn = {
      id: "default",
      providerType: "custom-electrs",
      customUrl: "http://umbrel.local:3006/api",
      networkPrivacyMode: "own-node",
      networkOnboardingStage: "complete",
      networkAccessEnabled: true,
      networkPrivacyChosenAt: 123,
      firstSyncConfirmedAt: 456,
    };
    nodeSettingsCrudMocks.getNodeSettings.mockResolvedValue(mockQueryReturn);
    const { result } = renderHook(() => useNodeSettings());

    await act(async () => {
      await result.current.forgetNetworkSource();
    });

    expect(nodeSettingsCrudMocks.updateNodeSettings).toHaveBeenCalledWith("default", {
      networkAccessEnabled: false,
      networkOnboardingStage: "source",
      networkPrivacyMode: undefined,
      networkPrivacyChosenAt: undefined,
      firstSyncConfirmedAt: undefined,
      lastConnectionStatus: undefined,
      lastConnectedAt: undefined,
    });
    expect(() => assertNetworkAccessAllowed()).toThrow("No network source is configured");
  });

  it("keeps an optimistic offline policy authoritative across a rerender", async () => {
    mockQueryReturn = {
      id: "default",
      providerType: "mempool-space",
      useTor: false,
      networkPrivacyMode: "public-direct",
      networkOnboardingStage: "complete",
      networkAccessEnabled: true,
    };
    nodeSettingsCrudMocks.getNodeSettings.mockImplementation(() => new Promise(() => {}));
    const { result, rerender } = renderHook(() => useNodeSettings());

    void result.current.updateSettings({ networkAccessEnabled: false });
    rerender();

    expect(() => assertNetworkAccessAllowed()).toThrow("Network access is offline");
  });

  it("reset preserves offline and onboarding policy fields", async () => {
    mockQueryReturn = {
      id: "default",
      providerType: "custom-electrs",
      customUrl: "http://umbrel.local:3006/api",
      useTor: false,
      networkPrivacyMode: "own-node",
      networkOnboardingStage: "complete",
      networkAccessEnabled: false,
      firstSyncConfirmedAt: 123,
    };
    const { result } = renderHook(() => useNodeSettings());
    await act(async () => {
      await result.current.resetToDefaults();
    });

    expect(nodeSettingsCrudMocks.putNodeSettings).toHaveBeenCalledWith(expect.objectContaining({
      providerType: "mempool-space",
      networkPrivacyMode: "public-direct",
      networkOnboardingStage: "complete",
      networkAccessEnabled: false,
      firstSyncConfirmedAt: 123,
    }));
  });

  it("persists a remote-DNS migration for legacy socks5 proxy settings", async () => {
    mockQueryReturn = {
      id: "default",
      providerType: "mempool-space",
      useTor: true,
      requestTimeout: 60_000,
      network: "mainnet",
      torProxyUrl: "socks5://127.0.0.1:9050",
    };
    renderHook(() => useNodeSettings());
    await act(async () => {
      await Promise.resolve();
    });
    expect(nodeSettingsCrudMocks.updateNodeSettings).toHaveBeenCalledWith("default", {
      torProxyUrl: "socks5h://127.0.0.1:9050",
    });
  });
});

describe("getDefaultNodeSettings", () => {
  it("returns a copy of default settings", () => {
    const defaults = getDefaultNodeSettings();
    expect(defaults.providerType).toBe("mempool-space");
    expect(defaults.useTor).toBe(false);
    expect(defaults.network).toBe("mainnet");
    expect(defaults.allowLocalNetwork).toBe(false);
  });

  it("returns a new object each time", () => {
    const a = getDefaultNodeSettings();
    const b = getDefaultNodeSettings();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
