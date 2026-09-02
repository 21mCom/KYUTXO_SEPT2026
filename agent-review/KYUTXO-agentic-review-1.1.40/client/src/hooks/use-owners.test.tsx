// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => mockQueryReturn,
}));

vi.mock("@/lib/database", () => ({
  db: {
    owners: {
      orderBy: () => ({ toArray: () => Promise.resolve([]) }),
    },
  },
}));

vi.mock("@/lib/data/vocabulary-crud", () => ({
  createOwner: vi.fn(),
  updateOwner: vi.fn(),
  deleteOwner: vi.fn(),
  getOwnerUsageCount: vi.fn(),
}));

import { useOwners } from "./use-owners";

describe("useOwners", () => {
  it("returns empty array and isLoading true when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useOwners());
    expect(result.current.owners).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns owners and isLoading false when query resolves", () => {
    mockQueryReturn = [{ id: 1, name: "Owner A" }];
    const { result } = renderHook(() => useOwners());
    expect(result.current.owners).toEqual([{ id: 1, name: "Owner A" }]);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useOwners());
    expect(result.current.owners).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
