import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";

import express from "express";

import { app, errorMiddleware, requestLogger } from "./app";
import { toContentDisposition } from "./attachments";

// Guards for the API error/logging hygiene contract:
//  - production clients get generic 5xx messages (no fs paths / OS detail)
//  - the error middleware never rethrows after responding (process crash)
//  - the request logger never serializes response bodies
//  - download filenames are Content-Disposition header-safe

function mockReqAppEnv(env: string) {
  return { method: "GET", path: "/api/x", app: { get: () => env } } as any;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorMiddleware", () => {
  it("returns a generic message for 5xx in production", () => {
    const res = mockRes();
    errorMiddleware(
      new Error("ENOENT: no such file or directory, open '/home/user/secret/ledger.db'"),
      mockReqAppEnv("production"),
      res,
      vi.fn(),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe("Internal Server Error");
    expect(JSON.stringify(res.body)).not.toContain("/home/user");
  });

  it("keeps internal detail in development", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();
    errorMiddleware(
      new Error("ENOENT: /home/user/secret"),
      mockReqAppEnv("development"),
      res,
      vi.fn(),
    );
    expect(res.body.message).toContain("ENOENT");
  });

  it("passes through intentional 4xx messages in production", () => {
    const res = mockRes();
    const err = Object.assign(new Error("Access denied"), { status: 403 });
    errorMiddleware(err, mockReqAppEnv("production"), res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe("Access denied");
  });

  it("honours statusCode as well as status", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();
    const err = Object.assign(new Error("boom"), { statusCode: 503 });
    errorMiddleware(err, mockReqAppEnv("production"), res, vi.fn());
    expect(res.statusCode).toBe(503);
    expect(res.body.message).toBe("Internal Server Error");
  });

  it("never rethrows after the response is sent", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();
    expect(() =>
      errorMiddleware(new Error("boom"), mockReqAppEnv("production"), res, vi.fn()),
    ).not.toThrow();
  });

  it("logs 5xx detail server-side only", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();
    errorMiddleware(new Error("boom"), mockReqAppEnv("production"), res, vi.fn());
    expect(spy).toHaveBeenCalledOnce();
    expect(res.body.message).toBe("Internal Server Error");
  });
});

describe("requestLogger", () => {
  function fakeReqRes(path: string) {
    const req = { method: "GET", path } as any;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      json(payload: any) {
        return res;
      },
    }) as any;
    return { req, res };
  }

  it("logs method/path/status/duration but never the response body", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { req, res } = fakeReqRes("/api/tor/status");
    requestLogger(req, res, vi.fn());
    res.json({ proxyUrl: "socks5h://10.0.0.9:9050", secret: "hunter2" });
    res.emit("finish");
    const line = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("GET /api/tor/status 200");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("socks5h://10.0.0.9");
  });

  it("ignores non-API routes", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { req, res } = fakeReqRes("/assets/index.js");
    requestLogger(req, res, vi.fn());
    res.emit("finish");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("nosniff on parser-rejected requests", () => {
  it("malformed JSON still gets X-Content-Type-Options (header middleware runs before parsers)", async () => {
    // Exercise the REAL middleware ordering from server/app.ts: if the header
    // middleware were registered after express.json(), body-parser's 400 would
    // jump to error dispatch and the response would lack nosniff.
    app.post("/api/__hygiene_echo", (req, res) => res.json({ ok: true }));
    app.use(errorMiddleware);

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/api/__hygiene_echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("toContentDisposition", () => {
  it("passes a plain filename through", () => {
    expect(toContentDisposition("receipt.pdf")).toBe(
      'attachment; filename="receipt.pdf"; filename*=UTF-8\'\'receipt.pdf',
    );
  });

  it("neutralizes quotes and backslashes in the fallback name", () => {
    const value = toContentDisposition('evil";injection="x\\.pdf');
    const fallback = value.match(/filename="([^"]*)"/)![1];
    expect(fallback).not.toContain('"');
    expect(fallback).not.toContain("\\");
  });

  it("strips CR/LF so the header cannot be injected", () => {
    const value = toContentDisposition("a\r\nX-Injected: yes.pdf");
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
  });

  it("RFC-5987-encodes non-ASCII names and ASCII-folds the fallback", () => {
    const value = toContentDisposition("証明書.pdf");
    expect(value).toContain("filename*=UTF-8''%E8%A8%BC%E6%98%8E%E6%9B%B8.pdf");
    const fallback = value.match(/filename="([^"]*)"/)![1];
    // eslint-disable-next-line no-control-regex
    expect(fallback).toMatch(/^[\x20-\x7e]*$/);
  });
});
