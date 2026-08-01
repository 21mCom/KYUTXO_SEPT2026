import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// End-to-end Node-level tests for the Electrum transport security work:
//   - TLS connections must VERIFY the server certificate (no more blanket
//     rejectUnauthorized:false acceptance). Self-signed certs require an
//     explicit persisted TOFU pin; a changed fingerprint (MITM) is a hard
//     error, never silently accepted data.
//   - useTor routes the Electrum socket through the configured SOCKS proxy
//     (incl. .onion hosts via remote resolution), and pooled connections are
//     keyed per-transport so a direct socket is never reused for Tor.
// Uses a local fake Electrum JSON-RPC server (TCP + TLS variants) and a
// minimal in-test SOCKS5 proxy.

const requireCjs = createRequire(import.meta.url);

const FIXTURES = path.join(__dirname, "test-fixtures", "electrum-tls");
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

const SELFSIGNED_A = { key: readFixture("selfsigned-a.key"), cert: readFixture("selfsigned-a.crt") };
const SELFSIGNED_B = { key: readFixture("selfsigned-b.key"), cert: readFixture("selfsigned-b.crt") };
const SELFSIGNED_WRONGHOST = {
  key: readFixture("selfsigned-wronghost.key"),
  cert: readFixture("selfsigned-wronghost.crt"),
};
const CA_CERT = readFixture("ca.crt");
const CA_SIGNED = { key: readFixture("ca-signed.key"), cert: readFixture("ca-signed.crt") };

type Handler = (event: unknown, arg: unknown) => unknown;
class FakeIpcMain {
  private handlers = new Map<string, Handler>();
  handle(channel: string, fn: Handler) {
    this.handlers.set(channel, fn);
  }
  invoke(channel: string, arg?: unknown): Promise<any> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for ${channel}`);
    return Promise.resolve(fn({}, arg));
  }
}

// Fake Electrum server: answers server.version / server.ping /
// blockchain.headers.subscribe for any socket-like stream.
function handleElectrumStream(socket: net.Socket) {
  let buffer = "";
  socket.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let req: any;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      let result: unknown = null;
      if (req.method === "server.version") result = ["FakeElectrum 1.0", "1.4"];
      else if (req.method === "blockchain.headers.subscribe") result = { height: 840000 };
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
    }
  });
}

// server.close() only stops ACCEPTING new connections — pooled Electrum
// sockets stay open and would hang the close callback. Track every live
// socket per server so closeServer can destroy them first.
const liveSockets = new Map<net.Server | tls.Server, Set<net.Socket>>();

function trackSockets(server: net.Server | tls.Server) {
  const sockets = new Set<net.Socket>();
  liveSockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // tls.Server also emits secureConnection for the upgraded socket.
  server.on("secureConnection" as any, (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
}

function startTcpElectrumServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer(handleElectrumStream);
    trackSockets(server);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as net.AddressInfo).port }),
    );
  });
}

function startTlsElectrumServer(
  credentials: { key: string; cert: string },
  port = 0,
): Promise<{ server: tls.Server; port: number }> {
  return new Promise((resolve) => {
    const server = tls.createServer(credentials, handleElectrumStream);
    trackSockets(server);
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as net.AddressInfo).port }),
    );
  });
}

async function closeServer(server: net.Server | tls.Server): Promise<void> {
  const sockets = liveSockets.get(server);
  if (sockets) {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Minimal SOCKS5 no-auth proxy. It honors the CONNECT handshake, records the
// requested destination, then pipes to a FIXED upstream regardless of the
// requested host — so tests can request an unresolvable .onion name and prove
// the client sent it for REMOTE resolution (the defining socks5h behavior).
interface SocksRequest {
  host: string;
  port: number;
  atyp: number;
}
function startSocks5Proxy(upstreamPort: number): Promise<{
  server: net.Server;
  port: number;
  requests: SocksRequest[];
}> {
  const requests: SocksRequest[] = [];
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      const tracked = liveSockets.get(server);
      if (tracked) {
        tracked.add(client);
        client.on("close", () => tracked.delete(client));
      }
      client.once("data", () => {
        client.write(Buffer.from([0x05, 0x00])); // no-auth accepted
        client.once("data", (req) => {
          const atyp = req[3];
          let host = "";
          let offset = 0;
          if (atyp === 1) {
            host = Array.from(req.slice(4, 8)).join(".");
            offset = 8;
          } else if (atyp === 3) {
            const len = req[4];
            host = req.slice(5, 5 + len).toString();
            offset = 5 + len;
          } else {
            client.destroy();
            return;
          }
          const port = req.readUInt16BE(offset);
          requests.push({ host, port, atyp });
          const upstream = net.connect(upstreamPort, "127.0.0.1", () => {
            // success reply
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("error", () => client.destroy());
        });
      });
    });
    trackSockets(server);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as net.AddressInfo).port, requests }),
    );
  });
}

let mod: {
  registerElectrumHandlers: (ipcMain: FakeIpcMain, opts?: { dataDir?: string }) => void;
  stopKeepalive: () => void;
  _test: {
    electrumPool: { connections: Map<string, any> };
    poolKey: (host: string, port: number, useSSL: boolean, options?: any) => string;
    evaluateCertificate: (socket: any, host: string, port: number, storePath: string | null) => any;
    createElectrumConnection: (
      host: string,
      port: number,
      useSSL: boolean,
      timeout?: number,
      options?: any,
    ) => Promise<net.Socket>;
    getTrustStorePath: () => string | null;
  };
};
let certStore: {
  trustCertificate: (filePath: string, host: string, port: number, certInfo: any) => any;
  getPinnedCertificate: (filePath: string, host: string, port: number) => any;
  loadTrustStore: (filePath: string) => any;
  certStorePath: (dataDir: string) => string;
  revokeCertificate: (filePath: string, host: string, port: number) => boolean;
};
let ipc: FakeIpcMain;
let dataDir: string;

beforeAll(async () => {
  mod = requireCjs("./electrum-client.cjs");
  certStore = requireCjs("./electrum-cert-store.cjs");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "electrum-tls-test-"));
  ipc = new FakeIpcMain();
  mod.registerElectrumHandlers(ipc, { dataDir });
});

afterAll(async () => {
  mod.stopKeepalive();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

describe("Electrum TLS: self-signed certificates require explicit trust (TOFU)", () => {
  let tlsServer: tls.Server;
  let tlsPort: number;

  beforeAll(async () => {
    ({ server: tlsServer, port: tlsPort } = await startTlsElectrumServer(SELFSIGNED_A));
  });

  afterAll(async () => {
    await closeServer(tlsServer);
  });

  it("rejects a self-signed certificate with CERT_UNTRUSTED instead of silently accepting it", async () => {
    const result = await ipc.invoke("electrum-test", {
      host: "127.0.0.1",
      port: tlsPort,
      useSSL: true,
      timeout: 5000,
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("CERT_UNTRUSTED");
    expect(result.error).toMatch(/not signed by a trusted certificate authority/);
    expect(result.certificate?.fingerprint).toMatch(FINGERPRINT_RE);
    expect(result.certificate?.trust).toBeUndefined();
  });

  it("connects after the user pins the certificate fingerprint", async () => {
    const failed = await ipc.invoke("electrum-test", {
      host: "127.0.0.1",
      port: tlsPort,
      useSSL: true,
      timeout: 5000,
    });
    expect(failed.success).toBe(false);

    const trust = await ipc.invoke("electrum-trust-certificate", {
      host: "127.0.0.1",
      port: tlsPort,
      certificate: failed.certificate,
    });
    expect(trust.success).toBe(true);
    expect(trust.pinned.fingerprint).toBe(failed.certificate.fingerprint);

    const result = await ipc.invoke("electrum-test", {
      host: "127.0.0.1",
      port: tlsPort,
      useSSL: true,
      timeout: 5000,
    });
    expect(result.success).toBe(true);
    expect(result.blockHeight).toBe(840000);
    expect(result.transport).toBe("direct");
    expect(result.certificate?.trust).toBe("pinned");
    expect(result.certificate?.fingerprint).toBe(failed.certificate.fingerprint);
  });

  it("refuses a forged trust IPC payload — renderer metadata is never trusted", async () => {
    // No observation exists for this host:port at all.
    const noObservation = await ipc.invoke("electrum-trust-certificate", {
      host: "203.0.113.9",
      port: 59999,
      certificate: {
        fingerprint: "11:22:33",
        subject: "leaf.example.com",
        issuer: "leaf.example.com",
        selfSigned: true, // forged flag — must be ignored
      },
    });
    expect(noObservation.success).toBe(false);
    expect(noObservation.error).toMatch(/No recent untrusted-certificate observation/);

    // A REAL observation exists (self-signed server just refused as
    // untrusted), but the renderer sends a DIFFERENT fingerprint.
    const { server, port } = await startTlsElectrumServer(SELFSIGNED_B);
    try {
      await expect(
        mod._test.createElectrumConnection("127.0.0.1", port, true, 5000, {}),
      ).rejects.toMatchObject({ code: "CERT_UNTRUSTED" });

      const forged = await ipc.invoke("electrum-trust-certificate", {
        host: "127.0.0.1",
        port,
        certificate: { fingerprint: "DE:AD:BE:EF", subject: "forged", issuer: "forged", selfSigned: true },
      });
      expect(forged.success).toBe(false);
      expect(forged.error).toMatch(/does not match/);

      const trust = await ipc.invoke("electrum-get-certificate-trust", { host: "127.0.0.1", port });
      expect(trust.pinned).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it("reports the pinned certificate via electrum-get-certificate-trust", async () => {
    const result = await ipc.invoke("electrum-get-certificate-trust", {
      host: "127.0.0.1",
      port: tlsPort,
    });
    expect(result.success).toBe(true);
    expect(result.pinned?.fingerprint).toMatch(FINGERPRINT_RE);
    expect(typeof result.pinned?.trustedAt).toBe("number");
  });

  it("rejects a changed certificate as CERT_FINGERPRINT_CHANGED (MITM is never silently accepted)", async () => {
    // Swap the server's certificate for a DIFFERENT self-signed cert on the
    // same host:port — the classic MITM shape.
    await closeServer(tlsServer);
    // The previous test's pooled connection is now dead; drop it from the
    // pool deterministically so the next test opens a FRESH socket and hits
    // the certificate check instead of a stale-socket error.
    for (const [, conn] of mod._test.electrumPool.connections) {
      try { conn.socket.destroy(); } catch { /* ignore */ }
    }
    mod._test.electrumPool.connections.clear();
    ({ server: tlsServer, port: tlsPort } = await startTlsElectrumServer(SELFSIGNED_B, tlsPort));

    const result = await ipc.invoke("electrum-test", {
      host: "127.0.0.1",
      port: tlsPort,
      useSSL: true,
      timeout: 5000,
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("CERT_FINGERPRINT_CHANGED");
    expect(result.error).toMatch(/man-in-the-middle/);
    expect(result.certificate?.expectedFingerprint).toMatch(FINGERPRINT_RE);
    expect(result.certificate?.fingerprint).toMatch(FINGERPRINT_RE);
    expect(result.certificate?.fingerprint).not.toBe(result.certificate?.expectedFingerprint);

    // Restore cert A (still pinned) so later tests see a consistent state.
    await closeServer(tlsServer);
    ({ server: tlsServer, port: tlsPort } = await startTlsElectrumServer(SELFSIGNED_A, tlsPort));
  });

  it("strictly rejects a self-signed certificate for the WRONG host — before AND after pinning", async () => {
    // Node reports DEPTH_ZERO_SELF_SIGNED_CERT before hostname mismatches, so
    // without an independent identity check this cert would slip into the
    // TOFU path. It must be CERT_INVALID both ways.
    const { server, port } = await startTlsElectrumServer(SELFSIGNED_WRONGHOST);
    try {
      await expect(
        mod._test.createElectrumConnection("127.0.0.1", port, true, 5000, {}),
      ).rejects.toMatchObject({ code: "CERT_INVALID" });

      const wrongHostFingerprint = new (requireCjs("node:crypto").X509Certificate)(
        SELFSIGNED_WRONGHOST.cert,
      ).fingerprint256;
      certStore.trustCertificate(mod._test.getTrustStorePath(), "127.0.0.1", port, {
        fingerprint: wrongHostFingerprint,
      });
      await expect(
        mod._test.createElectrumConnection("127.0.0.1", port, true, 5000, {}),
      ).rejects.toMatchObject({ code: "CERT_INVALID" });
    } finally {
      await closeServer(server);
    }
  });

  it("fails closed when no trust store is configured", () => {
    const selfSignedCert: any = {
      raw: Buffer.from("raw"),
      fingerprint256: "AA:BB",
      subject: { CN: "example.com" },
      issuer: { CN: "example.com" },
    };
    selfSignedCert.issuerCertificate = selfSignedCert; // self-referential
    const decision = mod._test.evaluateCertificate(
      {
        authorized: false,
        authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT",
        getPeerCertificate: () => selfSignedCert,
      },
      "example.com",
      50002,
      null, // no store -> pinning impossible -> reject
    );
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("CERT_UNTRUSTED");
  });
});

describe("Electrum TLS: CA-signed certificates verify strictly (no prompt needed)", () => {
  it("accepts a CA-signed certificate when the CA is trusted, marked as 'ca'", async () => {
    const { server, port } = await startTlsElectrumServer(CA_SIGNED);
    try {
      const socket = await mod._test.createElectrumConnection("localhost", port, true, 5000, {
        ca: CA_CERT,
      });
      expect((socket as any).electrumCertificate?.trust).toBe("ca");
      expect((socket as any).electrumCertificate?.fingerprint).toMatch(FINGERPRINT_RE);
      socket.destroy();
    } finally {
      await closeServer(server);
    }
  });

  it("rejects the same CA-signed certificate WITHOUT the CA in the trust chain — and a pin cannot downgrade it", async () => {
    const { server, port } = await startTlsElectrumServer(CA_SIGNED);
    try {
      // Untrusted-CA chain failure is not a self-signed failure, so the
      // connection is strictly rejected with CERT_INVALID (not the TOFU
      // prompt code CERT_UNTRUSTED).
      await expect(
        mod._test.createElectrumConnection("localhost", port, true, 5000, {}),
      ).rejects.toMatchObject({ code: "CERT_INVALID" });

      // Even with a pin pre-written to the store for this exact fingerprint,
      // strict verification still rejects: TOFU never downgrades CA checks.
      const leafFingerprint = new (requireCjs("node:crypto").X509Certificate)(CA_SIGNED.cert).fingerprint256;
      certStore.trustCertificate(mod._test.getTrustStorePath(), "localhost", port, {
        fingerprint: leafFingerprint,
      });
      await expect(
        mod._test.createElectrumConnection("localhost", port, true, 5000, {}),
      ).rejects.toMatchObject({ code: "CERT_INVALID" });
    } finally {
      await closeServer(server);
    }
  });

  it("rejects an untrusted PRIVATE-CA chain (SELF_SIGNED_CERT_IN_CHAIN) — never TOFU-eligible, even with a pin", async () => {
    // Server presents a CA-issued leaf PLUS its self-signed private root.
    // Node reports SELF_SIGNED_CERT_IN_CHAIN, which must NOT enter the TOFU
    // path: the leaf itself is not self-signed.
    const { server, port } = await startTlsElectrumServer({
      key: CA_SIGNED.key,
      cert: CA_SIGNED.cert + CA_CERT, // leaf first, then the self-signed root
    });
    try {
      await expect(
        mod._test.createElectrumConnection("localhost", port, true, 5000, {}),
      ).rejects.toMatchObject({ code: "CERT_INVALID" });

      const leafFingerprint = new (requireCjs("node:crypto").X509Certificate)(CA_SIGNED.cert).fingerprint256;
      certStore.trustCertificate(mod._test.getTrustStorePath(), "localhost", port, {
        fingerprint: leafFingerprint,
      });
      await expect(
        mod._test.createElectrumConnection("localhost", port, true, 5000, {}),
      ).rejects.toMatchObject({ code: "CERT_INVALID" });
    } finally {
      await closeServer(server);
    }
  });

  it("strictly rejects expired, hostname-mismatched, and untrusted-CA certs even with a pre-existing pin", () => {
    // A pin exists in a temp store for the exact fingerprint the server
    // presents in each scenario below.
    const tmpStore = path.join(dataDir, "strict-reject-store.json");
    const cases: Array<{ name: string; authError: string; selfSigned: boolean }> = [
      { name: "expired self-signed", authError: "CERT_HAS_EXPIRED", selfSigned: true, cn: "example.com" },
      { name: "hostname mismatch", authError: "ERR_TLS_CERT_ALTNAME_INVALID", selfSigned: false, cn: "other-host.example" },
      { name: "untrusted CA", authError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", selfSigned: false, cn: "example.com" },
      { name: "private-CA chain", authError: "SELF_SIGNED_CERT_IN_CHAIN", selfSigned: false, cn: "example.com" },
    ];
    for (const c of cases) {
      const fingerprint = `AA:BB:CC:${c.name.length.toString().padStart(2, "0")}`;
      certStore.trustCertificate(tmpStore, "example.com", 50002, { fingerprint });
      const cert: any = {
        raw: Buffer.from("raw"),
        fingerprint256: fingerprint,
        subject: { CN: c.cn },
        issuer: c.selfSigned ? { CN: c.cn } : { CN: "Some Other CA" },
      };
      if (c.selfSigned) cert.issuerCertificate = cert;
      const decision = mod._test.evaluateCertificate(
        {
          authorized: false,
          authorizationError: c.authError,
          getPeerCertificate: () => cert,
        },
        "example.com",
        50002,
        tmpStore,
      );
      expect(decision.ok, `${c.name} must be rejected despite the pin`).toBe(false);
      expect(decision.code, c.name).toBe("CERT_INVALID");
    }
  });

  it("evaluateCertificate accepts an authorized (CA-verified) socket without any pin", () => {
    const decision = mod._test.evaluateCertificate(
      {
        authorized: true,
        getPeerCertificate: () => ({
          raw: Buffer.from("raw"),
          fingerprint256: "11:22",
          subject: { CN: "mempool.space" },
          issuer: { CN: "Some CA" },
        }),
      },
      "mempool.space",
      50002,
      null,
    );
    expect(decision.ok).toBe(true);
    expect(decision.certificate.trust).toBe("ca");
  });
});

describe("Electrum over Tor (SOCKS routing)", () => {
  let plain: { server: net.Server; port: number };
  let socks: { server: net.Server; port: number; requests: SocksRequest[] };

  beforeAll(async () => {
    plain = await startTcpElectrumServer();
    socks = await startSocks5Proxy(plain.port);
  });

  afterAll(async () => {
    await closeServer(socks.server);
    await closeServer(plain.server);
  });

  it("routes the Electrum socket through the SOCKS proxy when useTor is set", async () => {
    const result = await ipc.invoke("electrum-test", {
      host: "127.0.0.1",
      port: plain.port,
      useSSL: false,
      timeout: 5000,
      useTor: true,
      torProxyUrl: `socks5h://127.0.0.1:${socks.port}`,
    });
    expect(result.success).toBe(true);
    expect(result.transport).toBe("tor");
    expect(socks.requests.length).toBeGreaterThan(0);
    expect(socks.requests[0].host).toBe("127.0.0.1");
    expect(socks.requests[0].port).toBe(plain.port);
  });

  it("passes .onion hosts to the proxy for remote resolution (no local DNS leak)", async () => {
    const result = await ipc.invoke("electrum-test", {
      host: "myelectrumnode123.onion",
      port: 50001,
      useSSL: false,
      timeout: 5000,
      useTor: true,
      torProxyUrl: `socks5h://127.0.0.1:${socks.port}`,
    });
    expect(result.success).toBe(true);
    expect(result.transport).toBe("tor");
    const onionReq = socks.requests.find((r) => r.host === "myelectrumnode123.onion");
    expect(onionReq).toBeDefined();
    expect(onionReq!.atyp).toBe(3); // ATYP domain — resolved at the Tor exit
    expect(onionReq!.port).toBe(50001);
  });

  it("keeps direct and Tor connections in separate pool entries for the same server", async () => {
    // One direct + one Tor connection to the same host:port already exist
    // from the tests above; make the direct one explicitly and compare keys.
    const direct = await ipc.invoke("electrum-test", {
      host: "127.0.0.1",
      port: plain.port,
      useSSL: false,
      timeout: 5000,
    });
    expect(direct.success).toBe(true);
    expect(direct.transport).toBe("direct");

    const keys = Array.from(mod._test.electrumPool.connections.keys());
    const directKey = mod._test.poolKey("127.0.0.1", plain.port, false, {});
    const torKey = mod._test.poolKey("127.0.0.1", plain.port, false, {
      useTor: true,
      torProxyUrl: `socks5h://127.0.0.1:${socks.port}`,
    });
    expect(directKey).not.toBe(torKey);
    expect(keys).toContain(directKey);
    expect(keys).toContain(torKey);
  });

  it("fails with an explicit Tor proxy error when the proxy is unreachable", async () => {
    const result = await ipc.invoke("electrum-test", {
      host: "127.0.0.1",
      port: plain.port,
      useSSL: false,
      timeout: 3000,
      useTor: true,
      torProxyUrl: "socks5h://127.0.0.1:1", // nothing listening
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Tor proxy/);
    expect(result.error).toMatch(/Make sure Tor is running/);
  });
});

describe("electrum-cert-store persistence", () => {
  it("round-trips a trust decision and normalizes host case", () => {
    const filePath = certStore.certStorePath(dataDir);
    certStore.trustCertificate(filePath, "Example.COM", 50002, {
      fingerprint: "AA:BB:CC",
      subject: "node",
    });
    const pinned = certStore.getPinnedCertificate(filePath, "example.com", 50002);
    expect(pinned?.fingerprint).toBe("AA:BB:CC");
  });

  it("treats a corrupt store file as empty (never as trust-everything)", () => {
    const filePath = path.join(dataDir, "corrupt-store.json");
    fs.writeFileSync(filePath, "{ not json !!");
    expect(certStore.loadTrustStore(filePath)).toEqual({ version: 1, certificates: {} });
    expect(certStore.getPinnedCertificate(filePath, "host", 1)).toBeNull();
  });

  it("electrum-revoke-certificate IPC removes the pin so the next lookup is empty", async () => {
    const storePath = mod._test.getTrustStorePath()!;
    certStore.trustCertificate(storePath, "revoke-ipc.example.com", 50002, {
      fingerprint: "DE:AD:BE:EF",
    });
    const before = await ipc.invoke("electrum-get-certificate-trust", {
      host: "revoke-ipc.example.com",
      port: 50002,
    });
    expect(before.pinned?.fingerprint).toBe("DE:AD:BE:EF");

    const revoke = await ipc.invoke("electrum-revoke-certificate", {
      host: "Revoke-IPC.example.com",
      port: 50002,
    });
    expect(revoke.success).toBe(true);
    expect(revoke.revoked).toBe(true);

    const after = await ipc.invoke("electrum-get-certificate-trust", {
      host: "revoke-ipc.example.com",
      port: 50002,
    });
    expect(after.pinned).toBeNull();

    // Revoking again succeeds but reports there was nothing pinned.
    const again = await ipc.invoke("electrum-revoke-certificate", {
      host: "revoke-ipc.example.com",
      port: 50002,
    });
    expect(again.success).toBe(true);
    expect(again.revoked).toBe(false);
  });

  it("electrum-revoke-certificate rejects missing host/port", async () => {
    const result = await ipc.invoke("electrum-revoke-certificate", { host: "", port: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/host and port/);
  });

  it("revokes a pinned certificate and reports whether one existed", () => {
    const filePath = path.join(dataDir, "revoke-store.json");
    certStore.trustCertificate(filePath, "Node.Example.com", 50002, {
      fingerprint: "11:22:33",
    });
    expect(certStore.getPinnedCertificate(filePath, "node.example.com", 50002)).not.toBeNull();
    expect(certStore.revokeCertificate(filePath, "NODE.example.com", 50002)).toBe(true);
    expect(certStore.getPinnedCertificate(filePath, "node.example.com", 50002)).toBeNull();
    // Revoking again is a no-op, not an error.
    expect(certStore.revokeCertificate(filePath, "node.example.com", 50002)).toBe(false);
  });

  it("rejects trust writes without a fingerprint", () => {
    const filePath = certStore.certStorePath(dataDir);
    expect(() => certStore.trustCertificate(filePath, "h", 1, {})).toThrow(/fingerprint/i);
  });
});
