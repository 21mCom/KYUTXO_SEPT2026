// @vitest-environment jsdom
//
// Task #1770 — surface hidden-tier wallets in Records (Dashboard).
//
// Wallet Overview lists wallets whose addresses are all blockchain-discovered
// /pending-review rows, but the Dashboard hides those tiers at the DB level —
// so searching the wallet name used to dead-end on "No records found" with no
// explanation. These tests mount the Dashboard against a real (fake-indexeddb)
// vault and prove:
//   1. a search that only matches hidden-tier rows shows the "N matches are
//      hidden among blockchain-discovered records" notice, and the "Show
//      hidden matches" button reveals the rows;
//   2. the free-text search matches walletName and owner;
//   3. the Wallet Overview drill-down (`/?walletName=...`) applies a Wallet
//      Name column filter and auto-includes discovered rows;
//   4. the default view still hides discovered rows when no search is active.

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

// Stub the heavy children; the RecordTable stub renders the inputStrings of
// the records it receives so filtering outcomes are directly observable.
vi.mock("@/components/RecordFormDialog", () => ({
  RecordFormDialog: () => null,
}));
vi.mock("@/components/RecordTable", () => ({
  RecordTable: (props: any) => (
    <div data-testid="stub-record-table">
      {(props.records ?? []).map((r: any) => r.inputString).join(",")}
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
// Interactive stub so tests can activate FilterBar-style filters (tag /
// category / type) without driving the real combobox UI.
vi.mock("@/components/FilterBar", () => ({
  FilterBar: ({ filter, onChange }: any) => (
    <div>
      <button
        type="button"
        data-testid="stub-filter-tag"
        onClick={() => onChange({ ...filter, tags: ["hiddenonlytag"] })}
      />
      <button
        type="button"
        data-testid="stub-filter-type-other"
        onClick={() => onChange({ ...filter, type: "other" })}
      />
    </div>
  ),
}));

testDb = new TestDb(`KYUTXO-dashhidden-${Date.now()}-${Math.random()}`);

const { default: Dashboard } = await import("./Dashboard");
const { createRecord } = await import("@/lib/data/record-crud");

function seedRecord(fields: Partial<DbRecord> & { inputString: string; label: string }) {
  return createRecord({
    type: "address",
    tags: [],
    categories: [],
    source: "manual",
    addressImportance: "manual",
    ...fields,
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

describe("Dashboard hidden-tier matches", () => {
  it("searching a hidden-tier-only wallet name shows the notice, and the button reveals the rows", async () => {
    await seedRecord({
      inputString: "bc1qhiddenwalletaddr000000000000000001",
      label: "Synced address 1",
      walletName: "GmaFunding",
      source: "blockchain-sync",
      addressImportance: "blockchain-discovered",
    });
    await seedRecord({
      inputString: "bc1qhiddenwalletaddr000000000000000002",
      label: "Synced address 2",
      walletName: "GmaFunding",
      source: "blockchain-sync",
      addressImportance: "pending-review",
    });
    await seedRecord({
      inputString: "bc1qvisiblerow00000000000000000000003",
      label: "Savings",
    });

    renderDashboard();

    // Default view: discovered rows hidden at the DB level.
    await waitFor(
      () => expect(tableText()).toContain("bc1qvisiblerow"),
      { timeout: 15000 },
    );
    expect(tableText()).not.toContain("bc1qhiddenwalletaddr");

    fireEvent.change(screen.getByTestId("input-search"), {
      target: { value: "GmaFunding" },
    });

    // The search matches only hidden-tier rows → notice, not a silent dead-end.
    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 15000,
    });
    expect(notice.textContent).toContain("2 matches are hidden");
    expect(notice.textContent).toContain("among blockchain-discovered records");
    expect(screen.getByText(/No records found/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-show-hidden-matches"));

    await waitFor(
      () => {
        expect(tableText()).toContain("bc1qhiddenwalletaddr000000000000000001");
        expect(tableText()).toContain("bc1qhiddenwalletaddr000000000000000002");
      },
      { timeout: 15000 },
    );
    expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
  }, 60000);

  it("free-text search matches walletName and owner on visible rows", async () => {
    await seedRecord({
      inputString: "bc1qwalletnamematch000000000000000001",
      label: "Vault",
      walletName: "GmaFunding",
    });
    await seedRecord({
      inputString: "bc1qownermatch00000000000000000000002",
      label: "Cold",
      owner: "Grandma",
    });
    await seedRecord({
      inputString: "bc1qunrelatedrow00000000000000000000003",
      label: "Other",
    });

    renderDashboard();
    await waitFor(
      () => expect(tableText()).toContain("bc1qunrelatedrow"),
      { timeout: 15000 },
    );

    fireEvent.change(screen.getByTestId("input-search"), {
      target: { value: "GmaFunding" },
    });
    await waitFor(
      () => {
        expect(tableText()).toContain("bc1qwalletnamematch");
        expect(tableText()).not.toContain("bc1qunrelatedrow");
        expect(tableText()).not.toContain("bc1qownermatch");
      },
      { timeout: 15000 },
    );

    fireEvent.change(screen.getByTestId("input-search"), {
      target: { value: "Grandma" },
    });
    await waitFor(
      () => {
        expect(tableText()).toContain("bc1qownermatch");
        expect(tableText()).not.toContain("bc1qwalletnamematch");
        expect(tableText()).not.toContain("bc1qunrelatedrow");
      },
      { timeout: 15000 },
    );
    // All matches are visible rows — no hidden-matches notice.
    expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
  }, 60000);

  it("the ?walletName= deep link applies a Wallet Name filter and includes discovered rows", async () => {
    window.history.replaceState({}, "", "/?walletName=GmaFunding");

    await seedRecord({
      inputString: "bc1qdeepwalletaddr00000000000000000001",
      label: "Synced address 1",
      walletName: "GmaFunding",
      source: "blockchain-sync",
      addressImportance: "blockchain-discovered",
    });
    await seedRecord({
      inputString: "bc1qdeepwalletaddr00000000000000000002",
      label: "Synced address 2",
      walletName: "GmaFunding",
      source: "blockchain-sync",
      addressImportance: "blockchain-discovered",
    });
    await seedRecord({
      inputString: "bc1qotherwalletrow00000000000000000003",
      label: "Other wallet row",
      walletName: "OtherWallet",
    });
    await seedRecord({
      inputString: "bc1qnowalletrow00000000000000000000004",
      label: "No wallet row",
    });

    renderDashboard();

    // The drill-down lands with the discovered rows already included and the
    // Wallet Name filter applied — never an unexplained empty page.
    await waitFor(
      () => {
        expect(tableText()).toContain("bc1qdeepwalletaddr00000000000000000001");
        expect(tableText()).toContain("bc1qdeepwalletaddr00000000000000000002");
      },
      { timeout: 15000 },
    );
    expect(tableText()).not.toContain("bc1qotherwalletrow");
    expect(tableText()).not.toContain("bc1qnowalletrow");
    // Discovered records were auto-included (toggle flipped to checked).
    expect(
      screen.getByTestId("button-blockchain-toggle").className,
    ).toContain("text-primary");
    expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
  }, 60000);

  it("a tag-only filter that matches only hidden-tier rows shows the notice and the button reveals them", async () => {
    await seedRecord({
      inputString: "bc1qtagonlyhidden00000000000000000001",
      label: "Synced tagged address",
      tags: ["hiddenonlytag"],
      source: "blockchain-sync",
      addressImportance: "blockchain-discovered",
    });
    await seedRecord({
      inputString: "bc1qtagonlyvisible0000000000000000002",
      label: "Savings",
    });

    renderDashboard();
    await waitFor(
      () => expect(tableText()).toContain("bc1qtagonlyvisible"),
      { timeout: 15000 },
    );

    // Tag-only narrowing (no text search, no column filter).
    fireEvent.click(screen.getByTestId("stub-filter-tag"));

    const notice = await screen.findByTestId("notice-hidden-matches", undefined, {
      timeout: 15000,
    });
    expect(notice.textContent).toContain("1 match is hidden");
    expect(screen.getByText(/No records found/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-show-hidden-matches"));
    await waitFor(
      () => expect(tableText()).toContain("bc1qtagonlyhidden"),
      { timeout: 15000 },
    );
    expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
  }, 60000);

  it("a type-only filter with no hidden matches shows no notice", async () => {
    await seedRecord({
      inputString: "bc1qtypefilterhidden000000000000000001",
      label: "Synced address",
      source: "blockchain-sync",
      addressImportance: "blockchain-discovered",
    });
    await seedRecord({
      inputString: "bc1qtypefiltervisible00000000000000002",
      label: "Savings",
    });

    renderDashboard();
    await waitFor(
      () => expect(tableText()).toContain("bc1qtypefiltervisible"),
      { timeout: 15000 },
    );

    // "other" type matches neither the hidden nor the visible address rows.
    fireEvent.click(screen.getByTestId("stub-filter-type-other"));
    await waitFor(
      () => expect(screen.getByText(/No records found/i)).toBeTruthy(),
      { timeout: 15000 },
    );
    // Give the deferred count a beat, then confirm it stayed silent.
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
  }, 60000);

  it("default view still hides discovered rows with no notice when no search is active", async () => {
    await seedRecord({
      inputString: "bc1qdefaulthidden0000000000000000000001",
      label: "Synced address",
      walletName: "GmaFunding",
      source: "blockchain-sync",
      addressImportance: "blockchain-discovered",
    });
    await seedRecord({
      inputString: "bc1qdefaultvisible000000000000000000002",
      label: "Savings",
    });

    renderDashboard();

    await waitFor(
      () => expect(tableText()).toContain("bc1qdefaultvisible"),
      { timeout: 15000 },
    );
    expect(tableText()).not.toContain("bc1qdefaulthidden");
    expect(screen.queryByTestId("notice-hidden-matches")).toBeNull();
  }, 60000);
});
