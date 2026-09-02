// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => mockQueryReturn,
}));

vi.mock("@/lib/database", () => ({
  db: {
    seedNames: {
      orderBy: () => ({ toArray: () => Promise.resolve([]) }),
    },
  },
}));

vi.mock("@/lib/data/vocabulary-crud", () => ({
  createSeedName: vi.fn(),
  updateSeedName: vi.fn(),
  deleteSeedName: vi.fn(),
  getSeedNameUsageCount: vi.fn(),
  SEED_NAME_MAX_LENGTH: 100,
}));

import { useSeedNames } from "./use-seed-names";

describe("useSeedNames", () => {
  it("returns empty array and isLoading true when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useSeedNames());
    expect(result.current.seedNames).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns seed names and isLoading false when query resolves", () => {
    mockQueryReturn = [{ id: 1, name: "Seed A" }];
    const { result } = renderHook(() => useSeedNames());
    expect(result.current.seedNames).toEqual([{ id: 1, name: "Seed A" }]);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty array when query returns null", () => {
    mockQueryReturn = null;
    const { result } = renderHook(() => useSeedNames());
    expect(result.current.seedNames).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
