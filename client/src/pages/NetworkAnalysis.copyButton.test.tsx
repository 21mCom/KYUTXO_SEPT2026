// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

// NetworkAnalysis.tsx pulls in a heavy data/visualization surface at import
// time. We only want to exercise the isolated CopyAddressButton, so stub the
// modules that touch IndexedDB / d3 to keep the import cheap and deterministic.
vi.mock("@/lib/dataFacade", () => ({
  getRecordsByType: vi.fn(),
  countTransactionParticipants: vi.fn(),
  getAllTransactionParticipants: vi.fn(),
  getParticipantsByRecordIds: vi.fn(),
  getParticipantsByTxids: vi.fn(),
}));

vi.mock("@/lib/network-analysis", () => ({
  buildNetworkGraph: vi.fn(),
  MAX_NODES: 1000,
  getCommunityColor: vi.fn(() => "#000000"),
}));

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import { CopyAddressButton } from "./NetworkAnalysis";

const ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

let writeText: ReturnType<typeof vi.fn>;

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

describe("NetworkAnalysis CopyAddressButton", () => {
  it("writes the correct address to the clipboard on click", async () => {
    render(<CopyAddressButton address={ADDRESS} />);
    fireEvent.click(screen.getByTestId(`button-copy-network-address-${ADDRESS.slice(-8)}`));
    // The guarded copy resolves the vault record (poisoning check) before
    // writing, so wait for the asynchronous clipboard effect.
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
  });

  it("switches to the Check (copied) state and resets after 2s", async () => {
    vi.useFakeTimers();
    render(<CopyAddressButton address={ADDRESS} />);
    const btn = screen.getByTestId(`button-copy-network-address-${ADDRESS.slice(-8)}`);

    expect(btn.getAttribute("aria-label")).toBe("Copy address");

    fireEvent.click(btn);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
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

  it("does not trigger the parent click handler (stopPropagation)", async () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick} data-testid="parent">
        <CopyAddressButton address={ADDRESS} />
      </div>,
    );
    fireEvent.click(screen.getByTestId(`button-copy-network-address-${ADDRESS.slice(-8)}`));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS));
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("copies via keyboard activation (Enter and Space) without bubbling to the parent", async () => {
    const parentKeyDown = vi.fn();
    render(
      <div onKeyDown={parentKeyDown} data-testid="parent">
        <CopyAddressButton address={ADDRESS} />
      </div>,
    );
    const btn = screen.getByTestId(`button-copy-network-address-${ADDRESS.slice(-8)}`);

    fireEvent.keyDown(btn, { key: "Enter" });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(btn.getAttribute("aria-label")).toBe("Copied"));

    fireEvent.keyDown(btn, { key: " " });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));

    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("does not show the copied state and surfaces a toast when the clipboard write is rejected", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    render(<CopyAddressButton address={ADDRESS} />);
    const btn = screen.getByTestId(`button-copy-network-address-${ADDRESS.slice(-8)}`);

    fireEvent.click(btn);

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(btn.getAttribute("aria-label")).toBe("Copy address");
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
    render(<CopyAddressButton address={ADDRESS} />);
    const btn = screen.getByTestId(`button-copy-network-address-${ADDRESS.slice(-8)}`);

    fireEvent.click(btn);

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(btn.getAttribute("aria-label")).toBe("Copy address");
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });
});
