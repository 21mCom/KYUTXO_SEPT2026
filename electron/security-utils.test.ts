import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// Guards the desktop app's external-link allowlist and the tor-request IPC
// input schema. main.cjs can't be required in a test (it needs a live
// Electron runtime), so the decision logic lives in security-utils.cjs and is
// exercised here directly — the same pattern as block-hash.test.ts.
//
// Regression target: a future edit must not silently reintroduce a catch-all
// `https://` open (or drop scheme validation) in setWindowOpenHandler, and
// must not drop zod validation of tor-request args.

const requireCjs = createRequire(import.meta.url);
const {
  EXTERNAL_OPEN_ALLOWED_HOSTS,
  isExternalOpenAllowed,
  DEV_SERVER_ORIGIN,
  isNavigationAllowed,
  torRequestSchema,
} = requireCjs("./security-utils.cjs") as {
  EXTERNAL_OPEN_ALLOWED_HOSTS: string[];
  isExternalOpenAllowed: (url: unknown) => boolean;
  DEV_SERVER_ORIGIN: string;
  isNavigationAllowed: (url: unknown, opts?: { isDev?: boolean }) => boolean;
  torRequestSchema: {
    safeParse: (input: unknown) => { success: boolean; data?: unknown };
  };
};

describe("external-open allowlist", () => {
  it("allowlists only the trusted hosts", () => {
    expect(EXTERNAL_OPEN_ALLOWED_HOSTS).toEqual([
      "mempool.space",
      "blockstream.info",
      "github.com",
    ]);
  });

  it.each([
    "https://mempool.space/tx/abc123",
    "https://blockstream.info/address/bc1qxyz",
    "https://github.com/some-org/some-repo",
  ])("allows https URLs on allowlisted host: %s", (url) => {
    expect(isExternalOpenAllowed(url)).toBe(true);
  });

  it.each([
    // http is never allowed, even on an allowlisted host
    "http://mempool.space/tx/abc123",
    "http://github.com/",
    // scriptable / dangerous schemes
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    // https on non-allowlisted hosts (a catch-all https open must fail this)
    "https://evil.example.com/phishing",
    "https://attacker-controlled.site/",
    // lookalike hosts and subdomain tricks
    "https://mempool.space.evil.com/",
    "https://notmempool.space/",
    "https://github.com.evil.example/",
    "https://mempoolspace.com/",
    // malformed input
    "not a url",
    "",
  ])("denies non-allowlisted or unsafe URL: %s", (url) => {
    expect(isExternalOpenAllowed(url)).toBe(false);
  });

  it("denies non-string input without throwing", () => {
    expect(isExternalOpenAllowed(undefined)).toBe(false);
    expect(isExternalOpenAllowed(null)).toBe(false);
    expect(isExternalOpenAllowed(42)).toBe(false);
    expect(isExternalOpenAllowed({})).toBe(false);
  });
});

describe("will-navigate allowlist", () => {
  it("pins the dev server origin", () => {
    expect(DEV_SERVER_ORIGIN).toBe("http://localhost:5000");
  });

  const FILE_URLS = [
    "file:///home/user/app/dist/public/index.html",
    "file:///C:/app/dist/public/index.html",
  ];

  const DEV_SERVER_URLS = [
    "http://localhost:5000",
    "http://localhost:5000/",
    "http://localhost:5000/some/route?query=1#hash",
  ];

  it.each(FILE_URLS)(
    "allows file: navigation in both modes: %s",
    (url) => {
      expect(isNavigationAllowed(url, { isDev: true })).toBe(true);
      expect(isNavigationAllowed(url, { isDev: false })).toBe(true);
      // default (no options) must behave like production
      expect(isNavigationAllowed(url)).toBe(true);
    },
  );

  it.each(DEV_SERVER_URLS)(
    "allows dev server origin only in dev mode: %s",
    (url) => {
      expect(isNavigationAllowed(url, { isDev: true })).toBe(true);
    },
  );

  it.each(DEV_SERVER_URLS)(
    "denies dev server origin in packaged (production) mode: %s",
    (url) => {
      expect(isNavigationAllowed(url, { isDev: false })).toBe(false);
      // defaults must fail closed: no options / empty options = production
      expect(isNavigationAllowed(url)).toBe(false);
      expect(isNavigationAllowed(url, {})).toBe(false);
    },
  );

  it("requires isDev to be exactly true, not merely truthy", () => {
    expect(isNavigationAllowed("http://localhost:5000/", { isDev: 1 as unknown as boolean })).toBe(false);
    expect(isNavigationAllowed("http://localhost:5000/", { isDev: "development" as unknown as boolean })).toBe(false);
  });

  it.each([
    // arbitrary https/http origins (a widened guard must fail these)
    "https://evil.example.com/phishing",
    "https://localhost:5000/", // wrong scheme → different origin
    "http://localhost:5001/", // wrong port
    "http://localhost.evil.com:5000/",
    "http://127.0.0.1:5000/", // different host string → different origin
    "https://mempool.space/tx/abc", // allowlisted for external open, not navigation
    // scriptable / dangerous schemes
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "about:blank",
    // prefix-confusion schemes: only exactly `file:` may pass
    "fileevil:///etc/passwd",
    "file+foo:///x",
    "files://host/share",
    // malformed input
    "not a url",
    "",
  ])("denies in-window navigation to untrusted URL: %s", (url) => {
    expect(isNavigationAllowed(url)).toBe(false);
  });

  it("denies non-string input without throwing", () => {
    expect(isNavigationAllowed(undefined)).toBe(false);
    expect(isNavigationAllowed(null)).toBe(false);
    expect(isNavigationAllowed(42)).toBe(false);
    expect(isNavigationAllowed({})).toBe(false);
  });
});

describe("tor-request input schema", () => {
  it("accepts a minimal valid request", () => {
    const result = torRequestSchema.safeParse({ url: "https://mempool.space/api/blocks/tip/height" });
    expect(result.success).toBe(true);
  });

  it("accepts a fully-populated valid request", () => {
    const result = torRequestSchema.safeParse({
      url: "https://mempool.space/api/address/bc1qxyz",
      method: "GET",
      headers: { Accept: "application/json" },
      body: undefined,
      timeout: 15000,
      torProxyUrl: "socks5://127.0.0.1:9050",
      allowedHost: "mempool.space",
      trustedLocalHosts: ["127.0.0.1"],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["non-string url", { url: 12345 }],
    ["missing url", {}],
    ["empty url", { url: "" }],
    ["null args", null],
    ["undefined args", undefined],
    ["non-record headers", { url: "https://mempool.space", headers: "Accept: application/json" }],
    ["array headers", { url: "https://mempool.space", headers: ["a", "b"] }],
    ["non-string header value", { url: "https://mempool.space", headers: { Accept: 1 } }],
    ["non-integer timeout", { url: "https://mempool.space", timeout: 1.5 }],
    ["non-positive timeout", { url: "https://mempool.space", timeout: 0 }],
    ["non-string method", { url: "https://mempool.space", method: 7 }],
    ["non-string torProxyUrl", { url: "https://mempool.space", torProxyUrl: { host: "x" } }],
    ["non-array trustedLocalHosts", { url: "https://mempool.space", trustedLocalHosts: "127.0.0.1" }],
  ])("rejects malformed input: %s", (_label, input) => {
    expect(torRequestSchema.safeParse(input).success).toBe(false);
  });
});
