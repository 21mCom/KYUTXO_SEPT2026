import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { createRequire } from "node:module";

// Exercise the REAL electrum-get-block-hash IPC handler in
// electron/electrum-client.cjs against a local fake Electrum server, so the
// double-SHA256 + byte-reverse hash math is verified end-to-end at the Node
// level (the renderer tests mock this IPC entirely).

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

// Well-known mainnet vectors.
// Block 0 (genesis) raw 80-byte header:
const GENESIS_HEADER_HEX =
  "01000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" +
  "29ab5f49" +
  "ffff001d" +
  "1dac2b7c";
const GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

// Block 125552 (the famous "extraNonce" example block):
const BLOCK_125552_HEADER_HEX =
  "01000000" +
  "81cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000" +
  "e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b" +
  "c7f5d74d" +
  "f2b9441a" +
  "42a14695";
const BLOCK_125552_HASH =
  "00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d";

// Fake Electrum JSON-RPC server: maps height -> header hex response.
let server: net.Server;
let serverPort: number;
const headerByHeight = new Map<number, unknown>();

let stopKeepalive: () => void;
let ipc: FakeIpcMain;

beforeAll(async () => {
  server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        let result: unknown;
        if (req.method === "server.version") {
          result = ["FakeElectrum 1.0", "1.4"];
        } else if (req.method === "server.ping") {
          result = null;
        } else if (req.method === "blockchain.block.header") {
          result = headerByHeight.get(req.params[0]);
          if (result === undefined) {
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                error: { message: "height out of range" },
              }) + "\n",
            );
            continue;
          }
        } else {
          result = null;
        }
        socket.write(
          JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n",
        );
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

function getBlockHash(height: unknown): Promise<any> {
  return Promise.resolve(
    ipc.invoke("electrum-get-block-hash", {
      host: "127.0.0.1",
      port: serverPort,
      useSSL: false,
      height,
      timeout: 5000,
    }),
  );
}

describe("electrum-get-block-hash hash math", () => {
  it("computes the genesis block hash from the raw header", async () => {
    headerByHeight.set(0, GENESIS_HEADER_HEX);
    const result = await getBlockHash(0);
    expect(result.success).toBe(true);
    expect(result.blockHash).toBe(GENESIS_HASH);
  });

  it("computes block 125552's hash (independent second vector)", async () => {
    headerByHeight.set(125552, BLOCK_125552_HEADER_HEX);
    const result = await getBlockHash(125552);
    expect(result.success).toBe(true);
    expect(result.blockHash).toBe(BLOCK_125552_HASH);
  });

  it("hashes only the first 80 bytes even if the server returns extra trailing hex", async () => {
    // Some servers/tools append extra data; the block hash covers exactly 80 bytes.
    headerByHeight.set(1000, GENESIS_HEADER_HEX + "deadbeef".repeat(10));
    const result = await getBlockHash(1000);
    expect(result.success).toBe(true);
    expect(result.blockHash).toBe(GENESIS_HASH);
  });
});

describe("electrum-get-block-hash input validation", () => {
  it("rejects a negative height without contacting the server", async () => {
    const result = await getBlockHash(-1);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid block height/);
  });

  it("rejects a non-integer height", async () => {
    const result = await getBlockHash(1.5);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid block height/);
  });

  it("rejects a missing height", async () => {
    const result = await getBlockHash(undefined);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid block height/);
  });

  it("fails cleanly when the server returns a short header hex", async () => {
    headerByHeight.set(2000, "abcd1234"); // far shorter than 160 hex chars
    const result = await getBlockHash(2000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid block header/i);
  });

  it("fails cleanly when the server returns a non-string header", async () => {
    headerByHeight.set(3000, { branch: [], header: GENESIS_HEADER_HEX });
    const result = await getBlockHash(3000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid block header/i);
  });

  it("surfaces server-side errors (height out of range) as failures", async () => {
    const result = await getBlockHash(99999999); // no entry -> server error
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/height out of range/);
  });
});
