// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => mockQueryReturn,
}));

vi.mock("@/lib/database", () => ({
  db: {
    tags: {
      orderBy: () => ({ toArray: () => Promise.resolve([]) }),
    },
  },
}));

vi.mock("@/lib/data/vocabulary-crud", () => ({
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

  it("returns tags and isLoading false when query resolves", () => {
    mockQueryReturn = [{ id: 1, name: "Tag A" }, { id: 2, name: "Tag B" }];
    const { result } = renderHook(() => useTags());
    expect(result.current.tags).toEqual([
      { id: 1, name: "Tag A" },
      { id: 2, name: "Tag B" },
    ]);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useTags());
    expect(result.current.tags).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
