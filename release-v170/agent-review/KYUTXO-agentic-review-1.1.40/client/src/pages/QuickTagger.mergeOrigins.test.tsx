// @vitest-environment jsdom
//
// Task #1722 — Quick Tagger's merge branch previously called updateRecord
// without recording the incoming metadata, so a merge could never surface on
// the Conflict Resolution page. This proves the full page flow (paste →
// parse → metadata → apply) now writes BOTH the baseline origin (backfilled
// for origin-less records) and the quick-tagger incoming origin, and that the
// resulting disagreement is detectable.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, RecordOrigin } from "@/lib/database";
import { TestProviders } from "@/test/testProviders";

// jsdom has no matchMedia; page components (ScrollPositionIndicator,
// use-mobile, etc.) query it at mount.
window.matchMedia =
  window.matchMedia ||
  ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  recordOrigins!: Table<RecordOrigin, number>;
  tags!: Table<any, number>;
  categories!: Table<any, number>;
  owners!: Table<any, number>;
  walletNames!: Table<any, number>;
  seedNames!: Table<any, number>;
  walletSoftware!: Table<any, number>;
  customFields!: Table<any, number>;
  recordAttachments!: Table<any, number>;
  settings!: Table<any, string>;
  nodeSettings!: Table<any, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      records:
        "++id, type, inputString, inputStringLower, label, owner, walletName, " +
        "seedName, walletSoftware, *tags, *categories, createdAt, updatedAt, " +
        "chainType, syncDepth, addressImportance, [type+addressImportance], " +
        "[addressImportance+id], [type+id], [owner+id], [walletName+id], " +
        "flowType, discoveredFromRecordId",
      recordOrigins: "++id, recordId, originType, createdAt",
      tags: "++id, name, createdAt",
      categories: "++id, name, createdAt",
      owners: "++id, name, createdAt",
      walletNames: "++id, name, createdAt",
      seedNames: "++id, name, createdAt",
      walletSoftware: "++id, name, createdAt",
      customFields: "++id, slug, enabled, createdAt",
      recordAttachments: "++id, recordId, createdAt",
      settings: "id",
      nodeSettings: "id",
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
    get db() {
      return testDb;
    },
  };
});

testDb = new TestDb(`KYUTXO-qtmerge-${Date.now()}-${Math.random()}`);

const { default: QuickTagger } = await import("./QuickTagger");
const { createRecord, getRecord } = await import("@/lib/data/record-crud");
const { getRecordOriginsByRecordId } = await import(
  "@/lib/data/record-origins-crud"
);
const { detectSingularFieldConflicts } = await import(
  "@/lib/conflict-detection"
);

// Real, checksum-valid mainnet bech32 address (parse validates input).
const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

beforeEach(async () => {
  await Promise.all(testDb.tables.map((t) => t.clear()));
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await testDb.delete();
});

describe("QuickTagger merge path — origin capture", () => {
  it("applying metadata to an existing record writes baseline + incoming origins and surfaces the conflict", async () => {
    const id = (await createRecord({
      type: "address",
      inputString: ADDR,
      label: "Old label",
      tags: [],
      categories: [],
      owner: "Alice",
      source: "manual",
    } as any)) as number;
    expect(await getRecordOriginsByRecordId(id)).toHaveLength(0);

    render(
      <TestProviders>
        <QuickTagger />
      </TestProviders>,
    );

    // Paste → parse
    fireEvent.change(await screen.findByTestId("textarea-paste-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-parse-entries"));

    // Review step → continue once the entry is parsed & selected
    const continueBtn = await screen.findByTestId("button-continue-to-metadata");
    await waitFor(() => {
      expect((continueBtn as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(continueBtn);

    // Metadata step → set a differing label, apply
    fireEvent.change(await screen.findByTestId("input-label"), {
      target: { value: "Fresh label" },
    });
    fireEvent.click(screen.getByTestId("button-apply-metadata"));

    // The merge writes the update AND both origin rows.
    await waitFor(
      async () => {
        expect(await getRecordOriginsByRecordId(id)).toHaveLength(2);
      },
      { timeout: 10000 },
    );

    const origins = await getRecordOriginsByRecordId(id);
    const sorted = [...origins].sort((a, b) => a.createdAt - b.createdAt);
    const [baseline, incoming] = sorted;

    expect(baseline.originType).toBe("manual");
    expect(baseline.label).toBe("Old label");
    expect(baseline.owner).toBe("Alice");

    expect(incoming.originType).toBe("bulk-import");
    expect(incoming.source).toBe("quick-tagger");
    expect(incoming.label).toBe("Fresh label");

    // Merge outcome: Quick Tagger applies the new label; the disagreement is
    // now detectable instead of auto-hidden.
    const updated = (await getRecord(id))!;
    expect(updated.label).toBe("Fresh label");
    const conflicts = detectSingularFieldConflicts(updated, origins);
    expect(conflicts.map((c) => c.field.key)).toContain("label");
  }, 20000);

  // Task #1957 — real vaults contain records saved WITHOUT tags/categories
  // arrays (fields stored undefined). The merge branch used to spread
  // existingRecord.tags/categories unguarded, so bulk apply crashed with
  // "TypeError: existingRecord.tags is not iterable" and zero records updated.
  it("bulk apply succeeds on a record saved without tags/categories arrays", async () => {
    const id = (await createRecord({
      type: "address",
      inputString: ADDR,
      label: "Sparse row",
      source: "manual",
      // No tags, no categories — stored as undefined, as in real vaults.
    } as any)) as number;
    const sparse = (await getRecord(id))!;
    expect(sparse.tags).toBeUndefined();
    expect(sparse.categories).toBeUndefined();

    render(
      <TestProviders>
        <QuickTagger />
      </TestProviders>,
    );

    fireEvent.change(await screen.findByTestId("textarea-paste-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-parse-entries"));

    const continueBtn = await screen.findByTestId("button-continue-to-metadata");
    await waitFor(() => {
      expect((continueBtn as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(continueBtn);

    fireEvent.change(await screen.findByTestId("input-label"), {
      target: { value: "Tagged now" },
    });
    fireEvent.click(screen.getByTestId("button-apply-metadata"));

    // The merge must complete (update + baseline/incoming origins) instead of
    // crashing on the missing arrays.
    await waitFor(
      async () => {
        expect(await getRecordOriginsByRecordId(id)).toHaveLength(2);
      },
      { timeout: 10000 },
    );

    const updated = (await getRecord(id))!;
    expect(updated.label).toBe("Tagged now");
    // Missing arrays are treated as empty, not dropped or crashed on.
    expect(updated.tags).toEqual([]);
    expect(updated.categories).toEqual([]);
  }, 20000);
});
