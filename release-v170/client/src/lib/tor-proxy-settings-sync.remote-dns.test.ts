import { describe, expect, it } from "vitest";
import {
  canonicalizeTorProxyUrl,
  torProxySettingsFromNodeSettings,
} from "./tor-proxy-settings-sync";

describe("Tor proxy remote-DNS settings", () => {
  it("migrates socks5 to socks5h without changing the endpoint", () => {
    expect(canonicalizeTorProxyUrl("socks5://127.0.0.1:9150")).toEqual({
      ok: true,
      value: "socks5h://127.0.0.1:9150",
      migrated: true,
    });
  });

  it("rejects malformed and non-SOCKS values with a remote-DNS explanation", () => {
    for (const value of ["http://127.0.0.1:9050", "socks5h://127.0.0.1", "not a URL"]) {
      const result = canonicalizeTorProxyUrl(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/socks5h|DNS resolves through Tor/i);
    }
  });

  it("canonicalizes the persisted value before syncing it to either runtime", () => {
    const payload = torProxySettingsFromNodeSettings({
      id: "default",
      providerType: "mempool-space",
      useTor: true,
      requestTimeout: 60_000,
      network: "mainnet",
      allowLocalNetwork: false,
      trustedLocalHosts: [],
      torProxyUrl: "socks5://proxy.example:9050",
    });
    expect(payload.torProxyUrl).toBe("socks5h://proxy.example:9050");
  });
});