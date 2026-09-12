// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("@/lib/data/vocabulary-crud", () => ({
  getTags: vi.fn(() =>
    mockQueryReturn === undefined ? new Promise(() => {}) : Promise.resolve(mockQueryReturn ?? [])),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
  getTagUsageCount: vi.fn(),
}));

import { useTags } from "./use-tags";

describe("useTags", () => {
  it("returns empty array and isLoading true when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useTags());
    expect(result.current.tags).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns tags and isLoading false when query resolves", async () => {
    mockQueryReturn = [{ id: 1, name: "Tag A" }, { id: 2, name: "Tag B" }];
    const { result } = renderHook(() => useTags());
    await waitFor(() => expect(result.current.tags).toEqual([
      { id: 1, name: "Tag A" },
      { id: 2, name: "Tag B" },
    ]));
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", async () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useTags());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.tags).toEqual([]);
  });
});
