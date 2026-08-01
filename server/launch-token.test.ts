import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  LAUNCH_TOKEN,
  LAUNCH_TOKEN_HEADER,
  injectLaunchToken,
  launchTokenMetaTag,
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
