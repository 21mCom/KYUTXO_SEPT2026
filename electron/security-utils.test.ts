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
  escapeHtml,
  torRequestSchema,
  torProxySettingsSchema,
  electrumIpcSchemas,
  validateElectrumIpc,
} = requireCjs("./security-utils.cjs") as {
  EXTERNAL_OPEN_ALLOWED_HOSTS: string[];
  isExternalOpenAllowed: (url: unknown) => boolean;
  DEV_SERVER_ORIGIN: string;
  isNavigationAllowed: (url: unknown, opts?: { isDev?: boolean }) => boolean;
  escapeHtml: (value: unknown) => string;
  torRequestSchema: {
    safeParse: (input: unknown) => { success: boolean; data?: unknown };
  };
  torProxySettingsSchema: {
    safeParse: (input: unknown) => { success: boolean; data?: unknown };
  };
  electrumIpcSchemas: Record<
    string,
    { safeParse: (input: unknown) => { success: boolean; data?: unknown } }
  >;
  validateElectrumIpc: (
    schema: { safeParse: (input: unknown) => unknown },
    rawArgs: unknown,
  ) => { ok: true; data: unknown } | { ok: false; error: string };
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

describe("escapeHtml (fallback error page)", () => {
  // Guards the packaged app's data: error page in main.cjs — indexPath,
  // err.message, and app.getAppPath() must be escaped before interpolation
  // so markup in a path or error message can't render as HTML.

  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &#39; f",
    );
  });

  it("escapes & first so entities are not double-mangled", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves plain paths and messages untouched", () => {
    expect(escapeHtml("/home/user/app/dist/public/index.html")).toBe(
      "/home/user/app/dist/public/index.html",
    );
    expect(escapeHtml("ENOENT: no such file or directory")).toBe(
      "ENOENT: no such file or directory",
    );
  });

  it("neutralizes an injection attempt embedded in a file path", () => {
    const malicious = `/tmp/<img src=x onerror=alert(1)>/index.html`;
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).toContain("&lt;img");
  });

  it("coerces non-string input without throwing", () => {
    expect(escapeHtml(undefined)).toBe("undefined");
    expect(escapeHtml(null)).toBe("null");
    expect(escapeHtml(42)).toBe("42");
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
    });
    expect(result.success).toBe(true);
  });

  it("strips legacy per-request allowlist/proxy fields", () => {
    // These fields were removed from the schema on purpose: allowlisting and
    // the SOCKS proxy URL come from main-process settings, not request input.
    const result = torRequestSchema.safeParse({
      url: "https://mempool.space/api",
      torProxyUrl: "socks5://evil.example.com:9050",
      allowedHost: "evil.example.com",
      trustedLocalHosts: ["192.168.1.99"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("torProxyUrl");
      expect(result.data).not.toHaveProperty("allowedHost");
      expect(result.data).not.toHaveProperty("trustedLocalHosts");
    }
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
  ])("rejects malformed input: %s", (_label, input) => {
    expect(torRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe("electrum IPC schemas", () => {
  const VALID_CONN = {
    host: "electrum.example.com",
    port: 50002,
    useSSL: true,
    timeout: 15000,
  };
  const VALID_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  const VALID_TXID = "a".repeat(64);

  it("accepts a minimal valid connection payload", () => {
    expect(electrumIpcSchemas.test.safeParse({ host: "127.0.0.1", port: 50001 }).success).toBe(true);
    expect(electrumIpcSchemas.test.safeParse(VALID_CONN).success).toBe(true);
  });

  it("accepts hosts with protocol prefixes/trailing slashes (cleaned downstream) and Tor options", () => {
    expect(
      electrumIpcSchemas.test.safeParse({
        ...VALID_CONN,
        host: "https://electrum.example.com/",
        useTor: true,
        torProxyUrl: "socks5h://127.0.0.1:9050",
      }).success,
    ).toBe(true);
    // empty / null / undefined proxy URL means auto-detect
    expect(electrumIpcSchemas.test.safeParse({ ...VALID_CONN, torProxyUrl: "" }).success).toBe(true);
    expect(electrumIpcSchemas.test.safeParse({ ...VALID_CONN, torProxyUrl: null }).success).toBe(true);
  });

  it.each([
    ["missing host", { port: 50001 }],
    ["non-string host", { host: 42, port: 50001 }],
    ["empty host", { host: "", port: 50001 }],
    ["host with embedded port", { host: "example.com:50001", port: 50001 }],
    ["host with path", { host: "example.com/evil", port: 50001 }],
    ["host with whitespace", { host: "exa mple.com", port: 50001 }],
    ["host with newline", { host: "example.com\nX", port: 50001 }],
    ["missing port", { host: "example.com" }],
    ["port 0", { host: "example.com", port: 0 }],
    ["port > 65535", { host: "example.com", port: 70000 }],
    ["non-integer port", { host: "example.com", port: 50001.5 }],
    ["string port", { host: "example.com", port: "50001" }],
    ["negative timeout", { host: "example.com", port: 50001, timeout: -1 }],
    ["huge timeout", { host: "example.com", port: 50001, timeout: 10_000_000 }],
    ["non-socks proxy URL", { host: "example.com", port: 50001, torProxyUrl: "http://127.0.0.1:9050" }],
    ["scriptable proxy URL", { host: "example.com", port: 50001, torProxyUrl: "javascript:alert(1)" }],
    ["malformed proxy URL", { host: "example.com", port: 50001, torProxyUrl: "not a url" }],
    ["null args", null],
    ["undefined args", undefined],
    ["string args", "host"],
  ])("rejects malformed connection payload: %s", (_label, input) => {
    expect(electrumIpcSchemas.test.safeParse(input).success).toBe(false);
  });

  it("validates address shape on history/utxo handlers", () => {
    for (const schema of [electrumIpcSchemas.getHistory, electrumIpcSchemas.getUtxos]) {
      expect(schema.safeParse({ ...VALID_CONN, address: VALID_ADDRESS }).success).toBe(true);
      expect(schema.safeParse({ ...VALID_CONN }).success).toBe(false); // missing
      expect(schema.safeParse({ ...VALID_CONN, address: "" }).success).toBe(false);
      expect(schema.safeParse({ ...VALID_CONN, address: "short" }).success).toBe(false);
      expect(schema.safeParse({ ...VALID_CONN, address: "bc1q; rm -rf /tmp/x" }).success).toBe(false);
      expect(schema.safeParse({ ...VALID_CONN, address: 42 }).success).toBe(false);
    }
  });

  it("validates batch address arrays", () => {
    for (const schema of [electrumIpcSchemas.batchGetHistory, electrumIpcSchemas.batchGetUtxos]) {
      expect(schema.safeParse({ ...VALID_CONN, addresses: [VALID_ADDRESS] }).success).toBe(true);
      expect(schema.safeParse({ ...VALID_CONN, addresses: [] }).success).toBe(false);
      expect(schema.safeParse({ ...VALID_CONN, addresses: VALID_ADDRESS }).success).toBe(false);
      expect(schema.safeParse({ ...VALID_CONN, addresses: [VALID_ADDRESS, "bad addr"] }).success).toBe(false);
      expect(
        schema.safeParse({ ...VALID_CONN, addresses: Array.from({ length: 10001 }, () => VALID_ADDRESS) })
          .success,
      ).toBe(false);
    }
  });

  it("validates txid format on electrum-get-transaction", () => {
    const schema = electrumIpcSchemas.getTransaction;
    expect(schema.safeParse({ ...VALID_CONN, txid: VALID_TXID, verbose: true }).success).toBe(true);
    expect(schema.safeParse({ ...VALID_CONN }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_CONN, txid: "xyz" }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_CONN, txid: VALID_TXID.slice(0, 63) }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_CONN, txid: `${VALID_TXID.slice(0, 63)}g` }).success).toBe(false);
  });

  it("validates block height bounds with the legacy error message", () => {
    const schema = electrumIpcSchemas.getBlockHash;
    expect(schema.safeParse({ ...VALID_CONN, height: 840000 }).success).toBe(true);
    for (const height of [-1, 1.5, undefined, "840000"]) {
      const parsed = validateElectrumIpc(schema, { ...VALID_CONN, height });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/Invalid block height/);
    }
  });

  it("validates certificate trust payloads", () => {
    const trust = electrumIpcSchemas.trustCertificate;
    expect(
      trust.safeParse({ host: "127.0.0.1", port: 50002, certificate: { fingerprint: "AA:BB" } }).success,
    ).toBe(true);
    expect(trust.safeParse({ host: "127.0.0.1", port: 50002 }).success).toBe(false);
    expect(trust.safeParse({ host: "127.0.0.1", port: 50002, certificate: {} }).success).toBe(false);
    expect(
      trust.safeParse({ host: "127.0.0.1", port: 999999, certificate: { fingerprint: "AA" } }).success,
    ).toBe(false);

    const get = electrumIpcSchemas.getCertificateTrust;
    expect(get.safeParse({ host: "127.0.0.1", port: 50002 }).success).toBe(true);
    expect(get.safeParse({ host: "127.0.0.1" }).success).toBe(false);
    expect(get.safeParse({ port: 50002 }).success).toBe(false);
  });

  it("validateElectrumIpc returns a compact error naming the bad field", () => {
    const parsed = validateElectrumIpc(electrumIpcSchemas.test, { host: "example.com", port: 0 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/^Invalid Electrum request \(port\): /);
    }
    const ok = validateElectrumIpc(electrumIpcSchemas.test, { host: "example.com", port: 50001 });
    expect(ok.ok).toBe(true);
  });
});

describe("tor-proxy settings schema", () => {
  it("accepts a full valid settings payload", () => {
    const result = torProxySettingsSchema.safeParse({
      customProviderUrl: "http://mynodeabcdef.onion:3002",
      trustedLocalHosts: ["192.168.1.50", "umbrel.local"],
      torProxyUrl: "socks5h://127.0.0.1:9050",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty payload and null-cleared fields", () => {
    expect(torProxySettingsSchema.safeParse({}).success).toBe(true);
    expect(torProxySettingsSchema.safeParse({ customProviderUrl: null, torProxyUrl: null }).success).toBe(true);
  });

  it.each([
    ["non-string customProviderUrl", { customProviderUrl: 42 }],
    ["overlong customProviderUrl", { customProviderUrl: `https://${"a".repeat(3000)}.com` }],
    ["non-array trustedLocalHosts", { trustedLocalHosts: "192.168.1.1" }],
    ["empty-string trusted host", { trustedLocalHosts: [""] }],
    ["too many trusted hosts", { trustedLocalHosts: Array.from({ length: 65 }, (_, i) => `192.168.1.${i}`) }],
    ["non-string torProxyUrl", { torProxyUrl: { host: "x" } }],
  ])("rejects malformed settings: %s", (_label, input) => {
    expect(torProxySettingsSchema.safeParse(input).success).toBe(false);
  });
});
