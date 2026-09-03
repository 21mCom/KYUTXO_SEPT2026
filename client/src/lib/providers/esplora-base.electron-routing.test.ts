/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateTorProxySettingsSync } from "../tor-proxy-settings-sync";
import { EsploraProvider } from "./esplora-base";

class CustomPublicProvider extends EsploraProvider {
  name = "Custom public";

  constructor() {
    super("https://custom-public.example/api");
    this.rateLimitDelay = 0;
  }
}

describe("EsploraProvider packaged Electron routing", () => {
  const torUpdateSettings = vi.fn(async () => ({ success: true }));
  const torRequest = vi.fn(async () => ({
    success: true,
    status: 200,
    statusText: "OK",
    data: "840000",
    contentType: "text/plain",
  }));

  beforeEach(() => {
    invalidateTorProxySettingsSync();
    torUpdateSettings.mockClear();
    torRequest.mockClear();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        isElectron: true,
        torUpdateSettings,
        torRequest,
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("renderer fetch must not run in packaged Electron");
    }));
  });

  afterEach(() => {
    delete (window as Window & { electronAPI?: unknown }).electronAPI;
    vi.unstubAllGlobals();
  });

  it("routes a custom public provider through validated main-process IPC", async () => {
    const provider = new CustomPublicProvider();

    await expect(provider.getBlockHeight()).resolves.toBe(840000);

    expect(torUpdateSettings).toHaveBeenCalledWith({
      customProviderUrl: "https://custom-public.example/api",
      trustedLocalHosts: [],
      torProxyUrl: undefined,
    });
    expect(torRequest).toHaveBeenCalledWith({
      url: "https://custom-public.example/api/blocks/tip/height",
      method: "GET",
      timeout: 30000,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});