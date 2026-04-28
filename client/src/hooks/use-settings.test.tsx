// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let mockQueryReturn: unknown = undefined;
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => mockQueryReturn,
}));

vi.mock("@/lib/database", () => ({
  db: {
    settings: {
      get: () => Promise.resolve(undefined),
      update: vi.fn(),
    },
    customFields: {
      toArray: () => Promise.resolve([]),
      where: () => ({ equals: () => ({ first: () => Promise.resolve(undefined) }) }),
      add: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { useSettings, useCustomFields } from "./use-settings";

describe("useSettings", () => {
  it("returns null settings and isLoading true when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("returns default tableColumns when settings has no tableColumns", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useSettings());
    expect(result.current.tableColumns).toHaveProperty("tags");
    expect(result.current.tableColumns.tags).toBe(true);
  });

  it("returns settings and isLoading false when query resolves", () => {
    const mockSettings = {
      id: "default",
      tableColumns: { tags: false, categories: true, walletSoftware: false, seedName: false, privateKeyStatus: false, hasAttachments: true, owner: false, walletName: false, source: false, firstSeen: false, balance: false, lastTxDate: false, txCount: false },
      customFieldColumns: { custom1: true },
      fieldVisibility: { seedName: true, walletSoftware: true, privateKeyStatus: false, owner: true, walletName: true, source: true },
    };
    mockQueryReturn = mockSettings;
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual(mockSettings);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.tableColumns.tags).toBe(false);
    expect(result.current.customFieldColumns).toEqual({ custom1: true });
  });

  it("returns default fieldVisibility when settings has no fieldVisibility", () => {
    mockQueryReturn = { id: "default" };
    const { result } = renderHook(() => useSettings());
    expect(result.current.fieldVisibility).toHaveProperty("seedName");
    expect(result.current.fieldVisibility.seedName).toBe(true);
  });

  it("returns empty customFieldColumns when settings has none", () => {
    mockQueryReturn = { id: "default" };
    const { result } = renderHook(() => useSettings());
    expect(result.current.customFieldColumns).toEqual({});
  });
});

describe("useCustomFields", () => {
  it("returns empty array and isLoading true when query returns undefined", () => {
    mockQueryReturn = undefined;
    const { result } = renderHook(() => useCustomFields());
    expect(result.current.customFields).toEqual([]);
    expect(result.current.enabledCustomFields).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("returns custom fields and filters enabled ones", () => {
    mockQueryReturn = [
      { id: 1, name: "Field A", slug: "field_a", enabled: true, createdAt: 1000 },
      { id: 2, name: "Field B", slug: "field_b", enabled: false, createdAt: 2000 },
    ];
    const { result } = renderHook(() => useCustomFields());
    expect(result.current.customFields).toHaveLength(2);
    expect(result.current.enabledCustomFields).toHaveLength(1);
    expect(result.current.enabledCustomFields[0].name).toBe("Field A");
    expect(result.current.isLoading).toBe(false);
  });
});
