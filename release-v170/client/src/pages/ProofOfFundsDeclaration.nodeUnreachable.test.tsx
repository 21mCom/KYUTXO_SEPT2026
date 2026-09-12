// @vitest-environment jsdom
//
// Regression test for the Proof of Funds Declaration live on-chain balance check.
//
// When the node is unreachable, the live path must FAIL FAST on the first
// address rather than grinding through every address until each one times out:
//   1. A node-level connectivity error on the FIRST address aborts the whole
//      check immediately — later addresses are never attempted — and surfaces a
//      "Node unreachable" provider banner with a Check Node Connection settings
//      link, leaving the rows reset (not stuck "Checking").
//   2. A transient per-address error AFTER a successful first address still
//      surfaces per-row and the batch keeps going.
//   3. If the node goes down PARTWAY through (a run of consecutive
//      node-unreachable failures after a good first address), the whole check
//      short-circuits with the same "Node unreachable" banner instead of
//      grinding through every remaining address.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, fireEvent, within, cleanup } from "@testing-library/react";

import { renderWithProviders } from "@/test/testProviders";

vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: { id: "default", providerType: "mempool-space" } }),
}));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [], isLoading: false }) }));
vi.mock("@/hooks/use-wallet-names", () => ({
  useWalletNames: () => ({ walletNames: [], isLoading: false }),
}));

const getBlockHeight = vi.fn(async () => 800000);
const getAddressCoreStats = vi.fn();
const createProviderFromSettings = vi.fn(() => ({ getBlockHeight, getAddressCoreStats }));

// Keep the real isNodeUnreachableError / NODE_PROBE_TIMEOUT_MS; only stub the factory.
vi.mock("@/lib/blockchain-api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    createProviderFromSettings: (...a: unknown[]) => createProviderFromSettings(...a),
  };
});

import ProofOfFundsDeclaration from "./ProofOfFundsDeclaration";
import { NODE_UNREACHABLE_CONSECUTIVE_LIMIT } from "@/lib/blockchain-api";

// Valid mainnet addresses.
const ADDR_A = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ADDR_B = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const ADDR_C = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ADDR_D = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ADDR_E = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const ADDR_F = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

function startLiveCheck(addresses: string[]) {
  fireEvent.change(screen.getByTestId("textarea-address-input"), {
    target: { value: addresses.join("\n") },
  });
  fireEvent.click(screen.getByTestId("button-source-live"));
  fireEvent.click(screen.getByTestId("button-check-balances"));
}

// Generous per-test budget: page render + async balance checks can exceed the
// 5s vitest default when validation commands run in parallel.
describe("ProofOfFundsDeclaration — live check node-unreachable fast fail", { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBlockHeight.mockResolvedValue(800000);
  });

  it("fails the whole check on a first-address network error without attempting the rest", async () => {
    getAddressCoreStats.mockRejectedValue(new Error("Failed to fetch"));

    renderWithProviders(<ProofOfFundsDeclaration />);
    startLiveCheck([ADDR_A, ADDR_B, ADDR_C]);

    // Provider banner with the Node Connection settings link appears.
    await waitFor(() => {
      expect(screen.getByTestId("link-node-settings")).toBeTruthy();
    });
    expect(screen.getByText(/Node unreachable/i)).toBeTruthy();

    // Only the first address was attempted; the rest were skipped.
    expect(getAddressCoreStats).toHaveBeenCalledTimes(1);

    // No row is left stuck on "Checking".
    expect(screen.queryByText("Checking")).toBeNull();
  });

  it("still surfaces a transient per-address error after a good first address", async () => {
    getAddressCoreStats.mockImplementation(async (address: string) => {
      if (address === ADDR_B) throw new Error("Request failed: 429 Too Many Requests");
      return { txCount: 1, receivedSats: 5000, sentSats: 0, balanceSats: 5000 };
    });

    cleanup();
    renderWithProviders(<ProofOfFundsDeclaration />);
    startLiveCheck([ADDR_A, ADDR_B, ADDR_C]);

    await waitFor(() => {
      expect(screen.getByTestId("button-reset")).toBeTruthy();
    });

    // All three attempted; the batch did not abort.
    expect(getAddressCoreStats).toHaveBeenCalledTimes(3);
    expect(within(screen.getByTestId("row-address-0")).getByText("Done")).toBeTruthy();
    expect(within(screen.getByTestId("row-address-1")).getByText("Error")).toBeTruthy();
    expect(within(screen.getByTestId("row-address-2")).getByText("Done")).toBeTruthy();

    // No whole-check provider banner for a transient mid-batch error.
    expect(screen.queryByTestId("link-node-settings")).toBeNull();
  });

  it("short-circuits when the node goes down mid-check after a good start", async () => {
    // First address succeeds, then the node drops: every later address fails
    // with a node-level connectivity error.
    getAddressCoreStats.mockImplementation(async (address: string) => {
      if (address === ADDR_A) {
        return { txCount: 1, receivedSats: 5000, sentSats: 0, balanceSats: 5000 };
      }
      throw new Error("Failed to fetch");
    });

    cleanup();
    renderWithProviders(<ProofOfFundsDeclaration />);
    startLiveCheck([ADDR_A, ADDR_B, ADDR_C, ADDR_D, ADDR_E, ADDR_F]);

    // The whole-check "Node unreachable" banner appears.
    await waitFor(() => {
      expect(screen.getByTestId("link-node-settings")).toBeTruthy();
    });
    expect(screen.getByText(/Node unreachable/i)).toBeTruthy();

    // We stopped after the run of consecutive failures hit the limit (1 success
    // + 3 failures) rather than grinding through all six addresses.
    expect(getAddressCoreStats).toHaveBeenCalledTimes(
      1 + NODE_UNREACHABLE_CONSECUTIVE_LIMIT,
    );
    expect(getAddressCoreStats.mock.calls.length).toBeLessThan(6);

    // No row is left stuck on "Checking".
    expect(screen.queryByText("Checking")).toBeNull();
  });

  it("does not short-circuit on isolated single node-unreachable failures", async () => {
    // A lone transient node-level blip on ADDR_B, with everything else fine,
    // must NOT abort the whole batch — it stays below the consecutive limit.
    getAddressCoreStats.mockImplementation(async (address: string) => {
      if (address === ADDR_B) throw new Error("Failed to fetch");
      return { txCount: 1, receivedSats: 5000, sentSats: 0, balanceSats: 5000 };
    });

    cleanup();
    renderWithProviders(<ProofOfFundsDeclaration />);
    startLiveCheck([ADDR_A, ADDR_B, ADDR_C]);

    await waitFor(() => {
      expect(screen.getByTestId("button-reset")).toBeTruthy();
    });

    // All three attempted; the batch did not abort on the single blip.
    expect(getAddressCoreStats).toHaveBeenCalledTimes(3);
    expect(within(screen.getByTestId("row-address-1")).getByText("Error")).toBeTruthy();
    expect(within(screen.getByTestId("row-address-2")).getByText("Done")).toBeTruthy();
    expect(screen.queryByTestId("link-node-settings")).toBeNull();
  });
});
