// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockQueryReturn,
}));

const mockToArray = vi.fn(() => Promise.resolve([]));
const mockCount = vi.fn(() => Promise.resolve(0));
const mockAnyOfCount = vi.fn(() => Promise.resolve(0));

vi.mock("@/lib/database", () => ({
  db: {
    records: {
      orderBy: () => ({
        reverse: () => ({
          limit: () => ({ toArray: () => mockToArray() }),
          filter: () => ({
            limit: () => ({ toArray: () => mockToArray() }),
            offset: () => ({ limit: () => ({ toArray: () => mockToArray() }) }),
          }),
          offset: () => ({ limit: () => ({ toArray: () => mockToArray() }) }),
        }),
      }),
      count: () => mockCount(),
      where: () => ({
        anyOf: () => ({
          count: () => mockAnyOfCount(),
          toArray: () => Promise.resolve([]),
          map: () => ({ toArray: () => Promise.resolve([]) }),
        }),
        equals: () => ({
          filter: () => ({ limit: () => ({ toArray: () => mockToArray() }) }),
        }),
        equalsIgnoreCase: () => ({ first: () => Promise.resolve(undefined) }),
      }),
      get: () => Promise.resolve(undefined),
    },
  },
  subscribeToDbChanges: vi.fn((_cb: unknown) => vi.fn()),
}));

vi.mock("@/lib/dataFacade", () => ({
  createRecord: vi.fn(() => Promise.resolve(1)),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
  createRecordOrigin: vi.fn(),
}));

vi.mock("@/lib/attachments", () => ({
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

import {
  useRecord,
  useRecords,
  useFilteredRecords,
  lookupRecordsByInputStrings,
  searchRecords,
} from "./use-records";

beforeEach(() => {
  mockQueryReturn = undefined;
  mockToArray.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
  mockAnyOfCount.mockResolvedValue(0);
  vi.clearAllMocks();
});

describe("useRecord", () => {
  it("returns undefined record and isLoading false when id is undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useRecord(undefined));
    expect(result.current.record).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("returns isLoading true when id is provided but query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useRecord(1));
    expect(result.current.isLoading).toBe(true);
  });

  it("returns the record when query resolves", () => {
    const mockRecord = { id: 1, label: "Test", inputString: "abc", type: "address" };
    mockQueryReturn = mockRecord;
    const { result } = renderHook(() => useRecord(1));
    expect(result.current.record).toEqual(mockRecord);
  });
});

describe("useRecords", () => {
  it("starts in loading state", () => {
    const { result } = renderHook(() => useRecords());
    expect(result.current.isLoading).toBe(true);
  });

  it("loads records and sets isLoading to false", async () => {
    const mockRecords = [
      { id: 1, label: "Rec1", inputString: "a", updatedAt: 1000 },
      { id: 2, label: "Rec2", inputString: "b", updatedAt: 2000 },
    ];
    mockToArray.mockResolvedValue(mockRecords);

    const { result } = renderHook(() => useRecords());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.records).toEqual(mockRecords);
  });

  it("returns empty array on load failure", async () => {
    mockToArray.mockRejectedValue(new Error("DB error"));

    const { result } = renderHook(() => useRecords());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.records).toEqual([]);
  });

  it("accepts a custom limit option", async () => {
    mockToArray.mockResolvedValue([]);
    const { result } = renderHook(() => useRecords({ limit: 10 }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.records).toEqual([]);
  });

  it("exposes a reload function", () => {
    const { result } = renderHook(() => useRecords());
    expect(typeof result.current.reload).toBe("function");
  });
});

describe("useFilteredRecords", () => {
  it("starts in loading state", () => {
    const { result } = renderHook(() => useFilteredRecords(true));
    expect(result.current.isLoading).toBe(true);
  });

  it("loads and returns records with counts", async () => {
    const mockRecords = [
      { id: 1, label: "Rec", inputString: "addr1", addressImportance: "manual" },
    ];
    mockToArray.mockResolvedValue(mockRecords);
    mockCount.mockResolvedValue(5);
    mockAnyOfCount.mockResolvedValue(2);

    const { result } = renderHook(() => useFilteredRecords(true));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.records).toEqual(mockRecords);
    expect(result.current.totalCount).toBe(5);
    expect(result.current.blockchainDiscoveredCount).toBe(2);
  });

  it("exposes a reload function", () => {
    const { result } = renderHook(() => useFilteredRecords(false));
    expect(typeof result.current.reload).toBe("function");
  });

  it("returns empty array on load failure", async () => {
    mockToArray.mockRejectedValue(new Error("DB error"));

    const { result } = renderHook(() => useFilteredRecords(true));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.records).toEqual([]);
  });
});

describe("lookupRecordsByInputStrings", () => {
  it("returns empty map for empty input", async () => {
    const result = await lookupRecordsByInputStrings([]);
    expect(result.size).toBe(0);
  });

  it("returns empty map for whitespace-only inputs", async () => {
    const result = await lookupRecordsByInputStrings(["  ", "", "   "]);
    expect(result.size).toBe(0);
  });
});

describe("searchRecords", () => {
  it("returns results for empty query without throwing", async () => {
    const result = await searchRecords("");
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns results for whitespace query without throwing", async () => {
    const result = await searchRecords("   ");
    expect(Array.isArray(result)).toBe(true);
  });
});
