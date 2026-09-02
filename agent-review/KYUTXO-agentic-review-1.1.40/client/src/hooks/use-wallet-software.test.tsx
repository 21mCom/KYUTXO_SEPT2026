// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => mockQueryReturn,
}));

vi.mock("@/lib/database", () => ({
  db: {
    walletSoftware: {
      orderBy: () => ({ toArray: () => Promise.resolve([]) }),
    },
  },
}));

vi.mock("@/lib/data/vocabulary-crud", () => ({
  createWalletSoftware: vi.fn(),
  updateWalletSoftware: vi.fn(),
  deleteWalletSoftware: vi.fn(),
  getWalletSoftwareUsageCount: vi.fn(),
}));

import { useWalletSoftware } from "./use-wallet-software";

describe("useWalletSoftware", () => {
  it("returns empty array and isLoading true when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useWalletSoftware());
    expect(result.current.walletSoftware).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns wallet software and isLoading false when query resolves", () => {
    mockQueryReturn = [{ id: 1, name: "Software A" }];
    const { result } = renderHook(() => useWalletSoftware());
    expect(result.current.walletSoftware).toEqual([{ id: 1, name: "Software A" }]);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useWalletSoftware());
    expect(result.current.walletSoftware).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
