// @vitest-environment jsdom
//
// Regression guard for the Fund Trail "Layout" choice persisting across reload.
// This was previously only confirmed via a one-time real-browser run (testing
// skill / runTest), which does not execute in CI and so couldn't catch a future
// refactor silently breaking the wiring between the Layout Select,
// updateFundTrailLayout, and the useSettings read.
//
// These tests use the real Dexie engine (via fake-indexeddb) so the write
// genuinely persists and the live read genuinely reflects it, mirroring the
// data-layer test pattern in settings-privacy-view-prefs.test.ts. The hook read
// is exercised through useSettings() (useLiveQuery over the same store) so the
// full write -> persist -> read-back chain is covered, not just the mutator.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import Dexie, { type Table } from "dexie";
import type { Settings } from "@/lib/db-types";

class TestDb extends Dexie {
  settings!: Table<Settings, string>;
  constructor(name: string) {
    super(name);
    // Mirrors the settings schema in database.ts.
    this.version(1).stores({
      settings: "id",
    });
  }
}

let testDb: TestDb;

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<typeof import("@/lib/database")>(
    "@/lib/database",
  );
  return {
    ...actual,
    // Re-read the live binding each time so beforeEach can swap the instance.
    get db() {
      return testDb;
    },
    notifyDbChange: vi.fn(),
  };
});

const { useSettings, updateFundTrailLayout } = await import("./use-settings");
const { getSettings } = await import("@/lib/data/settings-crud");

beforeEach(async () => {
  testDb = new TestDb(
    `KYUTXO-fund-trail-layout-${Date.now()}-${Math.random()}`,
  );
  await testDb.open();
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("updateFundTrailLayout persistence", () => {
  it("writes settings.fundTrailLayout so useSettings reads it back", async () => {
    await updateFundTrailLayout("sankey");

    // The mutator persisted the chosen layout to the settings store.
    const stored = await getSettings("default");
    expect(stored).toBeDefined();
    expect(stored?.fundTrailLayout).toBe("sankey");

    // useSettings() reads the persisted value back as the active layout.
    const { result } = renderHook(() => useSettings());
    await waitFor(() => {
      expect(result.current.fundTrailLayout).toBe("sankey");
    });
  });

  it("defaults to 'classic' when no layout has been chosen", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => {
      // Loading completes (settings row is absent -> null, not undefined).
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.fundTrailLayout).toBe("classic");
  });

  it("round-trips a changed layout back to a non-default value", async () => {
    await updateFundTrailLayout("sankey");
    await updateFundTrailLayout("horizontal");

    const stored = await getSettings("default");
    expect(stored?.fundTrailLayout).toBe("horizontal");

    const { result } = renderHook(() => useSettings());
    await waitFor(() => {
      expect(result.current.fundTrailLayout).toBe("horizontal");
    });
  });
});
