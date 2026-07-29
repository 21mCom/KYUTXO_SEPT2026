// @vitest-environment jsdom
//
// Regression test for zero-as-dash rendering in the Address Checker table.
//
// A completed row with 0 transactions and a 0 balance must render an em dash
// (—) in the Transactions and Balance cells — the same dash used for missing
// data — instead of "0" / a formatted zero amount, so users can scan for
// active addresses quickly. Rows with activity keep rendering real numbers.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

// Radix Tooltips only render their content on hover; render the parts inline so
// the page needs no TooltipProvider in the tree.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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
const ADDR_EMPTY = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const ADDR_ACTIVE = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";

describe("AddressChecker — zero values render as em dash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAddressCoreStats.mockImplementation(async (address: string) => {
      if (address === ADDR_EMPTY) {
        return { txCount: 0, receivedSats: 0, sentSats: 0, balanceSats: 0 };
      }
      return { txCount: 3, receivedSats: 100000, sentSats: 40000, balanceSats: 60000 };
    });
  });

  it("shows dashes for a done row with 0 transactions and 0 balance, numbers for an active row", async () => {
    render(<AddressChecker />);

    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: `${ADDR_EMPTY}\n${ADDR_ACTIVE}` },
    });
    fireEvent.click(screen.getByTestId("button-run-check"));

    await waitFor(() => {
      expect(screen.getByTestId("button-reset-check")).toBeTruthy();
    });

    // Both rows completed (not pending): the zero row genuinely reached Done.
    expect(within(screen.getByTestId("row-address-0")).getByText("Done")).toBeTruthy();
    expect(within(screen.getByTestId("row-address-1")).getByText("Done")).toBeTruthy();

    // Zero row: Transactions, Received, Sent, and Balance render the em dash, not "0".
    expect(screen.getByTestId("cell-txcount-0").textContent).toBe("—");
    expect(screen.getByTestId("cell-received-0").textContent).toBe("—");
    expect(screen.getByTestId("cell-sent-0").textContent).toBe("—");
    expect(screen.getByTestId("cell-balance-0").textContent).toBe("—");

    // Active row: real numbers render exactly as before.
    expect(screen.getByTestId("cell-txcount-1").textContent).toBe("3");
    expect(screen.getByTestId("cell-received-1").textContent).toContain("0.00100000");
    expect(screen.getByTestId("cell-sent-1").textContent).toContain("0.00040000");
    expect(screen.getByTestId("cell-balance-1").textContent).toContain("0.00060000");
  });
});
