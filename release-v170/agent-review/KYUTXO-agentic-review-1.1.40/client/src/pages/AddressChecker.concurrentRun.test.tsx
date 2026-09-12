// Component-level coverage for the Address Checker's concurrent run
// (Task: speed up large lists):
//   - a large synthetic list (mix of valid/invalid/failing addresses)
//     completes with bounded provider concurrency (HTTP path ≤ 3);
//   - a per-address error marks only that row as failed — the rest complete;
//   - cancel mid-run halts promptly, keeps completed rows, and leaves no row
//     stuck on "loading";
//   - the Electrum-style batch path fetches tx counts in chunks and falls
//     back to per-address core stats for addresses the batch failed on.
//
// The provider factory and address validation are mocked; the component,
// pool, batching fan-out, and throttled row-patch flushing are real code.

// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const mocks = vi.hoisted(() => ({
  createProviderFromSettings: vi.fn(),
}));

// Render every virtualized row (jsdom's zero-size scroll element would
// otherwise render none).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: index,
        start: index * 53,
        size: 53,
        end: (index + 1) * 53,
      })),
    getTotalSize: () => opts.count * 53,
    measureElement: () => {},
  }),
}));

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: {} }),
}));

// Other modules pulled in by the shared provider harness (transaction-sync →
// RecordDetailPanel) import more than createProviderFromSettings from these
// modules — keep the originals and override only what this test needs.
vi.mock("@/lib/blockchain-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createProviderFromSettings: mocks.createProviderFromSettings,
}));

// The "In Vault" column's batched membership lookup hits Dexie; these tests
// don't seed a vault, so stub it to an empty result.
vi.mock("@/lib/data/record-crud", () => ({
  getSavedAddressRecordLookup: async () => new Map(),
}));

vi.mock("@/lib/bitcoin", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  validateAddress: (addr: string) =>
    addr.startsWith("bad")
      ? { isValid: false, error: "Not a valid Bitcoin address" }
      : { isValid: true },
  formatBTC: (sats: number) => `${sats} sats`,
}));

const AddressChecker = (await import("./AddressChecker")).default;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeAddresses(n: number, prefix = "addr") {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

async function startRun(input: string) {
  renderWithProviders(<AddressChecker />);
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: input },
  });
  fireEvent.click(screen.getByTestId("button-run-check"));
}

describe("AddressChecker concurrent run", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("completes a large mixed list with bounded HTTP concurrency and per-row failure isolation", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = {
      name: "Fake HTTP",
      getAddressCoreStats: vi.fn(async (address: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(2);
        inFlight--;
        if (address === "addr7" || address === "addr23") {
          throw new Error(`lookup failed for ${address}`);
        }
        return { txCount: 1, balanceSats: 100 };
      }),
    };
    mocks.createProviderFromSettings.mockReturnValue(provider);

    const input = [...makeAddresses(60), "bad1", "bad2"].join("\n");
    await startRun(input);

    await waitFor(
      () => expect((screen.getByTestId("button-run-check") as HTMLButtonElement).disabled).toBe(false),
      { timeout: 15000 },
    );

    expect(provider.getAddressCoreStats).toHaveBeenCalledTimes(60);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);

    // Errored rows show Error badges; everything else is Done — nothing loading.
    expect(screen.getAllByText("Error")).toHaveLength(2);
    expect(screen.getAllByText("Done")).toHaveLength(58);
    expect(screen.queryByText("Checking")).toBeNull();
    expect(screen.getAllByText("Invalid")).toHaveLength(2);
  }, 30000);

  it("cancel mid-run halts promptly, keeps finished rows, leaves no stuck loading rows", async () => {
    let resolvedCount = 0;
    const provider = {
      name: "Fake HTTP",
      getAddressCoreStats: vi.fn(async () => {
        await sleep(15);
        resolvedCount++;
        return { txCount: 2, balanceSats: 5 };
      }),
    };
    mocks.createProviderFromSettings.mockReturnValue(provider);

    await startRun(makeAddresses(100).join("\n"));

    // Let a few complete, then cancel.
    await waitFor(() => expect(resolvedCount).toBeGreaterThanOrEqual(3), {
      timeout: 10000,
    });
    fireEvent.click(screen.getByTestId("button-cancel-check"));

    await waitFor(
      () => {
        expect((screen.getByTestId("button-run-check") as HTMLButtonElement).disabled).toBe(false);
        expect(screen.queryByText("Checking")).toBeNull();
      },
      { timeout: 10000 },
    );

    // Far fewer than 100 lookups were started; completed rows kept results.
    expect(provider.getAddressCoreStats.mock.calls.length).toBeLessThan(30);
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(70);
  }, 30000);

  it("a cancelled run's stale workers cannot patch rows of an immediately started new run", async () => {
    // First run: slow lookups that resolve long after cancellation, returning
    // a poison marker value. Second run: fast lookups with a distinct value.
    let run = 0;
    const releaseFirstRun: Array<() => void> = [];
    const provider = {
      name: "Fake HTTP",
      getAddressCoreStats: vi.fn(async () => {
        if (run === 0) {
          await new Promise<void>((r) => releaseFirstRun.push(r));
          return { txCount: 666, balanceSats: 666 }; // stale-run poison
        }
        await sleep(1);
        return { txCount: 5, balanceSats: 50 };
      }),
    };
    mocks.createProviderFromSettings.mockReturnValue(provider);

    await startRun(makeAddresses(10).join("\n"));
    await waitFor(() =>
      expect(provider.getAddressCoreStats.mock.calls.length).toBeGreaterThanOrEqual(3),
    );

    // Cancel while the first run's workers are parked, then immediately re-run.
    fireEvent.click(screen.getByTestId("button-cancel-check"));
    run = 1;
    fireEvent.click(screen.getByTestId("button-run-check"));

    // Now let the old run's workers resolve with the poison value.
    releaseFirstRun.forEach((r) => r());

    await waitFor(
      () => {
        expect((screen.getByTestId("button-run-check") as HTMLButtonElement).disabled).toBe(false);
        expect(screen.getAllByText("Done")).toHaveLength(10);
      },
      { timeout: 15000 },
    );
    // Give any straggling stale flush a chance to (incorrectly) land.
    await sleep(400);

    // Every row shows the new run's tx count; the poison value never appears.
    for (let i = 0; i < 10; i++) {
      expect(screen.getByTestId(`cell-txcount-${i}`).textContent).toBe("5");
    }
    expect(screen.queryByText("666")).toBeNull();
    expect(screen.queryByText("Checking")).toBeNull();
    expect(screen.queryByText("Pending")).toBeNull();
  }, 30000);

  it("uses batch tx counts on the Electrum-style path and falls back per-address on batch misses", async () => {
    const batchCalls: string[][] = [];
    const provider = {
      name: "Fake Electrum",
      getAddressTxCountsBatch: vi.fn(async (addresses: string[]) => {
        batchCalls.push(addresses);
        const out = new Map<string, number | { error: string }>();
        for (const a of addresses) {
          if (a === "addr5") out.set(a, { error: "server hiccup" });
          else out.set(a, 3);
        }
        return out;
      }),
      getAddressBalanceSats: vi.fn(async () => 42),
      getAddressCoreStats: vi.fn(async () => ({ txCount: 9, balanceSats: 7 })),
    };
    mocks.createProviderFromSettings.mockReturnValue(provider);

    await startRun(makeAddresses(50).join("\n"));

    await waitFor(
      () => expect((screen.getByTestId("button-run-check") as HTMLButtonElement).disabled).toBe(false),
      { timeout: 15000 },
    );

    // 50 addresses → chunks of 40: two batch calls.
    expect(batchCalls.map((b) => b.length)).toEqual([40, 10]);
    // addr5 failed in the batch → per-address fallback; the other 49 only
    // needed the cheap balance call.
    expect(provider.getAddressCoreStats).toHaveBeenCalledTimes(1);
    expect(provider.getAddressBalanceSats).toHaveBeenCalledTimes(49);
    expect(screen.getAllByText("Done")).toHaveLength(50);
    expect(screen.queryByText("Error")).toBeNull();
  }, 30000);

  it("shows advancing prefetch progress during a multi-batch Electrum prefetch, then hides it for the worker pool", async () => {
    // Gate each batch so the test can observe progress between batches.
    const releaseBatch: Array<() => void> = [];
    const provider = {
      name: "Fake Electrum",
      getAddressTxCountsBatch: vi.fn(async (addresses: string[]) => {
        await new Promise<void>((r) => releaseBatch.push(r));
        return new Map<string, number | { error: string }>(addresses.map((a) => [a, 2]));
      }),
      getAddressBalanceSats: vi.fn(async () => 10),
      getAddressCoreStats: vi.fn(async () => ({ txCount: 9, balanceSats: 7 })),
    };
    mocks.createProviderFromSettings.mockReturnValue(provider);

    // 100 addresses → 3 batches (40/40/20).
    await startRun(makeAddresses(100).join("\n"));

    // Prefetch indicator appears at 0 before any batch resolves; main counter is 0.
    await waitFor(() =>
      expect(screen.getByTestId("text-prefetch-progress").textContent).toContain("0 / 100"),
    );
    expect(screen.getByTestId("text-progress").textContent).toContain("0 / 100");

    // First batch resolves → progress advances to 40.
    await waitFor(() => expect(releaseBatch.length).toBeGreaterThanOrEqual(1));
    releaseBatch.shift()!();
    await waitFor(() =>
      expect(screen.getByTestId("text-prefetch-progress").textContent).toContain("40 / 100"),
    );

    // Second batch → 80.
    await waitFor(() => expect(releaseBatch.length).toBeGreaterThanOrEqual(1));
    releaseBatch.shift()!();
    await waitFor(() =>
      expect(screen.getByTestId("text-prefetch-progress").textContent).toContain("80 / 100"),
    );

    // Final batch: prefetch indicator disappears, worker pool completes the run.
    await waitFor(() => expect(releaseBatch.length).toBeGreaterThanOrEqual(1));
    releaseBatch.shift()!();
    await waitFor(() => expect(screen.queryByTestId("text-prefetch-progress")).toBeNull());

    await waitFor(
      () => expect((screen.getByTestId("button-run-check") as HTMLButtonElement).disabled).toBe(false),
      { timeout: 15000 },
    );
    expect(screen.getAllByText("Done")).toHaveLength(100);
  }, 30000);

  it("cancel during the prefetch phase stops promptly, leaves no stuck rows, and Reset clears the indicator", async () => {
    const releaseBatch: Array<() => void> = [];
    const provider = {
      name: "Fake Electrum",
      getAddressTxCountsBatch: vi.fn(async (addresses: string[]) => {
        await new Promise<void>((r) => releaseBatch.push(r));
        return new Map<string, number | { error: string }>(addresses.map((a) => [a, 2]));
      }),
      getAddressBalanceSats: vi.fn(async () => 10),
      getAddressCoreStats: vi.fn(async () => ({ txCount: 9, balanceSats: 7 })),
    };
    mocks.createProviderFromSettings.mockReturnValue(provider);

    await startRun(makeAddresses(100).join("\n"));
    await waitFor(() =>
      expect(screen.getByTestId("text-prefetch-progress").textContent).toContain("0 / 100"),
    );

    // Cancel while the first batch is still parked, then release it.
    fireEvent.click(screen.getByTestId("button-cancel-check"));
    await waitFor(() => expect(releaseBatch.length).toBeGreaterThanOrEqual(1));
    releaseBatch.forEach((r) => r());

    await waitFor(() => {
      expect((screen.getByTestId("button-run-check") as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId("text-prefetch-progress")).toBeNull();
    });

    // No further batches were started; no row is stuck loading or done.
    expect(provider.getAddressTxCountsBatch).toHaveBeenCalledTimes(1);
    expect(provider.getAddressBalanceSats).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking")).toBeNull();
    expect(screen.getAllByText("Pending")).toHaveLength(100);

    // Reset clears everything, indicator included.
    fireEvent.click(screen.getByTestId("button-reset-check"));
    expect(screen.queryByTestId("text-prefetch-progress")).toBeNull();
    expect(screen.queryByText("Pending")).toBeNull();
  }, 30000);

  it("HTTP (non-batch) providers never show the prefetch indicator", async () => {
    const provider = {
      name: "Fake HTTP",
      getAddressCoreStats: vi.fn(async () => {
        await sleep(5);
        return { txCount: 1, balanceSats: 100 };
      }),
    };
    mocks.createProviderFromSettings.mockReturnValue(provider);

    await startRun(makeAddresses(10).join("\n"));
    expect(screen.queryByTestId("text-prefetch-progress")).toBeNull();

    await waitFor(
      () => expect((screen.getByTestId("button-run-check") as HTMLButtonElement).disabled).toBe(false),
      { timeout: 15000 },
    );
    expect(screen.queryByTestId("text-prefetch-progress")).toBeNull();
    expect(screen.getAllByText("Done")).toHaveLength(10);
  }, 30000);
});
