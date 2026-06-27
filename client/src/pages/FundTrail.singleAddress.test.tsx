// @vitest-environment jsdom
//
// Single-address tracing mode tests: when the user switches Fund Trail to
// "By address" mode and enters a valid Bitcoin address, the trail runs for
// that one address. Invalid addresses are rejected with an inline error before
// any query fires. Group mode is unaffected.
//
// The engine seam (computeOneHop) is a spy; address/group-data loaders return
// fixed fixtures. These tests verify: (1) switching modes, (2) invalid-address
// rejection, (3) valid address → trail renders with address center node and
// known record label, and (4) group mode still works after switching back.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TrailHop } from "@/lib/data/fund-trail-engine";

// ResizeObserver shim (some shadcn primitives reach for it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// --- useSettings ---
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ fundTrailTxLimit: 2000 }),
}));

// --- toast / record-preview ---
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview: vi.fn(),
    openRecordPreviewByAddress: vi.fn(),
  }),
}));

// --- Swap Radix Select for a native <select> ---
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = () => null;
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children }: any) => {
      let testid: string | undefined;
      React.Children.forEach(children, (child: any) => {
        if (child && child.type && child.type.__isTrigger) {
          testid = child.props["data-testid"];
        }
      });
      return React.createElement(
        "select",
        {
          "data-testid": testid,
          value: value ?? "",
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) =>
      React.createElement("option", { value }, children),
  };
});

// --- bitcoin validator: controlled stub so tests don't depend on bitcoinjs-lib
// checksum validation in jsdom (strict bech32 can reject perfectly good-looking
// addresses in the test environment).
const VALID_ADDRESS = "bc1qtest-valid-address-for-fund-trail-unit-tests";
const INVALID_ADDRESS = "not-an-address";
const NO_RECORD_ADDRESS = "bc1qno-record-address-unit-test";

vi.mock("@/lib/bitcoin", () => ({
  validateAddress: vi.fn((addr: string) => {
    const valid = addr === VALID_ADDRESS || addr === NO_RECORD_ADDRESS;
    return { isValid: valid, type: valid ? ("address" as const) : undefined };
  }),
  truncateAddress: (addr: string, start = 10, end = 10) => {
    if (addr.length <= start + end) return addr;
    return `${addr.slice(0, start)}...${addr.slice(-end)}`;
  },
}));

// A group name used in group-mode tests.
const GROUP = "TestWallet";

// Minimal trail hop with one source.
function hopWithSource(label: string): TrailHop {
  return {
    sources: [
      {
        groupLabel: label,
        dimension: "walletName",
        totalSats: 50000,
        details: [
          {
            address: "1ABC" + label,
            txid: "tx" + label,
            amount: 50000,
            blockTime: 1700000000,
          },
        ],
        isUnknown: false,
      },
    ],
    destinations: [],
    isCapped: false,
    shownTxCount: 1,
    totalTxCount: 1,
  };
}

const computeOneHopSpy = vi.fn(async (): Promise<TrailHop> => hopWithSource("Source"));

vi.mock("@/lib/data/fund-trail-engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/fund-trail-engine")>(
    "@/lib/data/fund-trail-engine",
  );
  return {
    ...actual,
    listGroupValues: vi.fn(async () => [GROUP]),
    getAddressesForGroup: vi.fn(async () => [{ inputString: "addr-1" }]),
    getRecordByAddress: vi.fn(async (addr: string) => {
      // Return a record with a walletName for the VALID_ADDRESS only
      if (addr === VALID_ADDRESS) {
        return { id: 1, inputString: addr, walletName: "MyKnownWallet", owner: "", seedName: "" };
      }
      return undefined;
    }),
    computeOneHop: (...args: unknown[]) =>
      (computeOneHopSpy as unknown as (...a: unknown[]) => Promise<TrailHop>)(...args),
  };
});

const { default: FundTrail } = await import("./FundTrail");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FundTrail />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  computeOneHopSpy.mockReset();
  computeOneHopSpy.mockResolvedValue(hopWithSource("Source"));
});

afterEach(() => {
  cleanup();
});

describe("FundTrail single-address mode", () => {
  it("renders mode toggle buttons in default (group) mode", async () => {
    renderPage();
    expect(screen.getByTestId("fund-trail-mode-group")).toBeTruthy();
    expect(screen.getByTestId("fund-trail-mode-address")).toBeTruthy();
    // Group controls visible by default (after groups load)
    expect(screen.getByTestId("fund-trail-dimension-select")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("fund-trail-group-select")).toBeTruthy(),
    );
    // Address input not visible in group mode
    expect(screen.queryByTestId("fund-trail-address-input")).toBeNull();
  });

  it("switches to address mode and shows address input", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("fund-trail-mode-address"));
    // Address input appears
    expect(screen.getByTestId("fund-trail-address-input")).toBeTruthy();
    // Group controls hidden
    expect(screen.queryByTestId("fund-trail-group-select")).toBeNull();
  });

  it("shows inline error for an invalid address", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("fund-trail-mode-address"));
    fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
      target: { value: INVALID_ADDRESS },
    });
    expect(screen.getByTestId("fund-trail-address-error")).toBeTruthy();
    expect(screen.getByTestId("fund-trail-address-error").textContent).toContain(
      "valid Bitcoin address",
    );
    // No trail should have been computed
    expect(computeOneHopSpy).not.toHaveBeenCalled();
  });

  it("clears the error when a valid address replaces an invalid one", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("fund-trail-mode-address"));
    fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
      target: { value: INVALID_ADDRESS },
    });
    expect(screen.getByTestId("fund-trail-address-error")).toBeTruthy();

    fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
      target: { value: VALID_ADDRESS },
    });
    expect(screen.queryByTestId("fund-trail-address-error")).toBeNull();
  });

  it("runs computeOneHop with the single address and null selfGroupLabel", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("fund-trail-mode-address"));
    fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
      target: { value: VALID_ADDRESS },
    });

    await waitFor(() => {
      expect(computeOneHopSpy).toHaveBeenCalled();
    });

    const call = computeOneHopSpy.mock.calls[0];
    // addresses: single-element array with the entered address
    expect(call[0]).toEqual([VALID_ADDRESS]);
    // selfGroupLabel must be null (not the address itself)
    expect(call[2]).toBeNull();
    // last arg carries the txLimit
    expect(call[5]).toEqual(expect.objectContaining({ txLimit: 2000 }));
  });

  it("renders sources and the address center node after a valid address trail", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("fund-trail-mode-address"));
    fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
      target: { value: VALID_ADDRESS },
    });

    // Wait for the trail body
    await screen.findByTestId("fund-trail-body");

    // Center node must be present and show "Address" mode display
    const centerNode = screen.getByTestId("fund-trail-center-node");
    expect(centerNode).toBeTruthy();
    // The truncated address is shown (first 8 chars of VALID_ADDRESS)
    const addrEl = screen.getByTestId("fund-trail-center-address");
    expect(addrEl.textContent).toContain(VALID_ADDRESS.slice(0, 8));

    // Known record label should appear
    await waitFor(() => {
      const label = screen.queryByTestId("fund-trail-center-record-label");
      expect(label).toBeTruthy();
      expect(label?.textContent).toContain("MyKnownWallet");
    });

    // Source flow card rendered
    expect(screen.getByTestId("fund-trail-flow-card-Source-d0")).toBeTruthy();
  });

  it("does not show record label when address has no matching record", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("fund-trail-mode-address"));
    fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
      target: { value: NO_RECORD_ADDRESS },
    });

    await screen.findByTestId("fund-trail-body");

    // Record label element should not be present
    expect(screen.queryByTestId("fund-trail-center-record-label")).toBeNull();
  });

  it("switching back to group mode restores group controls and clears address trail", async () => {
    renderPage();

    // Switch to address mode and enter valid address
    fireEvent.click(screen.getByTestId("fund-trail-mode-address"));
    fireEvent.change(screen.getByTestId("fund-trail-address-input"), {
      target: { value: VALID_ADDRESS },
    });
    await screen.findByTestId("fund-trail-body");

    // Switch back to group mode
    fireEvent.click(screen.getByTestId("fund-trail-mode-group"));

    // Group controls re-appear
    expect(screen.getByTestId("fund-trail-dimension-select")).toBeTruthy();
    expect(screen.getByTestId("fund-trail-group-select")).toBeTruthy();
    // Address input gone
    expect(screen.queryByTestId("fund-trail-address-input")).toBeNull();
    // Trail body gone (no group selected)
    expect(screen.queryByTestId("fund-trail-body")).toBeNull();
  });

  it("group mode still works: selecting a group renders a group trail", async () => {
    renderPage();

    // Remain in group mode and select a group
    await waitFor(() => {
      const sel = screen.getByTestId("fund-trail-group-select") as HTMLSelectElement;
      expect(Array.from(sel.options).some(o => o.value === GROUP)).toBe(true);
    });
    fireEvent.change(screen.getByTestId("fund-trail-group-select"), {
      target: { value: GROUP },
    });

    await screen.findByTestId("fund-trail-body");

    // Center node shows group label, not address
    expect(screen.queryByTestId("fund-trail-center-address")).toBeNull();
    expect(screen.getByTestId("fund-trail-center-node").textContent).toContain(GROUP);

    // computeOneHop called with the group label as selfGroupLabel (not null)
    const calls = computeOneHopSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    // arg[2] must be the group label, NOT null
    expect(firstCall[2]).toBe(GROUP);
  });
});
