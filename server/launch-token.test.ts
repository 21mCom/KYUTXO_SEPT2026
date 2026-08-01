import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  LAUNCH_TOKEN,
  LAUNCH_TOKEN_HEADER,
  injectLaunchToken,
  isAllowedHost,
  launchTokenMetaTag,
  rejectUnknownHosts,
  requireLaunchToken,
} from "./launch-token";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startGuardedApp(): Promise<string> {
  const app = express();
  app.use("/api", requireLaunchToken);
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.on("listening", resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("requireLaunchToken middleware", () => {
  it("rejects requests without the token header", async () => {
    const base = await startGuardedApp();
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong token", async () => {
    const base = await startGuardedApp();
    const res = await fetch(`${base}/api/ping`, {
      headers: { [LAUNCH_TOKEN_HEADER]: "wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token that only differs by length prefix tricks", async () => {
    const base = await startGuardedApp();
    const res = await fetch(`${base}/api/ping`, {
      headers: { [LAUNCH_TOKEN_HEADER]: LAUNCH_TOKEN.slice(1) },
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests carrying the launch token", async () => {
    const base = await startGuardedApp();
    const res = await fetch(`${base}/api/ping`, {
      headers: { [LAUNCH_TOKEN_HEADER]: LAUNCH_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("generates a high-entropy per-launch token by default", () => {
    expect(LAUNCH_TOKEN.length).toBeGreaterThanOrEqual(32);
  });
});

describe("isAllowedHost (DNS-rebinding defense)", () => {
  const savedReplId = process.env.REPL_ID;
  afterEach(() => {
    if (savedReplId === undefined) delete process.env.REPL_ID;
    else process.env.REPL_ID = savedReplId;
  });

  it("allows loopback hostnames with and without ports", () => {
    expect(isAllowedHost("localhost")).toBe(true);
    expect(isAllowedHost("localhost:5000")).toBe(true);
    expect(isAllowedHost("127.0.0.1")).toBe(true);
    expect(isAllowedHost("127.0.0.1:5000")).toBe(true);
    expect(isAllowedHost("[::1]")).toBe(true);
    expect(isAllowedHost("[::1]:5000")).toBe(true);
    expect(isAllowedHost("LOCALHOST:5000")).toBe(true);
  });

  it("rejects rebound / arbitrary hostnames", () => {
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost("")).toBe(false);
    expect(isAllowedHost("attacker.com")).toBe(false);
    expect(isAllowedHost("attacker.com:5000")).toBe(false);
    expect(isAllowedHost("localhost.attacker.com")).toBe(false);
    expect(isAllowedHost("127.0.0.1.attacker.com")).toBe(false);
    expect(isAllowedHost("evillocalhost")).toBe(false);
    // Unbracketed junk that merely contains loopback-ish text
    expect(isAllowedHost("[::1].attacker.com")).toBe(false);
  });

  it("rejects malformed port suffixes that smuggle a hostname", () => {
    expect(isAllowedHost("localhost:5000.attacker.com")).toBe(false);
    expect(isAllowedHost("127.0.0.1:5000.attacker.com")).toBe(false);
    expect(isAllowedHost("[::1]:5000.attacker.com")).toBe(false);
    expect(isAllowedHost("[::1]:attacker.com")).toBe(false);
    expect(isAllowedHost("localhost:attacker.com")).toBe(false);
    expect(isAllowedHost("localhost:")).toBe(false);
    expect(isAllowedHost("[::1]:")).toBe(false);
    expect(isAllowedHost("127.0.0.1:65536x")).toBe(false);
  });

  it("allows .replit.dev only when REPL_ID is set", () => {
    delete process.env.REPL_ID;
    expect(isAllowedHost("my-app.replit.dev")).toBe(false);
    process.env.REPL_ID = "test-repl";
    expect(isAllowedHost("my-app.replit.dev")).toBe(true);
    expect(isAllowedHost("my-app.replit.dev:443")).toBe(true);
    expect(isAllowedHost("evil-replit.dev")).toBe(false);
    expect(isAllowedHost("replit.dev.attacker.com")).toBe(false);
  });
});

describe("rejectUnknownHosts middleware", () => {
  async function startHostGuardedApp(): Promise<string> {
    const app = express();
    app.use(rejectUnknownHosts);
    app.get("/api/ping", (_req, res) => res.json({ ok: true }));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.on("listening", resolve));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("serves requests with a loopback Host header", async () => {
    const base = await startHostGuardedApp();
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects requests with a rebound Host header", async () => {
    // undici's fetch silently drops a custom Host header, so issue the raw
    // request with node:http to actually simulate the rebound hostname.
    const base = await startHostGuardedApp();
    const { port } = server!.address() as AddressInfo;
    const http = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/ping",
          headers: { Host: "attacker.com" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    void base;
  });
});

describe("injectLaunchToken", () => {
  it("injects the meta tag into <head>", () => {
    const html = injectLaunchToken("<html>\n  <head>\n    <title>x</title>\n  </head>\n</html>", "tok123");
    expect(html).toContain('<meta name="kyutxo-launch-token" content="tok123" />');
    expect(html.indexOf("kyutxo-launch-token")).toBeLessThan(html.indexOf("<title>"));
  });

  it("escapes HTML-significant characters in the token", () => {
    const tag = launchTokenMetaTag('a"b<c>&d');
    expect(tag).toContain("a&quot;b&lt;c&gt;&amp;d");
    expect(tag).not.toContain('a"b<c>&d');
  });

  it("falls back to prepending when no <head> exists", () => {
    const html = injectLaunchToken("<div>bare</div>", "tok");
    expect(html.startsWith('<meta name="kyutxo-launch-token"')).toBe(true);
  });
});
