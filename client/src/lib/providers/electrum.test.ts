// Unit coverage for ElectrumProvider's txid-driven getTransaction() path.
//
// Regression (never-converging startup rebuild): the provider used to convert
// txid-driven verbose responses with a hardcoded block height of 0, so every
// fetched transaction came back "unconfirmed" no matter what the server's
// `confirmations` field said. The txid backfill then skipped every orphan as
// "not yet confirmed", wrote nothing, and the same orphans re-triggered the
// startup reminder at every launch. These tests pin the fixed behavior:
//   - positive confirmations → confirmed, height derived from the chain tip
//     (tip - confirmations + 1), block_time taken from the verbose response;
//   - zero / missing / negative / implausible confirmations → unconfirmed;
//   - the tip is cached (and deduped) so a batch run does not pay one tip
//     round-trip per transaction;
//   - unconfirmed conversions are never cached, so the cache shared with the
//     address-history sync path cannot be poisoned by a stale "unconfirmed".
//
// The Electron IPC boundary is mocked; everything above it is real code. The
// address-history path (getAddressTransactions) is out of scope here — its
// heights come from Electrum history entries, not from `confirmations`.

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  electrumTest: vi.fn(),
  electrumGetTransaction: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getElectronAPI: () => mockApi,
}));

const { ElectrumProvider } = await import("./electrum");

const TXID_A = "a".repeat(64);
const TXID_B = "b".repeat(64);
const TXID_C = "d".repeat(64);
const PREV_TXID = "c".repeat(64);
const ADDR_OUT = "bc1qoutputaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx1";

const TIP_HEIGHT = 800002;
const BLOCK_TIME = 1700000100;

/** Bitcoin Core-style verbose transaction, as Electrum servers return it. */
function verboseTx(txid: string, confirmations?: number) {
  return {
    txid,
    version: 2,
    locktime: 0,
    size: 200,
    vsize: 150,
    weight: 600,
    fee: 0.00001,
    time: BLOCK_TIME,
    blocktime: BLOCK_TIME,
    ...(confirmations !== undefined ? { confirmations } : {}),
    // Electrum verbose vin carries no prevout data.
    vin: [{ txid: PREV_TXID, vout: 0, sequence: 0xfffffffd }],
    vout: [
      {
        value: 0.00099,
        n: 0,
        scriptPubKey: { hex: "0014aa", type: "witness_v0_keyhash", address: ADDR_OUT },
      },
    ],
  };
}

function makeProvider() {
  return new ElectrumProvider("umbrel.local", 50001);
}

beforeEach(() => {
  mockApi.electrumTest.mockReset();
  mockApi.electrumGetTransaction.mockReset();
  mockApi.electrumTest.mockResolvedValue({ success: true, blockHeight: TIP_HEIGHT });
});

// ---- confirmation derivation ------------------------------------------------

describe("getTransaction confirmation derivation", () => {
  it("marks a transaction with positive confirmations as confirmed at tip - confirmations + 1", async () => {
    mockApi.electrumGetTransaction.mockResolvedValue({
      success: true,
      transaction: verboseTx(TXID_A, 3),
    });

    const tx = await makeProvider().getTransaction(TXID_A);

    expect(tx?.status.confirmed).toBe(true);
    expect(tx?.status.block_height).toBe(TIP_HEIGHT - 3 + 1);
    expect(tx?.status.block_time).toBe(BLOCK_TIME);
    // The rest of the conversion survives the derivation path.
    expect(tx?.vout[0]?.scriptpubkey_address).toBe(ADDR_OUT);
    expect(tx?.vout[0]?.value).toBe(99000);
  });

  it("keeps a zero-confirmation transaction unconfirmed without any tip lookup", async () => {
    mockApi.electrumGetTransaction.mockResolvedValue({
      success: true,
      transaction: verboseTx(TXID_A, 0),
    });

    const tx = await makeProvider().getTransaction(TXID_A);

    expect(tx?.status.confirmed).toBe(false);
    expect(tx?.status.block_height).toBeUndefined();
    expect(mockApi.electrumTest).not.toHaveBeenCalled();
  });

  it("treats a missing confirmations field as unconfirmed", async () => {
    mockApi.electrumGetTransaction.mockResolvedValue({
      success: true,
      transaction: verboseTx(TXID_A, undefined),
    });

    const tx = await makeProvider().getTransaction(TXID_A);

    expect(tx?.status.confirmed).toBe(false);
    expect(mockApi.electrumTest).not.toHaveBeenCalled();
  });

  it("treats negative confirmations (conflicted transaction) as unconfirmed", async () => {
    mockApi.electrumGetTransaction.mockResolvedValue({
      success: true,
      transaction: verboseTx(TXID_A, -1),
    });

    const tx = await makeProvider().getTransaction(TXID_A);

    expect(tx?.status.confirmed).toBe(false);
    expect(mockApi.electrumTest).not.toHaveBeenCalled();
  });

  it("treats confirmations beyond the chain tip as unconfirmed instead of storing a bogus height", async () => {
    mockApi.electrumGetTransaction.mockResolvedValue({
      success: true,
      transaction: verboseTx(TXID_A, TIP_HEIGHT + 100),
    });

    const tx = await makeProvider().getTransaction(TXID_A);

    expect(tx?.status.confirmed).toBe(false);
    expect(tx?.status.block_height).toBeUndefined();
  });

  it("returns null when the server does not have the transaction", async () => {
    mockApi.electrumGetTransaction.mockResolvedValue({ success: false, error: "not found" });

    expect(await makeProvider().getTransaction(TXID_A)).toBeNull();
  });
});

// ---- tip-height caching -------------------------------------------------------

describe("tip-height caching", () => {
  it("derives heights for concurrent fetches from a single, deduped tip lookup", async () => {
    mockApi.electrumGetTransaction.mockImplementation(async ({ txid }: { txid: string }) => ({
      success: true,
      transaction: verboseTx(txid, 10),
    }));

    const provider = makeProvider();
    const [a, b] = await Promise.all([
      provider.getTransaction(TXID_A),
      provider.getTransaction(TXID_B),
    ]);

    expect(a?.status.confirmed).toBe(true);
    expect(b?.status.confirmed).toBe(true);
    expect(mockApi.electrumTest).toHaveBeenCalledTimes(1);

    // A later sequential fetch inside the TTL window reuses the cache too.
    const c = await provider.getTransaction(TXID_C);
    expect(c?.status.confirmed).toBe(true);
    expect(mockApi.electrumTest).toHaveBeenCalledTimes(1);
  });

  it("reuses a tip primed by getBlockHeight() instead of fetching again", async () => {
    mockApi.electrumGetTransaction.mockResolvedValue({
      success: true,
      transaction: verboseTx(TXID_A, 5),
    });

    const provider = makeProvider();
    await provider.getBlockHeight(); // e.g. the backfill's up-front connectivity probe
    const tx = await provider.getTransaction(TXID_A);

    expect(tx?.status.block_height).toBe(TIP_HEIGHT - 5 + 1);
    expect(mockApi.electrumTest).toHaveBeenCalledTimes(1);
  });

  it("falls back to unconfirmed when the tip cannot be determined, then recovers", async () => {
    mockApi.electrumTest.mockResolvedValueOnce({ success: false, error: "connection refused" });
    mockApi.electrumGetTransaction.mockResolvedValue({
      success: true,
      transaction: verboseTx(TXID_A, 6),
    });

    const provider = makeProvider();
    const first = await provider.getTransaction(TXID_A);
    expect(first?.status.confirmed).toBe(false);

    // The failed conversion must NOT have been cached: once the tip is
    // reachable again, the same txid comes back confirmed.
    const second = await provider.getTransaction(TXID_A);
    expect(second?.status.confirmed).toBe(true);
    expect(second?.status.block_height).toBe(TIP_HEIGHT - 6 + 1);
    expect(mockApi.electrumGetTransaction).toHaveBeenCalledTimes(2);
  });
});

// ---- shared transaction cache ------------------------------------------------

describe("shared transaction cache", () => {
  it("caches confirmed transactions so repeat fetches skip the network", async () => {
    mockApi.electrumGetTransaction.mockResolvedValue({
      success: true,
      transaction: verboseTx(TXID_A, 8),
    });

    const provider = makeProvider();
    const first = await provider.getTransaction(TXID_A);
    const second = await provider.getTransaction(TXID_A);

    expect(first?.status.confirmed).toBe(true);
    expect(second).toBe(first);
    expect(mockApi.electrumGetTransaction).toHaveBeenCalledTimes(1);
  });

  it("never pins an unconfirmed status: a later fetch sees the now-confirmed transaction", async () => {
    mockApi.electrumGetTransaction
      .mockResolvedValueOnce({ success: true, transaction: verboseTx(TXID_A, 0) })
      .mockResolvedValueOnce({ success: true, transaction: verboseTx(TXID_A, 2) });

    const provider = makeProvider();
    const first = await provider.getTransaction(TXID_A);
    expect(first?.status.confirmed).toBe(false);

    const second = await provider.getTransaction(TXID_A);
    expect(second?.status.confirmed).toBe(true);
    expect(second?.status.block_height).toBe(TIP_HEIGHT - 2 + 1);
    expect(mockApi.electrumGetTransaction).toHaveBeenCalledTimes(2);
  });
});
