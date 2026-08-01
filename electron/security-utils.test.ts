import { describe, it, expect, vi, afterEach } from "vitest";
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
  sanitizeIpcError,
  logMainError,
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
  sanitizeIpcError: (error: unknown, fallback?: string) => string;
  logMainError: (context: string, error: unknown) => void;
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

describe("sanitizeIpcError (IPC error sanitization)", () => {
  // Regression target: Electron IPC handlers (file-handlers.cjs,
  // electrum-client.cjs, tor-proxy.cjs) must never send raw error.message
  // (which embeds filesystem paths, URLs, host:port) to the renderer.

  const errnoError = (code: string, message: string) => {
    const e = new Error(message) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };

  it("never echoes the raw message: filesystem paths are stripped", () => {
    const raw = "ENOENT: no such file or directory, open '/home/user/.config/kyutxo/attachments/secret.pdf'";
    const out = sanitizeIpcError(errnoError("ENOENT", raw), "Failed to read attachment");
    expect(out).toBe("File not found.");
    expect(out).not.toContain("/home");
    expect(out).not.toContain("secret.pdf");
  });

  it("never echoes the raw message: URLs/hosts are stripped", () => {
    const raw = "request to https://user-node.example.com:50002/api failed, reason: connect ECONNREFUSED 192.168.1.50:50002";
    const out = sanitizeIpcError(new Error(raw), "Proxy request failed");
    expect(out).toBe("Connection refused. Make sure the server (or Tor proxy) is running and reachable.");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("192.168.1.50");
  });

  it.each([
    ["AbortError", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
    ["ETIMEDOUT code", errnoError("ETIMEDOUT", "connect ETIMEDOUT 10.0.0.5:50001")],
    ["timeout in message", new Error("Request timeout after 30s for blockchain.scripthash.get_history")],
    ["timed out in message", new Error("Connection timed out")],
  ])("maps timeouts to the stable timeout hint: %s", (_label, error) => {
    const out = sanitizeIpcError(error, "fallback");
    expect(out).toContain("timed out");
    expect(out).not.toContain("10.0.0.5");
    expect(out).not.toContain("scripthash");
  });

  it.each([
    ["ENOTFOUND", errnoError("ENOTFOUND", "getaddrinfo ENOTFOUND my-private-node.local"), "Host not found. Check the server address."],
    ["EAI_AGAIN", errnoError("EAI_AGAIN", "getaddrinfo EAI_AGAIN my-node"), "Host not found. Check the server address."],
    ["ECONNRESET", errnoError("ECONNRESET", "read ECONNRESET"), "Connection closed unexpectedly. Please try again."],
    ["socket closed", new Error("Socket closed"), "Connection closed unexpectedly. Please try again."],
    ["TLS cert", new Error("unable to verify the first certificate"), "Secure connection failed. Check your SSL/TLS settings."],
    ["EACCES", errnoError("EACCES", "EACCES: permission denied, open '/root/x'"), "Permission denied by the operating system."],
    ["EPERM", errnoError("EPERM", "EPERM: operation not permitted"), "Permission denied by the operating system."],
    ["ENOSPC", errnoError("ENOSPC", "ENOSPC: no space left on device, write"), "Not enough disk space."],
  ])("maps %s to its stable hint", (_label, error, expected) => {
    expect(sanitizeIpcError(error, "fallback")).toBe(expected);
  });

  it("falls back to the caller's generic message for unknown errors", () => {
    expect(sanitizeIpcError(new Error("some weird internal detail /tmp/x"), "Failed to save attachment"))
      .toBe("Failed to save attachment");
  });

  it("uses a safe default fallback when none is provided", () => {
    expect(sanitizeIpcError(new Error("whatever"))).toBe("Operation failed");
  });

  it("handles non-Error input without throwing", () => {
    expect(sanitizeIpcError(undefined, "fb")).toBe("fb");
    expect(sanitizeIpcError(null, "fb")).toBe("fb");
    expect(sanitizeIpcError("ECONNREFUSED string", "fb")).toBe("fb");
    expect(sanitizeIpcError({ message: 42 }, "fb")).toBe("fb");
  });
});

describe("logMainError (main-process-side logging)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only the error name and errno code, never the raw message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = new Error("ENOENT: no such file, open '/home/user/vault/secret.pdf'") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    logMainError("[KYUTXO] read-attachment failed", e);
    expect(spy).toHaveBeenCalledWith("[KYUTXO] read-attachment failed: Error (ENOENT)");
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("/home");
    expect(logged).not.toContain("secret.pdf");
  });

  it("logs 'unknown error' for non-Error input without throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logMainError("ctx", "raw string with /path");
    expect(spy).toHaveBeenCalledWith("ctx: unknown error");
  });
});

describe("tor-proxy makeDirectRequest log/error hygiene", () => {
  // Regression target: makeDirectRequest (electron/tor-proxy.cjs) must never
  // put the renderer-supplied target URL/host into main-process logs or into
  // the error string returned over IPC — it can name a private local node.

  const { makeDirectRequest, isAllowedUrl, updateTorProxySettings, resetTorProxySettings } = requireCjs("./tor-proxy.cjs") as {
    makeDirectRequest: (params: {
      url: string;
      timeout?: number;
    }) => Promise<{ success: boolean; error?: string }>;
    isAllowedUrl: (url: string) => { allowed: boolean; reason?: string; isLocal?: boolean };
    updateTorProxySettings: (input: unknown) => { success: boolean };
    resetTorProxySettings: () => void;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    resetTorProxySettings();
  });

  const collectLogs = () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return lines;
  };

  it("connection-refused: stable hint, no URL/host in payload or logs", async () => {
    const lines = collectLogs();
    // Port 1 on loopback is closed — fails fast with ECONNREFUSED.
    const url = "http://127.0.0.1:1/private-node/api";
    const result = await makeDirectRequest({ url, timeout: 5000 });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Cannot connect to the target host. Make sure the host is reachable.",
    );
    const all = [result.error, ...lines].join("\n");
    expect(all).not.toContain(url);
    expect(all).not.toContain("127.0.0.1:1");
    expect(all).not.toContain("private-node");
  }, 15000);

  it("timeout: stable message, no URL/host in payload or logs", async () => {
    const lines = collectLogs();
    // Local server that accepts the connection but never responds, so the
    // 100ms abort fires and exercises the AbortError/timeout path.
    const http = await import("node:http");
    const server = http.createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/secret-local-endpoint`;
    const result = await makeDirectRequest({ url, timeout: 100 });
    server.close();
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    const all = [result.error, ...lines].join("\n");
    expect(all).not.toContain(url);
    expect(all).not.toContain(`127.0.0.1:${port}`);
    expect(all).not.toContain("secret-local-endpoint");
  }, 15000);

  it("isAllowedUrl rejection reasons never echo the hostname", () => {
    // Untrusted local address — reason travels over IPC to the renderer.
    const local = isAllowedUrl("http://192.168.1.77:3006/api");
    expect(local.allowed).toBe(false);
    expect(local.reason).not.toContain("192.168.1.77");
    // Non-allowlisted public host.
    const publicHost = isAllowedUrl("https://my-secret-provider.example.com/api");
    expect(publicHost.allowed).toBe(false);
    expect(publicHost.reason).not.toContain("my-secret-provider");
  });

  it("rejecting an invalid trusted-host entry never reflects the entry text", () => {
    const hostile = "evil-reflected-host.example.com/<script>";
    const result = updateTorProxySettings({ trustedLocalHosts: [hostile] }) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).not.toContain("evil-reflected-host");
    expect(result.error).not.toContain("<script>");
  });

  it("allowing a trusted local host logs no hostname", () => {
    const lines = collectLogs();
    updateTorProxySettings({ trustedLocalHosts: ["192.168.1.50"] });
    const check = isAllowedUrl("http://192.168.1.50:3006/api");
    expect(check.allowed).toBe(true);
    expect(check.isLocal).toBe(true);
    expect(lines.join("\n")).not.toContain("192.168.1.50");
  });
});

describe("electrum-client log/error hygiene", () => {
  // Regression target: Electrum pool logs must never contain the
  // user-supplied host:port (private node endpoint) or raw error text, and
  // IPC error payloads must be sanitized stable strings.

  const { registerElectrumHandlers, stopKeepalive, sanitizeServerErrorText } = requireCjs(
    "./electrum-client.cjs",
  ) as {
    registerElectrumHandlers: (ipcMain: { handle: (name: string, fn: Function) => void }) => void;
    stopKeepalive: () => void;
    sanitizeServerErrorText: (text: string) => string | null;
  };

  afterEach(() => {
    stopKeepalive();
    vi.restoreAllMocks();
  });

  it("sanitizeServerErrorText redacts hostnames, IPs, URLs, and paths but keeps plain hints", () => {
    expect(sanitizeServerErrorText("height out of range")).toBe("height out of range");
    expect(sanitizeServerErrorText("index out of range.")).toBe("index out of range");
    expect(sanitizeServerErrorText("cannot reach my-private-node.local right now")).not.toContain(
      "my-private-node.local",
    );
    expect(sanitizeServerErrorText("connect to 10.0.0.5:50001 failed")).not.toContain("10.0.0.5");
    expect(sanitizeServerErrorText("see https://evil.example.com/x")).not.toContain("example.com");
    const pathy = sanitizeServerErrorText("read /home/user/.wallet/secret failed") ?? "";
    expect(pathy).not.toContain("/home");
    expect(pathy).not.toContain(".wallet");
    expect(pathy).not.toContain("secret");
    // Length cap
    expect((sanitizeServerErrorText("a ".repeat(500)) ?? "").length).toBeLessThanOrEqual(200);
  });

  it("sanitizeServerErrorText survives adversarial single-label hosts, IPv6, schemes, and URL paths", () => {
    const url = sanitizeServerErrorText("cannot reach localhost at http://localhost/private-wallet") ?? "";
    expect(url).not.toContain("localhost");
    expect(url).not.toContain("http");
    expect(url).not.toContain("private-wallet");
    const v6 = sanitizeServerErrorText("addr [::1]:50001 refused, also fe80::1%eth0 down") ?? "";
    expect(v6).not.toContain("::1");
    expect(v6).not.toContain("fe80");
    const scheme = sanitizeServerErrorText("socks5 proxy at onion service failed") ?? "";
    expect(scheme).not.toContain("socks5");
    expect(scheme).not.toContain("onion");
    const creds = sanitizeServerErrorText("auth user@host rejected") ?? "";
    expect(creds).not.toContain("user@host");
    // Long opaque blobs (e.g. base64/hex-encoded endpoints) are dropped wholesale.
    const blob = sanitizeServerErrorText(`token ${"a".repeat(64)} invalid`) ?? "";
    expect(blob).not.toContain("a".repeat(31));
    // A message that is nothing but redactions falls back to the generic hint.
    expect(sanitizeServerErrorText("http://10.0.0.5/x")).toBeNull();
  });


  it("connection failure leaks no host/port or raw error into logs or the IPC payload", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    const handlers = new Map<string, Function>();
    registerElectrumHandlers({ handle: (name, fn) => handlers.set(name, fn) });

    const host = "my-private-umbrel.local";
    const port = 50001;
    const result = await handlers.get("electrum-test")!(null, {
      host,
      port,
      useSSL: false,
      timeout: 2000,
    });

    expect(result.success).toBe(false);
    // Sanitized stable string, never the raw socket error (which embeds host/IP)
    expect(result.error).not.toContain(host);
    expect(result.error).not.toContain("ENOTFOUND");
    expect(result.error).not.toContain("getaddrinfo");

    const all = lines.join("\n");
    expect(all).not.toContain(host);
    expect(all).not.toContain(`${port}`);
    expect(all).not.toContain("getaddrinfo");
  }, 15000);
});

describe("electrum certificate trust-decision IPC hygiene", () => {
  // Regression target: TLS trust failures returned over IPC must never embed
  // the configured host:port, raw authorization/verification text, or
  // unsanitized remote-supplied certificate display strings.
  const { _test } = requireCjs("./electrum-client.cjs") as {
    _test: {
      evaluateCertificate: (
        tlsSocket: unknown,
        host: string,
        port: number,
        storePath: string | null,
      ) => { ok: boolean; code?: string; message?: string; certificate?: Record<string, unknown> };
    };
  };

  const HOST = "my-private-node.internal";
  const PORT = 50002;
  const FP = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

  const makeCert = (overrides: Record<string, unknown> = {}) => {
    const cert: Record<string, unknown> = {
      raw: Buffer.from("x"),
      fingerprint256: FP,
      subject: { CN: "unit-test-cn" },
      issuer: { CN: "unit-test-cn" },
      subjectaltname: `DNS:${HOST}`,
      valid_from: "Jan 1 00:00:00 2026 GMT",
      valid_to: "Jan 1 00:00:00 2027 GMT",
      ...overrides,
    };
    cert.issuerCertificate = cert; // structurally self-signed by default
    return cert;
  };
  const makeSocket = (authorizationError: string, cert: unknown) => ({
    authorized: false,
    authorizationError,
    getPeerCertificate: () => cert,
  });

  const expectNoLeak = (decision: { message?: string; certificate?: Record<string, unknown> }) => {
    const text = JSON.stringify(decision);
    expect(text).not.toContain(HOST);
    expect(text).not.toContain(String(PORT));
  };

  it("invalid-chain (non-self-signed) failure uses fixed text with no host or raw auth error", () => {
    const cert = makeCert({ issuer: { CN: "Some CA" }, subjectaltname: undefined });
    (cert as { issuerCertificate?: unknown }).issuerCertificate = undefined;
    const socket = makeSocket(`Hostname/IP does not match certificate's altnames: Host: ${HOST}`, cert);
    const decision = _test.evaluateCertificate(socket, HOST, PORT, null);
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("CERT_INVALID");
    expectNoLeak(decision);
    expect(decision.message).not.toContain("altnames");
    expect(decision.message).not.toContain("unit-test-cn");
  });

  it("untrusted self-signed failure has no host and no raw auth error", () => {
    const socket = makeSocket("DEPTH_ZERO_SELF_SIGNED_CERT", makeCert());
    const decision = _test.evaluateCertificate(socket, HOST, PORT, null);
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("CERT_UNTRUSTED");
    expectNoLeak(decision);
  });

  it("hostile CN/issuer control characters are scrubbed and length-capped before IPC", () => {
    const hostile = "evil\u0000\r\n<CN>" + "A".repeat(500);
    const socket = makeSocket(
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      makeCert({ subject: { CN: hostile }, issuer: { CN: hostile } }),
    );
    const decision = _test.evaluateCertificate(socket, HOST, PORT, null);
    const subject = String(decision.certificate?.subject ?? "");
    expect(subject.length).toBeLessThanOrEqual(128);
    expect(subject).not.toMatch(/[\x00-\x1f\x7f]/);
    expectNoLeak(decision);
  });
});

describe("main-process source hygiene (lint-style regression guard)", () => {
  // main.cjs cannot be required in a test (it needs a live Electron runtime),
  // so guard the leak patterns at the source level: no IPC payload may return
  // raw error.message, no log may print socket.authorizationError (Node's
  // cert-validation text can embed the configured hostname), and tor-test
  // failure payloads must not echo renderer-supplied proxy URLs.

  const sources = [
    "main.cjs",
    "tor-proxy.cjs",
    "electrum-client.cjs",
    "file-handlers.cjs",
    "engine-handlers.cjs",
  ].map(
    (name) => {
      const { readFileSync } = requireCjs("node:fs") as typeof import("node:fs");
      const { fileURLToPath } = requireCjs("node:url") as typeof import("node:url");
      const { dirname, join } = requireCjs("node:path") as typeof import("node:path");
      const dir = dirname(fileURLToPath(import.meta.url));
      return { name, src: readFileSync(join(dir, name), "utf8") };
    },
  );

  it.each(sources.map((s) => [s.name, s.src] as const))(
    "%s never puts raw error.message into an IPC payload",
    (_name, src) => {
      expect(src).not.toMatch(/error:\s*(?:error|err|e)\.message/);
    },
  );

  it("electrum-client.cjs never logs socket.authorizationError", () => {
    const src = sources.find((s) => s.name === "electrum-client.cjs")!.src;
    expect(src).not.toMatch(/console\.\w+\([^\n]*authorizationError/);
  });

  it("main.cjs tor-test failure payload reports proxy names, not URLs", () => {
    const src = sources.find((s) => s.name === "main.cjs")!.src;
    expect(src).not.toMatch(/testedProxies:\s*proxiesToTest\.map\(\s*p\s*=>\s*p\.url\s*\)/);
  });

  it("main.cjs tor-status/tor-test results never include proxy URLs", () => {
    const src = sources.find((s) => s.name === "main.cjs")!.src;
    expect(src).not.toMatch(/url:\s*proxy\.url/);
    expect(src).not.toMatch(/proxyUrl:\s*proxy\.url/);
  });

  it("IPC payloads never carry absolute filesystem paths", () => {
    const fileHandlers = sources.find((s) => s.name === "file-handlers.cjs")!.src;
    // Path-returning channels were removed / redacted; guard their shapes.
    expect(fileHandlers).not.toContain("get-app-data-path");
    expect(fileHandlers).not.toContain("get-data-path");
    expect(fileHandlers).not.toContain("get-attachments-path");
    expect(fileHandlers).not.toContain("get-needs-review-path");
    expect(fileHandlers).not.toMatch(/savedPath:\s*dest/);
    expect(fileHandlers).not.toMatch(/path:\s*found\.filePath/);
    expect(fileHandlers).not.toMatch(/return\s*\{[^}]*filePath:\s*result\.filePath/);
    const engineHandlers = sources.find((s) => s.name === "engine-handlers.cjs")!.src;
    expect(engineHandlers).not.toMatch(/dbInfo'.*dbPath/s);
  });

  it("check-demo-vault presence payload exposes no path (live handler)", async () => {
    const os = requireCjs("node:os") as typeof import("node:os");
    const fsMod = requireCjs("node:fs") as typeof import("node:fs");
    const pathMod = requireCjs("node:path") as typeof import("node:path");
    const tmp = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "kyutxo-ipc-test-"));
    const { registerFileHandlers } = requireCjs("./file-handlers.cjs") as {
      registerFileHandlers: (
        ipcMain: { handle: (name: string, fn: Function) => void },
        dirs: Record<string, unknown>,
      ) => void;
    };
    const handlers = new Map<string, Function>();
    registerFileHandlers(
      { handle: (name, fn) => handlers.set(name, fn) },
      {
        dataDir: tmp,
        attachmentsDir: pathMod.join(tmp, "attachments"),
        needsReviewDir: pathMod.join(tmp, "needs-review"),
        portableMode: false,
      },
    );
    const result = await handlers.get("check-demo-vault")!(null);
    expect(result).not.toHaveProperty("path");
    expect(JSON.stringify(result)).not.toContain(tmp);
    fsMod.rmSync(tmp, { recursive: true, force: true });
  });

  it("engine-handlers.cjs never logs the db path or raw worker errors", () => {
    const src = sources.find((s) => s.name === "engine-handlers.cjs")!.src;
    expect(src).not.toMatch(/console\.\w+\([^\n]*dbPath/);
    // Raw err objects/messages must go through logMainError, not console.
    expect(src).not.toMatch(/console\.error\([^\n]*,\s*err\s*\)/);
    expect(src).not.toMatch(/String\(err\)/);
  });

  it("main.cjs never logs absolute data/index paths or raw load errors", () => {
    const src = sources.find((s) => s.name === "main.cjs")!.src;
    expect(src).not.toMatch(/console\.\w+\([^\n]*dataDir/);
    expect(src).not.toMatch(/console\.\w+\([^\n]*indexPath/);
    expect(src).not.toMatch(/console\.\w+\([^\n]*portableDir/);
    expect(src).not.toMatch(/console\.\w+\([^\n]*getPath\(\s*['"]userData['"]\s*\)/);
    // Fallback error page must not render raw error text or paths.
    expect(src).not.toMatch(/escapeHtml\(\s*err\.message\s*\)/);
    expect(src).not.toMatch(/escapeHtml\(\s*indexPath\s*\)/);
    expect(src).not.toMatch(/escapeHtml\(\s*app\.getAppPath\(\)\s*\)/);
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
  ])("rejects malformed input: %s", (_label, input) => {
    expect(torRequestSchema.safeParse(input).success).toBe(false);
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
