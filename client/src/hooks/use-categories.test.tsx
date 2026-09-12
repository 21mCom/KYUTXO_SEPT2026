// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("@/lib/data/vocabulary-crud", () => ({
  getCategories: vi.fn(() =>
    mockQueryReturn === undefined ? new Promise(() => {}) : Promise.resolve(mockQueryReturn ?? [])),
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

  it("returns categories and isLoading false when query resolves", async () => {
    mockQueryReturn = [{ id: 1, name: "Cat A" }, { id: 2, name: "Cat B" }];
    const { result } = renderHook(() => useCategories());
    await waitFor(() => expect(result.current.categories).toEqual([
      { id: 1, name: "Cat A" },
      { id: 2, name: "Cat B" },
    ]));
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", async () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useCategories());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.categories).toEqual([]);
  });
});
