// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("@/lib/data/vocabulary-crud", () => ({
  getOwners: vi.fn(() =>
    mockQueryReturn === undefined ? new Promise(() => {}) : Promise.resolve(mockQueryReturn ?? [])),
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

  it("returns owners and isLoading false when query resolves", async () => {
    mockQueryReturn = [{ id: 1, name: "Owner A" }];
    const { result } = renderHook(() => useOwners());
    await waitFor(() => expect(result.current.owners).toEqual([{ id: 1, name: "Owner A" }]));
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", async () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useOwners());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.owners).toEqual([]);
  });
});
