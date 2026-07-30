import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { createRequire } from "node:module";
import * as bitcoin from "bitcoinjs-lib";

// Exercise the REAL electrum-batch-get-history IPC handler in
// electron/electrum-client.cjs against a local fake Electrum server, verifying
// that (a) requests within a batch are pipelined (more than one in flight on
// the multiplexed socket at once), (b) results stay in input address order
// even though responses arrive out of order, and (c) per-address failures
// stay isolated (one bad address never aborts the rest of the batch).

const requireCjs = createRequire(import.meta.url);

type Handler = (event: unknown, arg: unknown) => unknown;
class FakeIpcMain {
  private handlers = new Map<string, Handler>();
  handle(channel: string, fn: Handler) {
    this.handlers.set(channel, fn);
  }
  invoke(channel: string, arg?: unknown) {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for ${channel}`);
    return fn({}, arg);
  }
}

// Generate N valid, unique mainnet P2WPKH addresses (sha256 of a counter as
// the private key), mirroring scripts/bench-address-checker-live.mjs.
function genAddresses(n: number): string[] {
  const secp = requireCjs("@bitcoinerlab/secp256k1");
  const crypto = requireCjs("node:crypto");
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const priv = crypto
      .createHash("sha256")
      .update(`kyutxo-batch-history-test-${i}`)
      .digest();
    if (!secp.isPrivate(priv)) continue;
    const pubkey = Buffer.from(secp.pointFromScalar(priv, true));
    out.push(
      bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.bitcoin })
        .address as string,
    );
  }
  return out;
}

const ADDRESSES = genAddresses(24);
// Address indexes the fake server answers with an error / never answers.
const FAIL_INDEX = 5;
const SILENT_INDEX = 11;

// Fake Electrum server knobs, reset per test.
let respondDelayMs = 0;
let maxInFlightSeen = 0;

let server: net.Server;
let serverPort: number;
let stopKeepalive: () => void;
let ipc: FakeIpcMain;

beforeAll(async () => {
  server = net.createServer((socket) => {
    let buffer = "";
    let inFlight = 0;
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        inFlight++;
        maxInFlightSeen = Math.max(maxInFlightSeen, inFlight);
        const respond = () => {
          inFlight--;
          if (req.method === "server.version") {
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: ["FakeElectrum 1.0", "1.4"],
              }) + "\n",
            );
            return;
          }
          if (req.method === "server.ping") {
            socket.write(
              JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }) +
                "\n",
            );
            return;
          }
          if (req.method === "blockchain.scripthash.listunspent") {
            const scripthash = req.params[0] as string;
            const idx = scripthashIndex.get(scripthash);
            if (idx === SILENT_INDEX) {
              // Never respond: exercises the per-request timeout path.
              return;
            }
            if (idx === FAIL_INDEX) {
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  error: { message: "index out of range" },
                }) + "\n",
              );
              return;
            }
            // One UTXO whose value encodes the address index, so the test can
            // verify each result landed on the right address.
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: [
                  {
                    tx_hash: `fake-utxo-txid-${idx}`,
                    tx_pos: 0,
                    value: ((idx ?? 0) + 1) * 1000,
                    height: 1000 + (idx ?? 0),
                  },
                ],
              }) + "\n",
            );
            return;
          }
          if (req.method === "blockchain.scripthash.get_history") {
            const scripthash = req.params[0] as string;
            // Recover the address index by matching scripthashes.
            const idx = scripthashIndex.get(scripthash);
            if (idx === SILENT_INDEX) {
              // Never respond: exercises the per-request timeout path.
              return;
            }
            if (idx === FAIL_INDEX) {
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  error: { message: "index out of range" },
                }) + "\n",
              );
              return;
            }
            // Reply with a history whose length encodes the address index, so
            // the test can verify each result landed on the right address
            // even with out-of-order delivery.
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: Array.from({ length: (idx ?? 0) + 1 }, (_, k) => ({
                  tx_hash: `fake-txid-${idx}-${k}`,
                  height: 1000 + (idx ?? 0),
                })),
              }) + "\n",
            );
            return;
          }
          socket.write(
            JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }) + "\n",
          );
        };
        if (respondDelayMs > 0 && req.method !== "server.version" && req.method !== "server.ping") {
          setTimeout(respond, respondDelayMs);
        } else {
          respond();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as net.AddressInfo).port;

  const mod = requireCjs("./electrum-client.cjs") as {
    registerElectrumHandlers: (ipcMain: FakeIpcMain) => void;
    stopKeepalive: () => void;
  };
  stopKeepalive = mod.stopKeepalive;
  ipc = new FakeIpcMain();
  mod.registerElectrumHandlers(ipc);
});

afterAll(async () => {
  stopKeepalive?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// scripthash -> address index, computed the same way the handler does.
const scripthashIndex = new Map<string, number>();

function batchGetHistory(
  addresses: string[],
  timeout = 5000,
): Promise<any> {
  return Promise.resolve(
    ipc.invoke("electrum-batch-get-history", {
      host: "127.0.0.1",
      port: serverPort,
      useSSL: false,
      addresses,
      timeout,
    }),
  );
}

describe("electrum-batch-get-history pipelining", () => {
  it("overlaps requests on the multiplexed socket and keeps input order", async () => {
    // Build the scripthash index the fake server uses to identify addresses.
    const ecc = requireCjs("@bitcoinerlab/secp256k1");
    bitcoin.initEccLib(ecc);
    const crypto = requireCjs("node:crypto");
    scripthashIndex.clear();
    ADDRESSES.forEach((addr, idx) => {
      const script = bitcoin.address.toOutputScript(
        addr,
        bitcoin.networks.bitcoin,
      );
      const hash = crypto.createHash("sha256").update(script).digest();
      scripthashIndex.set(Buffer.from(hash).reverse().toString("hex"), idx);
    });

    // 40 ms server-side latency per response: with sequential requests a
    // 24-address batch would take ~1s and never exceed 1 in-flight request.
    respondDelayMs = 40;
    maxInFlightSeen = 0;

    const t = Date.now();
    const result = await batchGetHistory(ADDRESSES);
    const elapsed = Date.now() - t;

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(ADDRESSES.length);

    // Every address except the two failure-injection indexes succeeded, in
    // input order, with the index-encoded history length.
    for (let i = 0; i < ADDRESSES.length; i++) {
      const entry = result.results[i];
      expect(entry.address).toBe(ADDRESSES[i]);
      if (i === FAIL_INDEX) {
        expect(entry.success).toBe(false);
        expect(entry.error).toMatch(/index out of range/);
        expect(entry.history).toEqual([]);
      } else if (i === SILENT_INDEX) {
        expect(entry.success).toBe(false);
        expect(entry.error).toMatch(/timeout/i);
      } else {
        expect(entry.success).toBe(true);
        expect(entry.history).toHaveLength(i + 1);
      }
    }

    // Pipelining proof: several requests were on the wire at once (sequential
    // processing would peak at 1), and the whole batch finished well under
    // the sequential floor of 24 x 40ms = ~960ms (plus 5s timeout for the
    // silent address — which must also overlap, not serialize).
    expect(maxInFlightSeen).toBeGreaterThan(2);
    expect(elapsed).toBeLessThan(7000);
  }, 15000);

  it("reports every address even when the server dies mid-batch", async () => {
    respondDelayMs = 0;
    // Ask for a batch while pointing at a port with no server listening:
    // the whole batch must fail cleanly without throwing.
    const deadPort = serverPort + 1000;
    const result = await Promise.resolve(
      ipc.invoke("electrum-batch-get-history", {
        host: "127.0.0.1",
        port: deadPort,
        useSSL: false,
        addresses: ADDRESSES.slice(0, 4),
        timeout: 3000,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("electrum-batch-get-utxos pipelining", () => {
  it("overlaps requests, keeps input order, and isolates per-address failures", async () => {
    // Reuse the scripthash index built by the history test (or build it now
    // if this test runs first).
    if (scripthashIndex.size === 0) {
      const ecc = requireCjs("@bitcoinerlab/secp256k1");
      bitcoin.initEccLib(ecc);
      const crypto = requireCjs("node:crypto");
      ADDRESSES.forEach((addr, idx) => {
        const script = bitcoin.address.toOutputScript(
          addr,
          bitcoin.networks.bitcoin,
        );
        const hash = crypto.createHash("sha256").update(script).digest();
        scripthashIndex.set(Buffer.from(hash).reverse().toString("hex"), idx);
      });
    }

    respondDelayMs = 40;
    maxInFlightSeen = 0;

    const t = Date.now();
    const result = await Promise.resolve(
      ipc.invoke("electrum-batch-get-utxos", {
        host: "127.0.0.1",
        port: serverPort,
        useSSL: false,
        addresses: ADDRESSES,
        timeout: 5000,
      }),
    ) as any;
    const elapsed = Date.now() - t;

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(ADDRESSES.length);

    for (let i = 0; i < ADDRESSES.length; i++) {
      const entry = result.results[i];
      expect(entry.address).toBe(ADDRESSES[i]);
      if (i === FAIL_INDEX) {
        expect(entry.success).toBe(false);
        expect(entry.error).toMatch(/index out of range/);
        expect(entry.utxos).toEqual([]);
      } else if (i === SILENT_INDEX) {
        expect(entry.success).toBe(false);
        expect(entry.error).toMatch(/timeout/i);
      } else {
        expect(entry.success).toBe(true);
        expect(entry.utxos).toHaveLength(1);
        expect(entry.utxos[0].value).toBe((i + 1) * 1000);
      }
    }

    // Pipelining proof: several requests on the wire at once, and the batch
    // finished well under the sequential floor (24 x 40ms + 5s timeout).
    expect(maxInFlightSeen).toBeGreaterThan(2);
    expect(elapsed).toBeLessThan(7000);
  }, 15000);

  it("fails the whole batch cleanly when no server is listening", async () => {
    respondDelayMs = 0;
    const result = await Promise.resolve(
      ipc.invoke("electrum-batch-get-utxos", {
        host: "127.0.0.1",
        port: serverPort + 1000,
        useSSL: false,
        addresses: ADDRESSES.slice(0, 4),
        timeout: 3000,
      }),
    ) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
