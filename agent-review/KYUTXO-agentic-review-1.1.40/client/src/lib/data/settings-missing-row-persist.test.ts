// @vitest-environment jsdom
//
// Regression coverage for the "settings change silently fails to save" class of
// bug (Task #1035). Previously every settings mutator in use-settings.ts did
// `if (settings) { ... }` and quietly did nothing when the 'default' row was
// missing (e.g. mid-restore), so a user toggling a control saw it flip back with
// no explanation. The mutators now create the default row on demand via
// ensureSettings, so the change always persists.
//
// This file proves a representative mutator (a table-column toggle) — plus a few
// others spanning the different value shapes (boolean flag, numeric limit,
// nested object) — actually save when the row is absent, and that the created
// row carries sensible defaults rather than a half-populated record.
//
// Uses the real Dexie engine (via fake-indexeddb), mirroring the data-layer test
// pattern in settings-privacy-view-prefs.test.ts.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

const {
  toggleTableColumn,
  updateDisableOrphanCheck,
  updateFundTrailTxLimit,
  updateHoverTooltipPrefs,
} = await import("@/hooks/use-settings");
const { getSettings } = await import("./settings-crud");

beforeEach(async () => {
  testDb = new TestDb(`KYUTXO-settings-missing-row-${Date.now()}-${Math.random()}`);
  await testDb.open();
  // Intentionally do NOT seed a 'default' row: every test here exercises the
  // missing-row case.
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("settings mutators with the 'default' row absent", () => {
  it("toggleTableColumn creates the row and persists the toggle", async () => {
    expect(await getSettings("default")).toBeUndefined();

    // 'balance' defaults to false, so toggling it should flip it to true and
    // save — not silently no-op leaving the user thinking it applied.
    await toggleTableColumn("balance");

    const stored = await getSettings("default");
    expect(stored).toBeDefined();
    expect(stored?.tableColumns?.balance).toBe(true);
    // The rest of the created row carries sensible defaults rather than being
    // a half-populated record.
    expect(stored?.tableColumns?.tags).toBe(true);
    expect(stored?.fieldVisibility?.owner).toBe(true);

    // A second toggle flips it back, proving the created row is read back and
    // mutated consistently.
    await toggleTableColumn("balance");
    expect((await getSettings("default"))?.tableColumns?.balance).toBe(false);
  });

  it("updateDisableOrphanCheck creates the row and persists the flag", async () => {
    await updateDisableOrphanCheck(true);
    const stored = await getSettings("default");
    expect(stored).toBeDefined();
    expect(stored?.disableOrphanCheck).toBe(true);
  });

  it("updateFundTrailTxLimit creates the row and persists the limit", async () => {
    await updateFundTrailTxLimit(500);
    const stored = await getSettings("default");
    expect(stored).toBeDefined();
    expect(stored?.fundTrailTxLimit).toBe(500);
  });

  it("updateHoverTooltipPrefs creates the row and persists the nested pref", async () => {
    await updateHoverTooltipPrefs({ showNotes: false });
    const stored = await getSettings("default");
    expect(stored).toBeDefined();
    expect(stored?.hoverTooltipPrefs?.showNotes).toBe(false);
    // Unspecified prefs fall back to their defaults (showOwner defaults true).
    expect(stored?.hoverTooltipPrefs?.showOwner).toBe(true);
  });
});
