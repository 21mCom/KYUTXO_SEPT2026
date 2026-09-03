// @vitest-environment node
//
// Transport-level proof that server-side "proxied" requests actually traverse
// the configured SOCKS proxy. The endpoint tests stub fetch, so they cannot
// catch a transport that ignores the proxy agent (undici's global fetch does
// exactly that). These tests use the REAL node-fetch implementation, a real
// in-process SOCKS5 server, and a real HTTP target.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeProxiedRequest } from "./tor-proxy";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server | net.Server): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      // Force-close keep-alive sockets so close() settles promptly.
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
}

// Minimal SOCKS5 (no-auth) proxy: completes the handshake, CONNECTs to the
// requested destination, then pipes bytes. Counts client connections so tests
// can prove the request went through it.
async function startSocksServer(): Promise<{
  port: number;
  connectionCount: () => number;
  requestedHosts: () => string[];
}> {
  let connections = 0;
  const hosts: string[] = [];
  const server = net.createServer((socket) => {
    connections++;
    let stage: "greeting" | "request" | "done" = "greeting";
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      // Once the tunnel is established, piped bytes must pass through
      // untouched — never re-parse them as SOCKS frames.
      if (stage === "done") return;
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        // VER=5, NMETHODS, METHODS... → choose "no authentication" (0x00)
        socket.write(Buffer.from([0x05, 0x00]));
        buffer = buffer.subarray(2 + buffer[1]);
        stage = "request";
      }

      if (stage === "request") {
        // VER CMD RSV ATYP DST.ADDR DST.PORT
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let host: string;
        let headerLen: number;
        if (atyp === 0x01) {
          if (buffer.length < 10) return;
          host = Array.from(buffer.subarray(4, 8)).join(".");
          headerLen = 10;
        } else if (atyp === 0x03) {
          const domainLen = buffer[4];
          if (buffer.length < 7 + domainLen) return;
          host = buffer.subarray(5, 5 + domainLen).toString("utf8");
          headerLen = 7 + domainLen;
        } else {
          socket.destroy();
          return;
        }
        const port = buffer.readUInt16BE(headerLen - 2);
        hosts.push(host);

        // remote-dns.example is intentionally not locally resolvable. Map it
        // inside this fake SOCKS server to prove the client sent the domain
        // name through SOCKS instead of resolving it before the handshake.
        const connectHost = host === "remote-dns.example" ? "127.0.0.1" : host;
        const upstream = net.connect(port, connectHost, () => {
          // Success reply: VER REP=0 RSV ATYP=IPv4 BND.ADDR BND.PORT
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        stage = "done";
      }
    });
    socket.on("error", () => {});
  });

  const port = await listen(server);
  cleanups.push(close(server));
  return {
    port,
    connectionCount: () => connections,
    requestedHosts: () => [...hosts],
  };
}

// Real HTTP target counting hits — the no-direct-egress oracle.
async function startHttpTarget(): Promise<{ port: number; hitCount: () => number }> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  cleanups.push(close(server));
  return { port, hitCount: () => hits };
}

describe("tor proxy transport", () => {
  it("routes proxied requests through the SOCKS proxy, not directly", async () => {
    const socks = await startSocksServer();
    const target = await startHttpTarget();

    const result = await makeProxiedRequest({
      url: `http://127.0.0.1:${target.port}/api/test`,
      torProxyUrl: `socks5h://127.0.0.1:${socks.port}`,
      timeout: 10000,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    // The request reached the target via the proxy's forwarded connection...
    expect(target.hitCount()).toBe(1);
    // ...and the SOCKS server actually received a client connection.
    expect(socks.connectionCount()).toBe(1);
  });

  it("sends destination hostnames to the SOCKS proxy for remote DNS resolution", async () => {
    const socks = await startSocksServer();
    const target = await startHttpTarget();

    const result = await makeProxiedRequest({
      url: `http://remote-dns.example:${target.port}/api/test`,
      // Legacy persisted values are accepted only by upgrading the scheme
      // before SocksProxyAgent sees it.
      torProxyUrl: `socks5://127.0.0.1:${socks.port}`,
      timeout: 10000,
    });

    expect(result.success).toBe(true);
    expect(target.hitCount()).toBe(1);
    expect(socks.requestedHosts()).toContain("remote-dns.example");
  });

  it("never falls back to a direct connection when the SOCKS proxy is unreachable", async () => {
    const target = await startHttpTarget();

    const result = await makeProxiedRequest({
      url: `http://127.0.0.1:${target.port}/api/test`,
      torProxyUrl: "socks5h://127.0.0.1:1", // nothing listening
      timeout: 10000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Cannot connect to the Tor proxy/);
    // The decisive assertion: if the transport had ignored the agent (undici
    // behavior), the request would have reached the target directly (200).
    expect(target.hitCount()).toBe(0);
  });
});
