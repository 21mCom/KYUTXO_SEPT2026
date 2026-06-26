// @vitest-environment jsdom
//
// Round-trip tests for the two Privacy Audit display preferences persisted to
// the settings store: the peel-chain Graph/List toggle (peelChainViewMode) and
// the score-breakdown show/hide toggle (showScoreBreakdown). These prove the
// values written by updatePeelChainViewMode / updateShowScoreBreakdown survive
// reopening a finding or reloading the page, i.e. they are read back unchanged
// from the settings store.
//
// Uses the real Dexie engine (via fake-indexeddb), mirroring the data-layer
// test pattern in privacy-history-crud.test.ts.

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

const { updatePeelChainViewMode, updateShowScoreBreakdown } = await import(
  "@/hooks/use-settings"
);
const { getSettings } = await import("./settings-crud");

beforeEach(async () => {
  testDb = new TestDb(`KYUTXO-privacy-view-prefs-${Date.now()}-${Math.random()}`);
  await testDb.open();
  // A default settings row must exist; the update helpers are no-ops without it.
  await testDb.settings.put({ id: "default" } as Settings);
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete(testDb.name);
});

describe("updatePeelChainViewMode", () => {
  it("writes the chosen mode so it reads back from the settings store", async () => {
    await updatePeelChainViewMode("list");
    const stored = await getSettings("default");
    expect(stored?.peelChainViewMode).toBe("list");

    // Switching back persists the new value too.
    await updatePeelChainViewMode("graph");
    const reread = await getSettings("default");
    expect(reread?.peelChainViewMode).toBe("graph");
  });

  it("does nothing when no settings row exists", async () => {
    await testDb.settings.clear();
    await updatePeelChainViewMode("list");
    expect(await getSettings("default")).toBeUndefined();
  });
});

describe("updateShowScoreBreakdown", () => {
  it("writes the chosen value so it reads back from the settings store", async () => {
    await updateShowScoreBreakdown(true);
    const stored = await getSettings("default");
    expect(stored?.showScoreBreakdown).toBe(true);

    // Hiding it again persists the new value too.
    await updateShowScoreBreakdown(false);
    const reread = await getSettings("default");
    expect(reread?.showScoreBreakdown).toBe(false);
  });

  it("does nothing when no settings row exists", async () => {
    await testDb.settings.clear();
    await updateShowScoreBreakdown(true);
    expect(await getSettings("default")).toBeUndefined();
  });
});

describe("Privacy Audit view prefs persist independently", () => {
  it("updating one preference does not disturb the other", async () => {
    await updatePeelChainViewMode("list");
    await updateShowScoreBreakdown(true);

    const stored = await getSettings("default");
    expect(stored?.peelChainViewMode).toBe("list");
    expect(stored?.showScoreBreakdown).toBe(true);
  });
});
