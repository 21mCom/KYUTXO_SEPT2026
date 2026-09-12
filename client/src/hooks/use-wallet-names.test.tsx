// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("@/lib/data/vocabulary-crud", () => ({
  getWalletNames: vi.fn(() =>
    mockQueryReturn === undefined ? new Promise(() => {}) : Promise.resolve(mockQueryReturn ?? [])),
  createWalletName: vi.fn(),
  updateWalletName: vi.fn(),
  deleteWalletName: vi.fn(),
  getWalletNameUsageCount: vi.fn(),
}));

import { useWalletNames } from "./use-wallet-names";

describe("useWalletNames", () => {
  it("returns empty array and isLoading true when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useWalletNames());
    expect(result.current.walletNames).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns wallet names and isLoading false when query resolves", async () => {
    mockQueryReturn = [{ id: 1, name: "Wallet A" }];
    const { result } = renderHook(() => useWalletNames());
    await waitFor(() => expect(result.current.walletNames).toEqual([{ id: 1, name: "Wallet A" }]));
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", async () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useWalletNames());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.walletNames).toEqual([]);
  });
});
