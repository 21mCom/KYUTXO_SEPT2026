// @vitest-environment jsdom
//
// Page-level tests for Conflict Resolution (Task #1722): a merged import with
// differing singular metadata must SURFACE on the page, resolving must remove
// it, and a later import that brings a new differing value must re-surface it.
//
// End-to-end shape (real Dexie facade on fake-indexeddb, real page component):
//   1. record created with owner "Alice" (no origin history — raw facade
//      createRecord, like Nudgie/restores);
//   2. an import merges with owner "Bob" → captureMergeOrigin backfills the
//      baseline + writes the incoming origin;
//   3. the page lists the record with an Owner conflict (the old auto-hide
//      heuristic would have hidden it because "Alice" matches the baseline);
//   4. picking "Bob" (or Keep Current Value) records a resolution and the
//      conflict disappears;
//   5. a newer merge with owner "Carol" re-surfaces it;
//   6. the MetadataSourcesPanel badge agrees with the page and deep-links.

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import Dexie, { type Table } from "dexie";
import type { Record as DbRecord, RecordOrigin } from "@/lib/database";
import { TestProviders } from "@/test/testProviders";

class TestDb extends Dexie {
  records!: Table<DbRecord, number>;
  recordOrigins!: Table<RecordOrigin, number>;
  tags!: Table<any, number>;
  categories!: Table<any, number>;
  owners!: Table<any, number>;
  walletNames!: Table<any, number>;
  seedNames!: Table<any, number>;
  walletSoftware!: Table<any, number>;
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
      // Queried by providers/panels mounted via TestProviders
      customFields: "++id, slug, enabled, createdAt",
      recordAttachments: "++id, recordId, createdAt",
      settings: "id",
      nodeSettings: "id",
    });
  }
}

// The static TestProviders import above evaluates the mocked "@/lib/database"
// module BEFORE this file's body runs, so the factory must not touch testDb
// eagerly — expose it through a lazy getter (same pattern as the Nudgie
// outpoint test).
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

testDb = new TestDb(`KYUTXO-confres-${Date.now()}-${Math.random()}`);

const { default: ConflictResolution } = await import("./ConflictResolution");
const { MetadataSourcesPanel } = await import("@/components/MetadataSourcesPanel");
const { createRecord, getRecord } = await import("@/lib/data/record-crud");
const { captureMergeOrigin, getRecordOriginsByRecordId } = await import(
  "@/lib/data/record-origins-crud"
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let addrCounter = 0;
function nextAddress(): string {
  addrCounter++;
  // distinct first-8 prefixes to dodge testid/prefix collisions
  return `bc1qcr${addrCounter}x${"q".repeat(30)}`;
}

async function seedMergedRecord(opts?: {
  incomingOwner?: string;
}): Promise<DbRecord> {
  const id = (await createRecord({
    type: "address",
    inputString: nextAddress(),
    label: "Cold storage",
    tags: [],
    categories: [],
    owner: "Alice",
    source: "manual",
  } as any)) as number;
  const record = (await getRecord(id))!;

  // Simulate what any merge path now does after updateRecord.
  await captureMergeOrigin(record, {
    originType: "xpub-derived",
    source: "bulk-import-xpub",
    owner: opts?.incomingOwner ?? "Bob",
  });
  return record;
}

function renderPage() {
  return render(
    <TestProviders>
      <ConflictResolution />
    </TestProviders>,
  );
}

function getRadioByValue(value: string): HTMLElement {
  const radios = screen.getAllByRole("radio");
  const match = radios.find((r) => r.getAttribute("value") === value);
  if (!match) {
    throw new Error(
      `no radio with value ${value}; got ${radios.map((r) => r.getAttribute("value")).join(",")}`,
    );
  }
  return match;
}

beforeEach(async () => {
  window.history.replaceState({}, "", "/conflict-resolution");
  await Promise.all(testDb.tables.map((t) => t.clear()));
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await testDb.delete();
});

describe("ConflictResolution — merged imports surface", () => {
  it("shows a record whose only origins came from a single merge (baseline backfill)", async () => {
    const record = await seedMergedRecord();

    renderPage();

    // The record surfaces even though its active owner ("Alice") matches the
    // baseline origin — the old heuristic auto-hid exactly this case.
    await screen.findByTestId(`text-address-${record.id}`);
    const row = await screen.findByTestId(`button-resolve-${record.id}-owner`);
    expect(row.textContent).toContain("Owner");
    expect(row.textContent).toContain("Alice");
  });

  it("resolving by picking the incoming value applies it, records the resolution, and clears the page", async () => {
    const record = await seedMergedRecord();

    renderPage();

    fireEvent.click(await screen.findByTestId(`button-resolve-${record.id}-owner`));
    await screen.findByTestId("button-apply-value");

    // Pick the incoming source's value ("Bob") and apply.
    fireEvent.click(getRadioByValue("Bob"));
    fireEvent.click(screen.getByTestId("button-apply-value"));

    await waitFor(async () => {
      const fresh = await getRecord(record.id!);
      expect(fresh?.owner).toBe("Bob");
      expect(fresh?.conflictResolutions?.owner?.value).toBe("Bob");
    });

    // Page reloads and the conflict is gone.
    await screen.findByText("No conflicts found");
  });

  it("a later import with a new differing value re-surfaces the resolved conflict", async () => {
    const record = await seedMergedRecord();

    const first = renderPage();
    fireEvent.click(await screen.findByTestId(`button-resolve-${record.id}-owner`));
    await screen.findByTestId("button-apply-value");
    fireEvent.click(getRadioByValue("Bob"));
    fireEvent.click(screen.getByTestId("button-apply-value"));
    await screen.findByText("No conflicts found");
    first.unmount();

    // Ensure the newer origin lands strictly AFTER the recorded resolvedAt.
    await sleep(15);
    const fresh = (await getRecord(record.id!))!;
    await captureMergeOrigin(fresh, {
      originType: "wallet-sync",
      source: "walletImport-sparrow",
      owner: "Carol",
    });
    // No duplicate baseline: origins are baseline + Bob + Carol.
    expect(await getRecordOriginsByRecordId(record.id!)).toHaveLength(3);

    renderPage();
    const row = await screen.findByTestId(`button-resolve-${record.id}-owner`);
    expect(row.textContent).toContain("Owner");

    // And a re-asserting merge (same value as resolved) must NOT re-surface:
    // covered at unit level in conflict-detection.test.ts.
  });

  it("Keep Current Value resolves without changing the field", async () => {
    const record = await seedMergedRecord();

    renderPage();
    fireEvent.click(await screen.findByTestId(`button-resolve-${record.id}-owner`));
    fireEvent.click(await screen.findByTestId("button-keep-current"));

    await waitFor(async () => {
      const fresh = await getRecord(record.id!);
      expect(fresh?.owner).toBe("Alice"); // unchanged
      expect(fresh?.conflictResolutions?.owner).toBeTruthy();
      expect(fresh?.conflictResolutions?.owner.value).toBe("Alice");
    });

    await screen.findByText("No conflicts found");
  });

  it("custom value resolution applies the third value and records it", async () => {
    const record = await seedMergedRecord();

    renderPage();
    fireEvent.click(await screen.findByTestId(`button-resolve-${record.id}-owner`));
    await screen.findByTestId("button-apply-value");

    fireEvent.click(screen.getByLabelText("Use custom value instead"));
    fireEvent.change(screen.getByTestId("input-custom-value"), {
      target: { value: "Carol" },
    });
    fireEvent.click(screen.getByTestId("button-apply-value"));

    await waitFor(async () => {
      const fresh = await getRecord(record.id!);
      expect(fresh?.owner).toBe("Carol");
      expect(fresh?.conflictResolutions?.owner?.value).toBe("Carol");
    });
    await screen.findByText("No conflicts found");
  });
});

describe("MetadataSourcesPanel — agrees with the page", () => {
  it("shows the same conflict count via shared detection and deep-links to the page", async () => {
    const record = await seedMergedRecord();

    render(
      <TestProviders>
        <MetadataSourcesPanel recordId={record.id!} record={record} />
      </TestProviders>,
    );

    const badge = await screen.findByTestId("badge-sources-conflicts");
    // One conflicting field (owner) — the page shows exactly one conflict row
    // for this record; the old any-origin-differs rule would have said 1 here
    // but 2+ in multi-field cases, and >0 for records the page denied having.
    expect(badge.textContent).toContain("1 conflicts");

    fireEvent.click(badge);
    expect(window.location.pathname + window.location.search).toBe(
      `/conflict-resolution?recordId=${record.id}`,
    );
  });

  it("shows no conflict badge once resolved (parity with the page's empty state)", async () => {
    const record = await seedMergedRecord();
    const { updateRecord } = await import("@/lib/data/record-crud");
    const { withFieldResolution } = await import("@/lib/conflict-detection");
    await updateRecord(record.id!, {
      conflictResolutions: withFieldResolution(undefined, "owner", "Alice"),
    });
    const fresh = (await getRecord(record.id!))!;

    render(
      <TestProviders>
        <MetadataSourcesPanel recordId={record.id!} record={fresh} />
      </TestProviders>,
    );

    await screen.findByTestId("button-toggle-sources");
    expect(screen.queryByTestId("badge-sources-conflicts")).toBeNull();
  });
});
