// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => mockQueryReturn,
}));

vi.mock("@/lib/database", () => ({
  db: {
    walletNames: {
      orderBy: () => ({ toArray: () => Promise.resolve([]) }),
    },
  },
}));

vi.mock("@/lib/data/vocabulary-crud", () => ({
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

  it("returns wallet names and isLoading false when query resolves", () => {
    mockQueryReturn = [{ id: 1, name: "Wallet A" }];
    const { result } = renderHook(() => useWalletNames());
    expect(result.current.walletNames).toEqual([{ id: 1, name: "Wallet A" }]);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useWalletNames());
    expect(result.current.walletNames).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
