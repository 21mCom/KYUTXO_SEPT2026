import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import router, {
  isAllowedUrl,
  updateTorProxySettings,
  resetTorProxySettings,
  clampProxyTimeout,
  MAX_REQUEST_BODY_BYTES,
  MAX_INCOMING_CONTENT_LENGTH,
  MAX_TIMEOUT_MS,
  MAX_CONCURRENT_PROXIED_REQUESTS,
  MAX_QUEUED_PROXIED_REQUESTS,
  MAX_RESPONSE_BODY_BYTES,
} from "./tor-proxy";
import { app as productionApp } from "./app";

// server/tor-proxy.ts uses node-fetch for outbound requests (undici ignores
// the `agent` option). Delegate its dynamic import to whatever global fetch
// the current test has stubbed so the endpoint tests stay hermetic.
vi.mock("node-fetch", () => ({
  default: (url: unknown, init: unknown) =>
    (globalThis.fetch as (u: unknown, i: unknown) => unknown)(url, init),
}));

describe("tor-proxy settings validation", () => {
  beforeEach(() => resetTorProxySettings());

  it("rejects malformed payloads", () => {
    expect(updateTorProxySettings(null).success).toBe(false);
    expect(updateTorProxySettings("x").success).toBe(false);
    expect(updateTorProxySettings([1]).success).toBe(false);
    expect(updateTorProxySettings({ trustedLocalHosts: "192.168.1.1" }).success).toBe(false);
    expect(updateTorProxySettings({ trustedLocalHosts: [123] }).success).toBe(false);
    expect(updateTorProxySettings({ trustedLocalHosts: ["http://evil.com"] }).success).toBe(false);
    expect(updateTorProxySettings({ customProviderUrl: "not a url" }).success).toBe(false);
    expect(updateTorProxySettings({ customProviderUrl: "ftp://example.com" }).success).toBe(false);
  });

  it("rejects non-SOCKS tor proxy URLs", () => {
    expect(updateTorProxySettings({ torProxyUrl: "http://127.0.0.1:9050" }).success).toBe(false);
    expect(updateTorProxySettings({ torProxyUrl: "socks5h://127.0.0.1" }).success).toBe(false);
    expect(updateTorProxySettings({ torProxyUrl: "socks5h://127.0.0.1:99999" }).success).toBe(false);
    expect(updateTorProxySettings({ torProxyUrl: "socks5h://127.0.0.1:9050" }).success).toBe(true);
    expect(updateTorProxySettings({ torProxyUrl: "socks5://192.168.1.5:9050" }).success).toBe(true);
  });
});

describe("isAllowedUrl (server-side allowlist)", () => {
  beforeEach(() => resetTorProxySettings());

  it("allows known Esplora providers and the Tor check endpoint over HTTPS", () => {
    expect(isAllowedUrl("https://mempool.space/api/blocks/tip/height").allowed).toBe(true);
    expect(isAllowedUrl("https://blockstream.info/api/address/x").allowed).toBe(true);
    expect(isAllowedUrl("https://check.torproject.org/api/ip").allowed).toBe(true);
    expect(isAllowedUrl("https://testnet.mempool.space/api").allowed).toBe(true);
  });

  it("rejects off-allowlist hosts", () => {
    const check = isAllowedUrl("https://evil.example.com/api");
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/not in the allowed list/);
  });

  it("requires HTTPS for public hosts", () => {
    expect(isAllowedUrl("http://mempool.space/api").allowed).toBe(false);
  });

  it("rejects arbitrary .onion destinations by default", () => {
    const check = isAllowedUrl("http://somerandomnodeabcdef.onion:3002/api");
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/not your configured provider/);
  });

  it("allows the configured custom provider, including its onion host over HTTP", () => {
    expect(
      updateTorProxySettings({ customProviderUrl: "http://somerandomnodeabcdef.onion:3002" }).success,
    ).toBe(true);
    expect(isAllowedUrl("http://somerandomnodeabcdef.onion:3002/api/tx").allowed).toBe(true);
    // But other onions are still rejected
    expect(isAllowedUrl("http://othernode123456.onion/api").allowed).toBe(false);
  });

  it("allows a configured clearnet custom provider over HTTPS only", () => {
    updateTorProxySettings({ customProviderUrl: "https://esplora.example.org" });
    expect(isAllowedUrl("https://esplora.example.org/api").allowed).toBe(true);
    expect(isAllowedUrl("http://esplora.example.org/api").allowed).toBe(false);
  });

  it("rejects private addresses without configured trust", () => {
    expect(isAllowedUrl("http://192.168.1.50:3002/api").allowed).toBe(false);
    expect(isAllowedUrl("http://10.0.0.5/api").allowed).toBe(false);
    expect(isAllowedUrl("http://localhost:3002/api").allowed).toBe(false);
    expect(isAllowedUrl("http://127.0.0.1:3002/api").allowed).toBe(false);
  });

  it("allows configured trusted local hosts and marks them local", () => {
    updateTorProxySettings({ trustedLocalHosts: ["192.168.1.50", "umbrel.local"] });
    const trusted = isAllowedUrl("http://192.168.1.50:3002/api");
    expect(trusted.allowed).toBe(true);
    expect(trusted.isLocal).toBe(true);
    expect(isAllowedUrl("http://umbrel.local/api").allowed).toBe(true);
    // Neighbouring hosts stay rejected
    expect(isAllowedUrl("http://192.168.1.51/api").allowed).toBe(false);
  });
});

describe("clampProxyTimeout", () => {
  it("defaults, floors, and caps", () => {
    expect(clampProxyTimeout(undefined)).toBe(60_000);
    expect(clampProxyTimeout(NaN)).toBe(60_000);
    expect(clampProxyTimeout(-5)).toBe(60_000);
    expect(clampProxyTimeout(500)).toBe(1_000);
    expect(clampProxyTimeout(30_000)).toBe(30_000);
    expect(clampProxyTimeout(10 * 60_000)).toBe(MAX_TIMEOUT_MS);
  });
});

// ============================================================================
// Endpoint-level tests (real HTTP against an ephemeral server)
// ============================================================================
describe("/api/tor endpoints", () => {
  let server: Server;
  let baseUrl: string;
  // Capture the real fetch up front: tests stub global fetch to simulate the
  // upstream, but the test's own client calls must keep hitting the server.
  const realFetch = globalThis.fetch.bind(globalThis);

  async function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
    return realFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  }

  let settingsToken: string;
  const authHeader = () => ({ "x-tor-settings-token": settingsToken });

  async function fetchSettingsToken(): Promise<string> {
    const res = await realFetch(`${baseUrl}/api/tor/settings-token`);
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.token as string;
  }

  beforeEach(async () => {
    resetTorProxySettings();
    const app = express();
    // Deliberately generous parser limit so the router's own bounds are what
    // reject oversized requests under test.
    app.use(express.json({ limit: "5mb" }));
    app.use("/api/tor", router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Initialize with empty (deny-custom) settings, as the local app would, so
    // rejections below are genuine 403s rather than 428 not-initialized.
    settingsToken = await fetchSettingsToken();
    const init = await post("/api/tor/settings", {}, authHeader());
    expect(init.status).toBe(200);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // Destroy any lingering sockets (e.g. requests hung on a stubbed upstream)
    // so server.close() can complete.
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Collect the return values of setTimeout calls made with a specific delay,
  // so we can prove each one was later passed to clearTimeout.
  function trackTimersWithDelay(ms: number) {
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    return {
      expectAllCleared() {
        const created = setSpy.mock.calls
          .map((call, idx) => ({
            delay: call[1],
            value: setSpy.mock.results[idx]?.type === "return" ? setSpy.mock.results[idx].value : undefined,
          }))
          .filter((entry) => entry.delay === ms)
          .map((entry) => entry.value);
        expect(created.length).toBeGreaterThan(0);
        for (const timer of created) {
          expect(clearSpy.mock.calls.some(([arg]) => arg === timer)).toBe(true);
        }
      },
    };
  }

  it("rejects off-allowlist hosts with 403 and never calls upstream", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post("/api/tor/request", { url: "https://evil.example.com/api" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not in the allowed list/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores caller-supplied allowedHost", async () => {
    const res = await post("/api/tor/request", {
      url: "https://evil.example.com/api",
      allowedHost: "https://evil.example.com",
    });
    expect(res.status).toBe(403);
  });

  it("ignores caller-supplied trustedLocalHosts for private addresses", async () => {
    const res = await post("/api/tor/request", {
      url: "http://192.168.1.99:3002/api",
      trustedLocalHosts: ["192.168.1.99"],
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/trusted hosts whitelist/);
  });

  it("rejects unconfigured .onion destinations even over Tor", async () => {
    const res = await post("/api/tor/request", {
      url: "http://randomnodeabcdef123.onion/api",
    });
    expect(res.status).toBe(403);
  });

  it("rejects non-GET/POST methods", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await post("/api/tor/request", {
        url: "https://mempool.space/api",
        method,
      });
      expect(res.status).toBe(405);
    }
  });

  it("rejects oversized request bodies with 413", async () => {
    const res = await post("/api/tor/request", {
      url: "https://mempool.space/api/tx",
      method: "POST",
      body: "a".repeat(MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("rejects oversized request envelopes via Content-Length with 413", async () => {
    const big = JSON.stringify({
      url: "https://mempool.space/api",
      padding: "a".repeat(MAX_INCOMING_CONTENT_LENGTH),
    });
    const res = await fetch(`${baseUrl}/api/tor/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it("allows requests once settings are pushed server-side", async () => {
    const settingsRes = await post("/api/tor/settings", {
      customProviderUrl: "https://esplora.example.org",
      torProxyUrl: "socks5h://127.0.0.1:9050",
    }, authHeader());
    expect(settingsRes.status).toBe(200);

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ height: 850000 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    const res = await post("/api/tor/request", { url: "https://esplora.example.org/api/blocks/tip/height" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.height).toBe(850000);
  });

  it("rejects invalid settings pushes with 400", async () => {
    const res = await post("/api/tor/settings", { torProxyUrl: "http://not-socks:9050" }, authHeader());
    expect(res.status).toBe(400);
  });

  it("clears the upstream timeout even when the fetch rejects immediately", async () => {
    // Regression: a rejected fetch used to leak its AbortController timer, so
    // repeated failures could accumulate unbounded pending timers despite the
    // concurrency cap. The request uses the default timeout (60s).
    const tracker = trackTimersWithDelay(60_000);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9050");
    }));

    const res = await post("/api/tor/request", { url: "https://mempool.space/api/blocks/tip/height" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Cannot connect to the Tor proxy/);

    tracker.expectAllCleared();
  });

  it("rejects an oversized upstream response cleanly instead of buffering it", async () => {
    // A hostile/misbehaving upstream that streams far more than the cap. If
    // the proxy buffered the whole body (the old .json()/.text() behavior),
    // this would drain all 200 MB; the bounded reader must abort early.
    const chunk = new Uint8Array(1024 * 1024);
    let produced = 0;
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (produced >= 200 * 1024 * 1024) {
              controller.close();
              return;
            }
            produced += chunk.length;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));

    const res = await post("/api/tor/request", { url: "https://mempool.space/api/blocks" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/response too large/i);
    // The upstream stream was cancelled shortly past the cap, not drained.
    expect(produced).toBeLessThan(MAX_RESPONSE_BODY_BYTES + 16 * 1024 * 1024);
  }, 30000);

  it("still succeeds for a streamed response within the cap", async () => {
    const payload = JSON.stringify({ height: 850123 });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));

    const res = await post("/api/tor/request", { url: "https://mempool.space/api/blocks/tip" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.height).toBe(850123);
  });

  it("rejects settings mutation without a valid token and never allowlists the attacker's host", async () => {
    // No token at all
    let res = await post("/api/tor/settings", { customProviderUrl: "https://evil.example.com" });
    expect(res.status).toBe(403);
    // Wrong token
    res = await post(
      "/api/tor/settings",
      { customProviderUrl: "https://evil.example.com" },
      { "x-tor-settings-token": "0".repeat(64) },
    );
    expect(res.status).toBe(403);
    // The attacker's host was never allowlisted
    res = await post("/api/tor/request", { url: "https://evil.example.com/api" });
    expect(res.status).toBe(403);
  });

  it("issues the settings token only to loopback clients", async () => {
    // A second app whose requests appear to come from a LAN address.
    const lanApp = express();
    lanApp.use((req, _res, next) => {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: "203.0.113.10",
        writable: true,
        configurable: true,
      });
      next();
    });
    lanApp.use("/api/tor", router);
    const lanServer = lanApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => lanServer.on("listening", () => resolve()));
    try {
      const lanBase = `http://127.0.0.1:${(lanServer.address() as AddressInfo).port}`;
      const res = await realFetch(`${lanBase}/api/tor/settings-token`);
      expect(res.status).toBe(403);
    } finally {
      (lanServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => lanServer.close(() => resolve()));
    }
    // Sanity: the loopback app does issue it.
    const localRes = await realFetch(`${baseUrl}/api/tor/settings-token`);
    expect(localRes.status).toBe(200);
  });

  it("recovers after a server restart: 428 prompts a re-push and the retry succeeds", async () => {
    // Configure a custom provider with valid authorization.
    const configured = await post(
      "/api/tor/settings",
      { customProviderUrl: "https://esplora.example.org" },
      authHeader(),
    );
    expect(configured.status).toBe(200);

    // Simulate a server restart: in-memory settings are lost.
    resetTorProxySettings();

    // The custom host is now unknown — the proxy asks the client to re-sync.
    const res = await post("/api/tor/request", { url: "https://esplora.example.org/api/blocks/tip/height" });
    expect(res.status).toBe(428);
    const errBody = await res.json();
    expect(errBody.errorCode).toBe("TOR_SETTINGS_NOT_INITIALIZED");

    // The client re-pushes and the retry succeeds.
    const repush = await post(
      "/api/tor/settings",
      { customProviderUrl: "https://esplora.example.org" },
      authHeader(),
    );
    expect(repush.status).toBe(200);

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ height: 850001 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    const retry = await post("/api/tor/request", { url: "https://esplora.example.org/api/blocks/tip/height" });
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.success).toBe(true);
    expect(body.data.height).toBe(850001);
  });

  it("bounds concurrency and rejects overflow with 429", async () => {
    // Stub the upstream to be slow (200ms): active slots stay occupied long
    // enough that the arrival burst fills the queue and overflows, while every
    // queued request still drains well within the queue-wait timeout.
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response("1", { status: 200, headers: { "Content-Type": "text/plain" } });
    }));

    // Raw HTTP requests with agent:false: the global fetch (undici) pools ~10
    // connections per origin, which would leave the overflow requests stuck in
    // the CLIENT pool where the server never sees (and never rejects) them.
    const rawPost = (payload: unknown) =>
      new Promise<number>((resolveStatus, reject) => {
        const req = http.request(
          `${baseUrl}/api/tor/request`,
          {
            method: "POST",
            agent: false,
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolveStatus(res.statusCode ?? -1));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(payload));
      });

    const totalRequests = MAX_CONCURRENT_PROXIED_REQUESTS + MAX_QUEUED_PROXIED_REQUESTS + 3;
    const statuses = await Promise.all(
      Array.from({ length: totalRequests }, () =>
        rawPost({ url: "https://mempool.space/api/blocks/tip/height" }).catch(() => -1),
      ),
    );
    // Overflow beyond active + queued capacity is rejected on arrival.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    // Everything that fit within the bounds completes successfully.
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(MAX_CONCURRENT_PROXIED_REQUESTS);
    expect(statuses.filter((s) => s === -1)).toHaveLength(0);
  }, 30000);
});

// Exercises the REAL production middleware stack (server/app.ts): the global
// express.json() parser defaults to 100 KB, so /api/tor needs its own parser
// with the declared 1 MB cap registered before it — otherwise legitimate
// transaction broadcasts between 100–256 KB would be 413'd by generic parsing
// before the route's own policy runs.
describe("tor proxy body limits through the production middleware stack", () => {
  // Client calls must bypass the stubbed global fetch (which stands in for the
  // upstream) — keep a reference to the real one.
  const realFetch = globalThis.fetch.bind(globalThis);
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetTorProxySettings();
    productionApp.use("/api/tor", router);
    await new Promise<void>((resolve) => {
      server = productionApp.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards a POST body larger than the global 100 KB JSON default but within the 256 KB cap", async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ txid: "ab".repeat(32) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchStub);

    // 150 KB hex payload — over the global 100 KB default, under the 256 KB
    // body cap and the 1 MB envelope cap.
    const txHex = "aa".repeat(75 * 1024);
    const res = await realFetch(`${baseUrl}/api/tor/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://mempool.space/api/tx", method: "POST", body: txHex }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(fetchStub.mock.calls[0][1]?.body).toBe(txHex);
  });

  it("rejects envelopes over the 1 MB parser-level cap with 413", async () => {
    const res = await realFetch(`${baseUrl}/api/tor/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://mempool.space/api/tx", method: "POST", body: "bb".repeat(600 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
