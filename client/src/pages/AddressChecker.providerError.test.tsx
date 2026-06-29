// @vitest-environment jsdom
//
// Regression test for the Address Checker's per-row error isolation.
//
// The checker processes addresses sequentially and catches per-row errors, so a
// single unreachable / failing node response (network timeout, 429 rate-limit,
// 500 server error) must mark ONLY that row as "error" and continue with the
// remaining addresses — never aborting or hanging the whole batch.
//
// This test stubs `createProviderFromSettings` to return a provider whose
// `getAddressCoreStats` throws on the second address and confirms:
//   1. row 1 and row 3 reach "Done"
//   2. row 2 shows "Error" with a readable message
//   3. the batch finishes (isRunning returns to false): the Cancel button
//      disappears, the Reset button appears, and Check Addresses is re-enabled.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within, cleanup } from "@testing-library/react";

// Radix Tooltips only render their content on hover, but the per-row error
// message lives inside <TooltipContent>. Render the tooltip parts inline so the
// message is assertable, and so the page needs no TooltipProvider in the tree.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The page only reads `nodeSettings`; the actual value is irrelevant because the
// provider factory is stubbed below.
vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({ nodeSettings: { id: "default", providerType: "mempool-space" } }),
}));

const getAddressCoreStats = vi.fn();
const createProviderFromSettings = vi.fn(() => ({ getAddressCoreStats }));
vi.mock("@/lib/blockchain-api", () => ({
  createProviderFromSettings: (...a: unknown[]) => createProviderFromSettings(...a),
}));

import AddressChecker from "./AddressChecker";

// Valid mainnet bech32 addresses (BIP173 test vectors).
const ADDR_A = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ADDR_B = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const ADDR_C = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

const ERROR_MESSAGE = "Network timeout: node unreachable";

describe("AddressChecker — unreachable node isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAddressCoreStats.mockImplementation(async (address: string) => {
      if (address === ADDR_B) {
        throw new Error(ERROR_MESSAGE);
      }
      return { txCount: 3, receivedSats: 100000, sentSats: 40000, balanceSats: 60000 };
    });
  });

  it("marks only the failing address as error and finishes the rest", async () => {
    render(<AddressChecker />);

    const textarea = screen.getByTestId("textarea-address-input");
    fireEvent.change(textarea, { target: { value: `${ADDR_A}\n${ADDR_B}\n${ADDR_C}` } });

    fireEvent.click(screen.getByTestId("button-run-check"));

    // The batch must complete: the Reset button only renders once isRunning and
    // isHistoryRunning are both false.
    await waitFor(() => {
      expect(screen.getByTestId("button-reset-check")).toBeTruthy();
    });

    // All three rows attempted; the second threw.
    expect(getAddressCoreStats).toHaveBeenCalledTimes(3);

    const row0 = screen.getByTestId("row-address-0");
    const row1 = screen.getByTestId("row-address-1");
    const row2 = screen.getByTestId("row-address-2");

    // (1) rows 1 and 3 reached "Done".
    expect(within(row0).getByText("Done")).toBeTruthy();
    expect(within(row2).getByText("Done")).toBeTruthy();

    // (2) row 2 shows "Error" with a readable message.
    expect(within(row1).getByText("Error")).toBeTruthy();
    expect(within(row1).getByText(ERROR_MESSAGE)).toBeTruthy();

    // (3) isRunning returned to false: the Cancel button is gone and Check
    // Addresses is enabled again.
    expect(screen.queryByTestId("button-cancel-check")).toBeNull();
    expect((screen.getByTestId("button-run-check") as HTMLButtonElement).disabled).toBe(false);
  });

  it("isolates a rate-limit (429) error mid-batch the same way", async () => {
    cleanup();
    getAddressCoreStats.mockImplementation(async (address: string) => {
      if (address === ADDR_B) {
        throw new Error("Request failed: 429 Too Many Requests");
      }
      return { txCount: 1, receivedSats: 5000, sentSats: 0, balanceSats: 5000 };
    });

    render(<AddressChecker />);
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: `${ADDR_A}\n${ADDR_B}\n${ADDR_C}` },
    });
    fireEvent.click(screen.getByTestId("button-run-check"));

    await waitFor(() => {
      expect(screen.getByTestId("button-reset-check")).toBeTruthy();
    });

    expect(within(screen.getByTestId("row-address-0")).getByText("Done")).toBeTruthy();
    expect(within(screen.getByTestId("row-address-1")).getByText("Error")).toBeTruthy();
    expect(
      within(screen.getByTestId("row-address-1")).getByText("Request failed: 429 Too Many Requests"),
    ).toBeTruthy();
    expect(within(screen.getByTestId("row-address-2")).getByText("Done")).toBeTruthy();
  });
});
