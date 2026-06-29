// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

// BitcoinFlowVisualizer.tsx imports a large surface (IndexedDB-backed db,
// data facade, page hooks, child components). We only need the isolated
// AddressFinderRow, so stub the heavy modules to keep the import cheap.
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return { ...actual, db: {} };
});
vi.mock("@/lib/dataFacade", () => ({ getParticipantsByAddresses: vi.fn() }));
vi.mock("@/hooks/use-flow-data", () => ({ useFlowData: () => ({}) }));
vi.mock("@/hooks/use-page-shortcuts", () => ({ usePageShortcuts: vi.fn() }));
vi.mock("@/hooks/use-owners", () => ({ useOwners: () => ({ owners: [] }) }));
vi.mock("@/hooks/use-wallet-names", () => ({ useWalletNames: () => ({ walletNames: [] }) }));
vi.mock("@/hooks/use-tags", () => ({ useTags: () => ({ tags: [] }) }));
vi.mock("@/components/HopPathExplorer", () => ({ HopPathExplorer: () => null }));
vi.mock("@/components/RecordDetailPanel", () => ({ RecordDetailPanel: () => null }));
vi.mock("@/components/ScrollPositionIndicator", () => ({ ScrollPositionIndicator: () => null }));

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import { AddressFinderRow } from "./BitcoinFlowVisualizer";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

const baseAddr = {
  address: ADDRESS,
  label: "Cold storage",
  balanceSats: 100000000,
  lastTxDate: 1700000000000,
  txCount: 3,
};

function renderRow(onSelect = vi.fn()) {
  render(
    <AddressFinderRow
      addr={baseAddr}
      onSelect={onSelect}
      satsToBtcDisplay={(sats) => (sats / 1e8).toFixed(8)}
      formatDate={() => "2023-11-14"}
      rowHeight={44}
    />,
  );
  return onSelect;
}

let writeText: ReturnType<typeof vi.fn>;

// Flush pending promise microtasks (and the React state updates they trigger).
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("BitcoinFlowVisualizer AddressFinderRow copy button", () => {
  const copyTestId = `button-copy-finder-address-${ADDRESS.slice(-8)}`;

  it("writes the correct address to the clipboard on click", () => {
    renderRow();
    fireEvent.click(screen.getByTestId(copyTestId));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
  });

  it("switches to the Check (copied) state and resets after 2s", async () => {
    vi.useFakeTimers();
    renderRow();
    const btn = screen.getByTestId(copyTestId);

    expect(btn.getAttribute("aria-label")).toBe("Copy address");

    fireEvent.click(btn);
    await flush();
    expect(btn.getAttribute("aria-label")).toBe("Copied");

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(btn.getAttribute("aria-label")).toBe("Copied");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(btn.getAttribute("aria-label")).toBe("Copy address");
  });

  it("does not trigger the parent row onSelect handler (stopPropagation)", () => {
    const onSelect = renderRow();
    fireEvent.click(screen.getByTestId(copyTestId));
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still lets a click on the row itself select the address", () => {
    const onSelect = renderRow();
    fireEvent.click(screen.getByTestId(`button-finder-address-${ADDRESS.slice(-8)}`));
    expect(onSelect).toHaveBeenCalledWith(ADDRESS);
  });

  it("copies via keyboard activation (Enter and Space) without selecting the row", async () => {
    const onSelect = renderRow();
    const btn = screen.getByTestId(copyTestId);

    fireEvent.keyDown(btn, { key: "Enter" });
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute("aria-label")).toBe("Copied");

    fireEvent.keyDown(btn, { key: " " });
    expect(writeText).toHaveBeenCalledTimes(2);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not show the copied state and surfaces a toast when the clipboard write is rejected", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    const onSelect = renderRow();
    const btn = screen.getByTestId(copyTestId);

    fireEvent.click(btn);
    await flush();

    expect(btn.getAttribute("aria-label")).toBe("Copy address");
    expect(onSelect).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("does not show the copied state and surfaces a toast when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const onSelect = renderRow();
    const btn = screen.getByTestId(copyTestId);

    fireEvent.click(btn);
    await flush();

    expect(btn.getAttribute("aria-label")).toBe("Copy address");
    expect(onSelect).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });
});
