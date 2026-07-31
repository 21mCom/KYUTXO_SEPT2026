// @vitest-environment jsdom
//
// Task #1722 — the Dashboard add-record "already exists → update" path
// previously called updateRecord without recording the incoming values, so
// a form submit that merged into an existing record could never surface on
// the Conflict Resolution page. This mounts the Dashboard (heavy children
// stubbed), submits the add-record form for an address that already exists,
// and proves the shared capture wrote the baseline + incoming origins.

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

// Real, checksum-valid mainnet bech32 address (the handler validates input).
const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

// Stub the heavy children. The RecordFormDialog stub exposes a button that
// submits the same shape the real form hands to onSave. RecordPreviewProvider
// (from TestProviders) mounts its own RecordFormDialog too — it passes
// `isEditing`, which the Dashboard instance does not, so only render the
// submit button for the Dashboard's dialog.
vi.mock("@/components/RecordFormDialog", () => ({
  RecordFormDialog: (props: any) =>
    props.isEditing === undefined ? (
      <button
        data-testid="stub-form-submit"
        onClick={() =>
          props.onSave?.({
            type: "address",
            inputString: ADDR,
            label: "Imported label",
            owner: "Bob",
            tags: ["imported"],
            categories: [],
            source: "csv-import",
          })
        }
      >
        stub submit
      </button>
    ) : null,
}));
vi.mock("@/components/RecordTable", () => ({
  RecordTable: (props: any) => (
    <div data-testid="stub-record-table">
      {(props.records ?? []).map((r: any) => r.inputString).join(",")}
    </div>
  ),
}));
vi.mock("@/components/RecordCard", () => ({
  RecordCard: (props: any) => (
    <div data-testid="stub-record-card">{props.record?.inputString}</div>
  ),
}));
vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: () => null,
}));
vi.mock("@/components/DemoVaultLoader", () => ({
  DemoVaultLoader: () => null,
}));
vi.mock("@/components/FilterBar", () => ({
  FilterBar: () => null,
}));

testDb = new TestDb(`KYUTXO-dashmerge-${Date.now()}-${Math.random()}`);

const { default: Dashboard } = await import("./Dashboard");
const { createRecord, getRecord } = await import("@/lib/data/record-crud");
const { getRecordOriginsByRecordId } = await import(
  "@/lib/data/record-origins-crud"
);
const { detectSingularFieldConflicts } = await import(
  "@/lib/conflict-detection"
);

beforeEach(async () => {
  await Promise.all(testDb.tables.map((t) => t.clear()));
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await testDb.delete();
});

describe("Dashboard add-record update-existing path — origin capture", () => {
  it("submitting a duplicate address records baseline + incoming origins and the conflict is detectable", async () => {
    const id = (await createRecord({
      type: "address",
      inputString: ADDR,
      label: "Existing label",
      tags: [],
      categories: [],
      owner: "Alice",
      source: "manual",
    } as any)) as number;
    expect(await getRecordOriginsByRecordId(id)).toHaveLength(0);

    render(
      <TestProviders>
        <Dashboard />
      </TestProviders>,
    );

    // Wait until the record list (and thus recordLookupMap) contains the
    // seeded record — otherwise the submit would take the create path.
    await waitFor(
      () => {
        expect(screen.getByTestId("stub-record-table").textContent).toContain(
          ADDR,
        );
      },
      { timeout: 15000 },
    );

    fireEvent.click(screen.getByTestId("stub-form-submit"));

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
    expect(baseline.label).toBe("Existing label");
    expect(baseline.owner).toBe("Alice");

    expect(incoming.originType).toBe("manual");
    expect(incoming.source).toBe("csv-import");
    expect(incoming.label).toBe("Imported label");
    expect(incoming.owner).toBe("Bob");
    expect(incoming.tags).toEqual(["imported"]);

    // The update-existing path overwrites the fields; the old values live on
    // in the baseline origin and the disagreement is detectable.
    const updated = (await getRecord(id))!;
    expect(updated.label).toBe("Imported label");
    const conflicts = detectSingularFieldConflicts(updated, origins);
    expect(conflicts.map((c) => c.field.key)).toEqual(
      expect.arrayContaining(["label", "owner"]),
    );
  }, 40000);
});
