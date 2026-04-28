// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => mockQueryReturn,
}));

vi.mock("@/lib/database", () => ({
  db: {
    categories: {
      orderBy: () => ({ toArray: () => Promise.resolve([]) }),
    },
  },
}));

vi.mock("@/lib/data/vocabulary-crud", () => ({
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  getCategoryUsageCount: vi.fn(),
}));

import { useCategories } from "./use-categories";

describe("useCategories", () => {
  it("returns empty array and isLoading true when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useCategories());
    expect(result.current.categories).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns categories and isLoading false when query resolves", () => {
    mockQueryReturn = [{ id: 1, name: "Cat A" }, { id: 2, name: "Cat B" }];
    const { result } = renderHook(() => useCategories());
    expect(result.current.categories).toEqual([
      { id: 1, name: "Cat A" },
      { id: 2, name: "Cat B" },
    ]);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useCategories());
    expect(result.current.categories).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
