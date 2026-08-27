// @vitest-environment jsdom
//
// Sparse-record Dashboard fixtures (Task #1924): records created without
// optional metadata store label/tags/notes/categories as UNDEFINED
// (createRecord spreads the input as-is). Most jsdom fixtures always set
// those fields, which hid real-browser crashes like the Database Doctor
// Resolve dialog. These tests seed rows through the REAL CRUD layer with the
// optional fields omitted and prove the Dashboard's search filter, tag
// filter, and label/tags sorting paths don't dereference undefined.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord } from "@/lib/database";
import { TestProviders } from "@/test/testProviders";

// jsdom has no matchMedia; page components query it at mount.
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
  recordOrigins!: Table<any, number>;
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

// Apply search terms immediately (no debounce wait in tests).
vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T): [T, boolean] => [value, false],
}));

// Stub the heavy children. The RecordTable stub renders the inputStrings of
// the records it receives (so filter/sort outcomes are observable) and a
// button per sortable column so tests can drive the Dashboard's own sort
// comparator (which reads record.label / record.tags).
vi.mock("@/components/RecordFormDialog", () => ({
  RecordFormDialog: () => null,
}));
vi.mock("@/components/RecordTable", () => ({
  RecordTable: (props: any) => (
    <div data-testid="stub-record-table">
      {(props.records ?? []).map((r: any) => r.inputString).join(",")}
      <button
        type="button"
        data-testid="stub-sort-label"
        onClick={() => props.onSortChange?.("label")}
      />
      <button
        type="button"
        data-testid="stub-sort-tags"
        onClick={() => props.onSortChange?.("tags")}
      />
    </div>
  ),
}));
vi.mock("@/components/RecordCard", () => ({
  RecordCard: () => null,
}));
vi.mock("@/components/RecordDetailPanel", () => ({
  RecordDetailPanel: () => null,
}));
vi.mock("@/components/DemoVaultLoader", () => ({
  DemoVaultLoader: () => null,
}));
// Interactive stub so the test can activate a tag filter without driving the
// real combobox UI.
vi.mock("@/components/RecordFilters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/RecordFilters")>();
  return {
    ...actual,
    RecordFilters: ({ filters, onFiltersChange }: any) => (
      <div>
        <button
          type="button"
          data-testid="stub-filter-tag"
          onClick={() => onFiltersChange(actual.setFacetValues(filters, "tags", ["sometag"]))}
        />
      </div>
    ),
  };
});

vi.mock("@/hooks/use-toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-toast")>();
  return {
    ...actual,
    useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
  };
});

testDb = new TestDb(`KYUTXO-dashsparse-${Date.now()}-${Math.random()}`);

const { default: Dashboard } = await import("./Dashboard");
const { createRecord } = await import("@/lib/data/record-crud");

// Seed through the REAL CRUD layer with the optional fields omitted — this
// reproduces the exact sparse shape real vaults contain (label/tags/notes/
// categories are undefined, not "" / []).
function seedSparse(inputString: string) {
  return createRecord({
    type: "address",
    inputString,
    source: "manual",
    addressImportance: "manual",
  } as any);
}

function seedFull(inputString: string, label: string, tags: string[] = []) {
  return createRecord({
    type: "address",
    inputString,
    label,
    tags,
    categories: [],
    source: "manual",
    addressImportance: "manual",
  } as any);
}

function renderDashboard() {
  return render(
    <TestProviders>
      <Dashboard />
    </TestProviders>,
  );
}

function tableText(): string {
  return screen.getByTestId("stub-record-table").textContent ?? "";
}

const SPARSE = "bc1qsparsedashboardaddr000000000000001";
const FULL = "bc1qfulldashboardaddr00000000000000002";

beforeEach(async () => {
  await Promise.all(testDb.tables.map((t) => t.clear()));
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

afterAll(async () => {
  await testDb.delete();
});

describe("Dashboard with sparse records (optional fields omitted)", { timeout: 30000 }, () => {
  it("free-text search does not crash on rows without label/tags/categories", async () => {
    await seedSparse(SPARSE);
    await seedFull(FULL, "Savings", ["sometag"]);

    renderDashboard();
    await waitFor(() => expect(tableText()).toContain(SPARSE), { timeout: 15000 });

    // The search predicate reads label/tags/categories on EVERY row,
    // including the sparse one, before deciding matches.
    fireEvent.change(screen.getByPlaceholderText(/Search by label, address\/txid/), {
      target: { value: "sparsedashboard" },
    });

    await waitFor(() => {
      expect(tableText()).toContain(SPARSE);
      expect(tableText()).not.toContain(FULL);
    }, { timeout: 15000 });
  });

  it("tag filter does not crash on rows without tags", async () => {
    await seedSparse(SPARSE);
    await seedFull(FULL, "Savings", ["sometag"]);

    renderDashboard();
    await waitFor(() => expect(tableText()).toContain(SPARSE), { timeout: 15000 });

    fireEvent.click(screen.getByTestId("stub-filter-tag"));

    await waitFor(() => {
      expect(tableText()).toContain(FULL);
      expect(tableText()).not.toContain(SPARSE);
    }, { timeout: 15000 });
  });

  it("sorting by label and by tags does not crash on rows missing them", async () => {
    await seedSparse(SPARSE);
    await seedFull(FULL, "Savings", ["sometag"]);

    renderDashboard();
    await waitFor(() => expect(tableText()).toContain(SPARSE), { timeout: 15000 });

    fireEvent.click(screen.getByTestId("stub-sort-label"));
    await waitFor(() => {
      expect(tableText()).toContain(SPARSE);
      expect(tableText()).toContain(FULL);
    }, { timeout: 15000 });

    fireEvent.click(screen.getByTestId("stub-sort-tags"));
    await waitFor(() => {
      expect(tableText()).toContain(SPARSE);
      expect(tableText()).toContain(FULL);
    }, { timeout: 15000 });
  });
});
