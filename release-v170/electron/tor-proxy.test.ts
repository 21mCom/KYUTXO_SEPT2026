import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import type { AddressInfo } from "node:net";

const requireCjs = createRequire(import.meta.url);
const {
  isAllowedUrl,
  isPrivateAddress,
  canonicalizeSocksProxyUrl,
  updateTorProxySettings,
  getTorProxySettings,
  resetTorProxySettings,
  clampProxyTimeout,
  sanitizeForwardHeaders,
  handleTorRequest,
  makeProxiedRequest,
  makeDirectRequest,
  setFetchImplementationForTests,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_TIMEOUT_MS,
} = requireCjs("./tor-proxy.cjs") as {
  isAllowedUrl: (url: string) => { allowed: boolean; reason?: string; isLocal?: boolean };
  isPrivateAddress: (hostname: string) => boolean;
  canonicalizeSocksProxyUrl: (url: string) => string | undefined;
  updateTorProxySettings: (input: unknown) => { success: boolean; error?: string };
  getTorProxySettings: () => { torProxyUrl?: string };
  resetTorProxySettings: () => void;
  clampProxyTimeout: (timeout?: number) => number;
  sanitizeForwardHeaders: (headers: unknown) => Record<string, string> | undefined;
  handleTorRequest: (params: { url: string; method?: string; body?: unknown; timeout?: number }) => Promise<{ success: boolean; error?: string }>;
  makeProxiedRequest: (params: { url: string; timeout?: number; torProxyUrl?: string }) => Promise<{ success: boolean; error?: string }>;
  makeDirectRequest: (params: { url: string; timeout?: number }) => Promise<{ success: boolean; error?: string }>;
  setFetchImplementationForTests: (fetchImpl: unknown) => void;
  MAX_REQUEST_BODY_BYTES: number;
  MAX_RESPONSE_BODY_BYTES: number;
  MAX_TIMEOUT_MS: number;
};

describe("electron tor-proxy settings validation", () => {
  beforeEach(() => resetTorProxySettings());

  it("rejects malformed payloads (fail closed)", () => {
    expect(updateTorProxySettings(null).success).toBe(false);
    expect(updateTorProxySettings("x").success).toBe(false);
    expect(updateTorProxySettings({ trustedLocalHosts: "192.168.1.1" }).success).toBe(false);
    expect(updateTorProxySettings({ trustedLocalHosts: ["has space"] }).success).toBe(false);
    expect(updateTorProxySettings({ customProviderUrl: "ftp://example.com" }).success).toBe(false);
    expect(updateTorProxySettings({ torProxyUrl: "http://127.0.0.1:9050" }).success).toBe(false);
  });

  it("accepts a valid settings payload", () => {
    expect(
      updateTorProxySettings({
        customProviderUrl: "http://mynodeabcdef.onion:3002",
        trustedLocalHosts: ["192.168.1.50"],
        torProxyUrl: "socks5h://127.0.0.1:9050",
      }).success,
    ).toBe(true);
  });

  it("migrates legacy local-DNS SOCKS settings to remote DNS", () => {
    expect(updateTorProxySettings({ torProxyUrl: "socks5://proxy.example:9050" }).success).toBe(true);
    expect(getTorProxySettings().torProxyUrl).toBe("socks5h://proxy.example:9050");
    expect(canonicalizeSocksProxyUrl("socks5://127.0.0.1:9150")).toBe(
      "socks5h://127.0.0.1:9150",
    );
  });
});

describe("electron isAllowedUrl (main-process allowlist)", () => {
  beforeEach(() => resetTorProxySettings());

  it("allows known providers, rejects off-allowlist hosts", () => {
    expect(isAllowedUrl("https://mempool.space/api").allowed).toBe(true);
    expect(isAllowedUrl("https://blockstream.info/api").allowed).toBe(true);
    expect(isAllowedUrl("https://evil.example.com/api").allowed).toBe(false);
  });

  it("rejects arbitrary .onion destinations by default", () => {
    const check = isAllowedUrl("http://randomnodeabcdef.onion/api");
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/not your configured provider/);
  });

  it("allows the configured custom provider onion", () => {
    updateTorProxySettings({ customProviderUrl: "http://randomnodeabcdef.onion:3002" });
    expect(isAllowedUrl("http://randomnodeabcdef.onion:3002/api").allowed).toBe(true);
    expect(isAllowedUrl("http://othernode123.onion/api").allowed).toBe(false);
  });

  it("rejects private addresses without configured trust, allows trusted ones", () => {
    expect(isAllowedUrl("http://192.168.1.50:3002/api").allowed).toBe(false);
    expect(isAllowedUrl("http://127.0.0.1/api").allowed).toBe(false);
    updateTorProxySettings({ trustedLocalHosts: ["192.168.1.50"] });
    const trusted = isAllowedUrl("http://192.168.1.50:3002/api");
    expect(trusted.allowed).toBe(true);
    expect(trusted.isLocal).toBe(true);
    expect(isAllowedUrl("http://192.168.1.51/api").allowed).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 addresses that resolve to private ranges", () => {
    // Node's WHATWG URL parser normalises [::ffff:127.0.0.1] → [::ffff:7f00:1]
    expect(isAllowedUrl("https://[::ffff:7f00:1]/api").allowed).toBe(false);   // 127.0.0.1
    expect(isAllowedUrl("https://[::ffff:a00:1]/api").allowed).toBe(false);    // 10.0.0.1
    expect(isAllowedUrl("https://[::ffff:ac10:1]/api").allowed).toBe(false);   // 172.16.0.1
    expect(isAllowedUrl("https://[::ffff:c0a8:101]/api").allowed).toBe(false); // 192.168.1.1
    expect(isAllowedUrl("https://[::ffff:a9fe:101]/api").allowed).toBe(false); // 169.254.1.1
  });

  it.each([
    "127.99.1.2",
    "10.4.3.2",
    "172.31.255.1",
    "192.168.2.3",
    "169.254.8.9",
    "100.64.0.1",
    "100.127.255.254",
    "0.0.0.0",
    "[::]",
    "[::1]",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[febf::1]",
  ])("classifies %s as local/private", (hostname) => {
    expect(isPrivateAddress(hostname)).toBe(true);
  });

  it.each([
    "100.63.255.255",
    "100.128.0.0",
    "8.8.8.8",
    "[2001:4860:4860::8888]",
    "[fec0::1]",
  ])("does not classify %s as local/private", (hostname) => {
    expect(isPrivateAddress(hostname)).toBe(false);
  });
});

describe("electron handleTorRequest bounds", () => {
  beforeEach(() => resetTorProxySettings());

  it("rejects off-allowlist URLs without network access", async () => {
    const result = await handleTorRequest({ url: "https://evil.example.com/api" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in the allowed list/);
  });

  it("rejects disallowed methods", async () => {
    const result = await handleTorRequest({ url: "https://mempool.space/api", method: "DELETE" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not allowed/);
  });

  it("rejects oversized bodies", async () => {
    const result = await handleTorRequest({
      url: "https://mempool.space/api/tx",
      method: "POST",
      body: "a".repeat(MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/i);
  });
});

describe("electron tor-proxy helpers", () => {
  afterEach(() => {
    setFetchImplementationForTests(undefined);
    vi.restoreAllMocks();
  });

  it("clamps timeouts", () => {
    expect(clampProxyTimeout(undefined)).toBe(60_000);
    expect(clampProxyTimeout(500)).toBe(1_000);
    expect(clampProxyTimeout(10 * 60_000)).toBe(MAX_TIMEOUT_MS);
  });

  it("clears the upstream timeout even when the fetch rejects", async () => {
    // Regression: a rejected fetch used to leak its AbortController timer.
    // Point at a refused SOCKS port so node-fetch rejects immediately.
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    const result = await makeProxiedRequest({
      url: "https://mempool.space/api",
      torProxyUrl: "socks5h://127.0.0.1:1",
      timeout: 5000,
    });
    expect(result.success).toBe(false);

    const created = setSpy.mock.calls
      .map((call, idx) => ({
        delay: call[1],
        value: setSpy.mock.results[idx]?.type === "return" ? setSpy.mock.results[idx].value : undefined,
      }))
      .filter((entry) => entry.delay === 5000)
      .map((entry) => entry.value);
    expect(created.length).toBeGreaterThan(0);
    for (const timer of created) {
      expect(clearSpy.mock.calls.some(([arg]) => arg === timer)).toBe(true);
    }
  });

  it("sanitizes proxy connection errors — no SOCKS URL or raw exception text reaches the renderer", async () => {
    const result = await makeProxiedRequest({
      url: "https://mempool.space/api",
      torProxyUrl: "socks5h://127.0.0.1:1",
      timeout: 5000,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Cannot connect to the Tor proxy. Make sure Tor is running.");
    expect(result.error).not.toContain("socks5h");
    expect(result.error).not.toContain("127.0.0.1");
  });

  it("sanitizes direct request errors and logs — no target URL in errors or log output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await makeDirectRequest({
      url: "http://127.0.0.1:9/api/status",
      timeout: 5000,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Cannot connect to the target host. Make sure the host is reachable.");

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .filter((a): a is string => typeof a === "string")
      .join("\n");
    expect(logged).not.toContain("127.0.0.1:9");
    expect(result.error).not.toContain("127.0.0.1:9");
  });

  it.each([
    ["Tor-routed", makeProxiedRequest, { torProxyUrl: "socks5h://127.0.0.1:9050" }],
    ["direct", makeDirectRequest, {}],
  ])("refuses redirects on the %s request path", async (_name, request, extra) => {
    const fetchStub = vi.fn(async (_url: unknown, init: { redirect?: string }) => {
      expect(init.redirect).toBe("error");
      throw new Error("redirect mode is set to error for https://redirect.invalid/");
    });
    setFetchImplementationForTests(fetchStub);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await request({
      url: "https://mempool.space/api",
      ...extra,
    });
    expect(result.success).toBe(false);
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(result.error).not.toContain("redirect.invalid");
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("redirect.invalid");
  });

  it.each([
    ["Tor-routed", makeProxiedRequest, { torProxyUrl: "socks5h://127.0.0.1:9050" }],
    ["direct", makeDirectRequest, {}],
  ])("does not propagate or log upstream-controlled metadata on the %s path", async (_name, request, extra) => {
    setFetchImplementationForTests(vi.fn(async () => new Response("blocked", {
      status: 502,
      statusText: "See https://private-node.invalid:8443/error",
      headers: { "content-type": "text/plain; profile=https://private-node.invalid/type" },
    })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await request({
      url: "https://mempool.space/api",
      ...extra,
    });
    const serialized = JSON.stringify(result);
    expect(result.statusText).toBe("Upstream request failed");
    expect(result.contentType).toBe("text/plain");
    expect(serialized).not.toContain("private-node.invalid");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("private-node.invalid");
  });

  it("rejects an oversized upstream response cleanly instead of buffering it", async () => {
    // A hostile/misbehaving upstream that streams far more than the cap. The
    // bounded reader must abort early instead of buffering the whole body.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const chunk = Buffer.alloc(1024 * 1024);
    let produced = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      const write = () => {
        while (produced < 200 * 1024 * 1024) {
          produced += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", write);
            return;
          }
        }
        res.end();
      };
      write();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await makeDirectRequest({
        url: `http://127.0.0.1:${port}/huge`,
        timeout: 60_000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/response too large/i);
      // The upstream stream was cancelled shortly past the cap, not drained.
      expect(produced).toBeLessThan(MAX_RESPONSE_BODY_BYTES + 32 * 1024 * 1024);
    } finally {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);

  it("forwards only allowlisted headers", () => {
    expect(
      sanitizeForwardHeaders({
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
        Cookie: "session=abc",
        Accept: "application/json",
      }),
    ).toEqual({ "content-type": "application/json", accept: "application/json" });
    expect(sanitizeForwardHeaders({ Authorization: "x" })).toBeUndefined();
    expect(sanitizeForwardHeaders("nope")).toBeUndefined();
  });
});
