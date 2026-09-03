// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.fn();
const mockOpenRecordPreview = vi.fn(() => Promise.resolve());
const mockGetRecordsByInputString = vi.fn();
const mockSearchVisibleRecordsBounded = vi.fn();

vi.mock("wouter", () => ({
  useLocation: () => ["/", mockNavigate],
}));

vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview: mockOpenRecordPreview,
  }),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByInputString: (...args: unknown[]) => mockGetRecordsByInputString(...args),
  searchVisibleRecordsBounded: (...args: unknown[]) => mockSearchVisibleRecordsBounded(...args),
}));

vi.mock("@/lib/records-query", () => ({
  looksLikeBitcoinIdentifier: (value: string) =>
    /^[0-9a-f]{64}$/i.test(value.trim()) ? value.trim() : null,
}));

import { GlobalCommandPalette } from "./GlobalCommandPalette";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

function openPalette() {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
}

async function typeAndDebounce(value: string) {
  fireEvent.change(screen.getByTestId("input-command-search"), {
    target: { value },
  });
  await act(async () => {
    vi.advanceTimersByTime(160);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GlobalCommandPalette", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNavigate.mockReset();
    mockOpenRecordPreview.mockClear();
    mockGetRecordsByInputString.mockReset().mockResolvedValue([]);
    mockSearchVisibleRecordsBounded.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens with Ctrl+K and supports keyboard navigation to a page", () => {
    render(<GlobalCommandPalette />);
    openPalette();

    const input = screen.getByTestId("input-command-search");
    expect(input).toBeTruthy();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockNavigate).toHaveBeenCalledWith("/nudgie");
  });

  it("finds common action aliases and navigates immediately", async () => {
    render(<GlobalCommandPalette />);
    openPalette();
    await typeAndDebounce("add address");

    fireEvent.click(screen.getByTestId("command-page-address-importer"));
    expect(mockNavigate).toHaveBeenCalledWith("/import");
  });

  it("returns metadata-only matches and opens the shared detail surface", async () => {
    const row = {
      id: 42,
      type: "address" as const,
      inputString: "bc1qexample",
      label: "Cold wallet",
      notes: "gift from alice",
      tags: [],
      categories: [],
      addressImportance: "manual" as const,
    };
    mockSearchVisibleRecordsBounded.mockResolvedValue([row]);

    render(<GlobalCommandPalette />);
    openPalette();
    await typeAndDebounce("alice");

    const result = screen.getByTestId("command-record-42");
    fireEvent.click(result);

    expect(mockSearchVisibleRecordsBounded).toHaveBeenCalledWith(
      "alice",
      {
        perIndexLimit: 50,
        recentScanLimit: 2000,
        isCancelled: expect.any(Function),
      },
    );
    expect(mockOpenRecordPreview).toHaveBeenCalledWith(42);
  });

  it("uses canonical exact lookup and does not expose hidden discovery rows", async () => {
    const txid = "A".repeat(64);
    mockGetRecordsByInputString.mockResolvedValue([
      {
        id: 77,
        type: "transaction",
        inputString: txid.toLowerCase(),
        label: "Hidden sync row",
        tags: [],
        categories: [],
        addressImportance: "pending-review",
      },
    ]);

    render(<GlobalCommandPalette />);
    openPalette();
    await typeAndDebounce(txid);

    expect(mockGetRecordsByInputString).toHaveBeenCalledWith(txid);
    expect(screen.queryByTestId("command-record-77")).toBeNull();
    expect(mockSearchVisibleRecordsBounded).not.toHaveBeenCalled();
  });

  it("shows an empty state when no visible page or record matches", async () => {
    render(<GlobalCommandPalette />);
    openPalette();
    await typeAndDebounce("nothing-matches-this");

    expect(screen.getByText("No visible pages or vault matches.")).toBeTruthy();
  });
});