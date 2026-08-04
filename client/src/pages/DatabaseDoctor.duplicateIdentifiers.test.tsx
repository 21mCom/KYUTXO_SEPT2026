// @vitest-environment jsdom
//
// Duplicate identifier records (Task #1869): the Database Doctor no longer
// dead-ends on the "Normalization skipped (would duplicate another record)"
// count — it lists the actual colliding groups, each row opens the shared
// record detail panel, and the card carries manual merge instructions.
//
// Covers:
//   - The health-check scan collects collision groups (the exact rows whose
//     canonical key is claimed by 2+ records) and renders the card.
//   - Clicking a row calls openRecordPreview with that record's id.
//   - No card renders when there are no collisions.
//   - The card paginates on large group lists (Prev/Next).
//
// Collision rows are seeded via direct table writes (this file is allow-listed
// in check-crud-guards.js) because the CRUD layer canonicalizes on save — the
// corruption emulates rows written before canonicalization or restored
// verbatim from an old backup.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { db, type Record as DbRecord } from "@/lib/database";
import { clearAllRecords } from "@/lib/data/record-crud";

const openRecordPreview = vi.fn();

vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview,
    openRecordPreviewByAddress: vi.fn(),
    openRecordEdit: vi.fn(),
    closePreview: vi.fn(),
    isOpen: false,
    isLoading: false,
  }),
}));

vi.mock("@/lib/vault", () => ({
  isLegacyDecryptComplete: vi.fn().mockResolvedValue(true),
  getLegacyDecryptCompletedTables: vi.fn().mockResolvedValue([]),
  isInputStringLowerRepaired: vi.fn().mockResolvedValue(true),
  setInputStringLowerRepaired: vi.fn().mockResolvedValue(undefined),
  setCanonicalInputStringsRepaired: vi.fn().mockResolvedValue(undefined),
}));

// The Balance Integrity card is idle until clicked; stub its heavy deps.
vi.mock("@/lib/data/address-stats", () => ({
  detectStaleCachedBalances: vi.fn(),
  recomputeAddressStats: vi.fn(),
}));
vi.mock("@/lib/data/stale-balance-report-store", () => ({
  clearStaleReport: vi.fn().mockResolvedValue(undefined),
  appendStaleReportRows: vi.fn().mockResolvedValue(undefined),
  getStaleReportWindow: vi.fn().mockResolvedValue([]),
  exportStaleReport: vi.fn().mockResolvedValue(undefined),
}));

import DatabaseDoctor, { DuplicateIdentifierCard, type CollisionGroup } from "./DatabaseDoctor";

const BECH32 = "bc1qduplicate000000000000000000000000000001";

// Seed a row exactly the way a pre-canonicalization build stored it.
async function seedVerbatim(inputString: string, label = ""): Promise<number> {
  const now = Date.now();
  return (await db.records.add({
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    label,
    notes: "",
    tags: [],
    categories: [],
    owner: "Pending Review",
    source: "manual",
    addressImportance: "manual",
    createdAt: now,
    updatedAt: now,
  } as unknown as DbRecord)) as number;
}

// Seed a sparse row the way createRecord actually stores records created
// without optional metadata: label/tags/notes/categories are simply absent
// (undefined), not empty strings/arrays. Real vaults contain such rows and
// the Resolve dialog crashed on them in a real browser (Task #1891).
async function seedSparse(inputString: string): Promise<number> {
  const now = Date.now();
  return (await db.records.add({
    type: "address",
    inputString,
    inputStringLower: inputString.toLowerCase(),
    owner: "Pending Review",
    source: "manual",
    addressImportance: "manual",
    createdAt: now,
    updatedAt: now,
  } as unknown as DbRecord)) as number;
}

async function runHealthCheck() {
  render(<DatabaseDoctor />);
  fireEvent.click(screen.getByTestId("button-run-check"));
  await waitFor(
    () => expect(screen.getByTestId("card-record-health")).toBeTruthy(),
    { timeout: 10_000 },
  );
}

describe("Database Doctor duplicate identifier records", () => {
  beforeEach(async () => {
    openRecordPreview.mockClear();
    await clearAllRecords();
  });

  afterEach(() => cleanup());

  it("lists colliding rows and opens the record detail panel on click", async () => {
    const canonicalId = await seedVerbatim(BECH32, "keeper");
    const paddedId = await seedVerbatim(`  ${BECH32.toUpperCase()}  `, "dupe");
    await seedVerbatim("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "unrelated");

    await runHealthCheck();

    // The skipped-collision stat counts only the non-canonical row…
    expect(screen.getByTestId("stat-canonical-identifier-collision").textContent).toBe("1");
    // …but the card shows the whole group (both records) so the user can merge.
    const card = screen.getByTestId("card-duplicate-identifiers");
    expect(card.textContent).toContain(BECH32);
    expect(screen.getByTestId(`button-open-duplicate-${canonicalId}`)).toBeTruthy();
    const dupeButton = screen.getByTestId(`button-open-duplicate-${paddedId}`);
    expect(dupeButton.textContent).toContain("stored non-canonically");
    expect(dupeButton.textContent).toContain("dupe");

    fireEvent.click(dupeButton);
    expect(openRecordPreview).toHaveBeenCalledWith(paddedId);
  });

  it("renders no duplicate card when there are no collisions", async () => {
    await seedVerbatim(BECH32);
    await seedVerbatim("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");

    await runHealthCheck();

    expect(screen.getByTestId("stat-canonical-identifier-collision").textContent).toBe("0");
    expect(screen.queryByTestId("card-duplicate-identifiers")).toBeNull();
  });
});

describe("guided Resolve flow (Task #1880)", () => {
  beforeEach(async () => {
    openRecordPreview.mockClear();
    await clearAllRecords();
  });

  afterEach(() => cleanup());

  it("deletes the redundant record via CRUD, hides the group, and previews lost metadata", async () => {
    const keeperId = await seedVerbatim(BECH32, "keeper");
    const dupeId = await seedVerbatim(`  ${BECH32.toUpperCase()}  `, "dupe-label");
    await db.records.update(dupeId, { tags: ["lost-tag"], notes: "lost note" });

    await runHealthCheck();

    fireEvent.click(screen.getByTestId("button-resolve-duplicate-0"));
    await waitFor(() => expect(screen.getByTestId(`radio-keeper-${keeperId}`)).toBeTruthy());

    // Default keeper is the first row; the dupe's label/tags/notes are shown as at-risk.
    const lost = screen.getByTestId("text-resolve-lost-metadata");
    expect(lost.textContent).toContain("dupe-label");
    expect(lost.textContent).toContain("lost-tag");
    expect(lost.textContent).toContain("lost note");

    const confirm = screen.getByTestId("button-resolve-confirm") as HTMLButtonElement;
    expect(confirm.textContent).toContain(`keep #${keeperId}`);
    fireEvent.click(confirm);

    // The redundant record is deleted through the CRUD layer and the group hides.
    await waitFor(async () => {
      expect(await db.records.get(dupeId)).toBeUndefined();
    });
    expect(await db.records.get(keeperId)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("dialog-resolve-duplicate")).toBeNull());
    expect(screen.queryByTestId("duplicate-group-0")).toBeNull();
  });

  it("handles sparse rows (no label/tags/notes stored) without crashing (Task #1891)", async () => {
    // The keeper is a sparse row exactly as createRecord stores it — the
    // optional metadata fields are absent, not empty. The dupe carries
    // metadata so the lost-metadata preview must still work against the
    // sparse keeper.
    const keeperId = await seedSparse(BECH32);
    const dupeId = await seedVerbatim(`  ${BECH32.toUpperCase()}  `, "dupe-label");
    await db.records.update(dupeId, { tags: ["lost-tag"], notes: "lost note" });

    await runHealthCheck();

    fireEvent.click(screen.getByTestId("button-resolve-duplicate-0"));
    await waitFor(() => expect(screen.getByTestId(`radio-keeper-${keeperId}`)).toBeTruthy());

    // Lost-metadata preview compares against the sparse keeper's undefined
    // label/tags/notes — everything on the dupe is at risk.
    const lost = screen.getByTestId("text-resolve-lost-metadata");
    expect(lost.textContent).toContain("dupe-label");
    expect(lost.textContent).toContain("lost-tag");
    expect(lost.textContent).toContain("lost note");

    fireEvent.click(screen.getByTestId("button-resolve-confirm"));
    await waitFor(async () => {
      expect(await db.records.get(dupeId)).toBeUndefined();
    });
    expect(await db.records.get(keeperId)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("dialog-resolve-duplicate")).toBeNull());
  });

  it("handles a group where the sparse row is the loser (undefined metadata on the dupe)", async () => {
    const keeperId = await seedVerbatim(BECH32, "keeper");
    const sparseDupeId = await seedSparse(`${BECH32.toUpperCase()}`);

    await runHealthCheck();

    fireEvent.click(screen.getByTestId("button-resolve-duplicate-0"));
    await waitFor(() => expect(screen.getByTestId(`radio-keeper-${keeperId}`)).toBeTruthy());

    // A sparse loser has nothing to lose — no lost-metadata warning renders,
    // and it must not crash while computing it.
    expect(screen.queryByTestId("text-resolve-lost-metadata")).toBeNull();

    fireEvent.click(screen.getByTestId("button-resolve-confirm"));
    await waitFor(async () => {
      expect(await db.records.get(sparseDupeId)).toBeUndefined();
    });
    expect(await db.records.get(keeperId)).toBeTruthy();
  });

  it("lets the user switch the keeper before confirming", async () => {
    const firstId = await seedVerbatim(BECH32, "first");
    const secondId = await seedVerbatim(`${BECH32.toUpperCase()}`, "second");

    await runHealthCheck();

    fireEvent.click(screen.getByTestId("button-resolve-duplicate-0"));
    await waitFor(() => expect(screen.getByTestId(`radio-keeper-${secondId}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`radio-keeper-${secondId}`));
    const confirm = screen.getByTestId("button-resolve-confirm") as HTMLButtonElement;
    await waitFor(() => expect(confirm.textContent).toContain(`keep #${secondId}`));
    fireEvent.click(confirm);

    await waitFor(async () => {
      expect(await db.records.get(firstId)).toBeUndefined();
    });
    expect(await db.records.get(secondId)).toBeTruthy();
  });

  it("cancel leaves both records untouched", async () => {
    const keeperId = await seedVerbatim(BECH32, "keeper");
    const dupeId = await seedVerbatim(`${BECH32.toUpperCase()}`, "dupe");

    await runHealthCheck();

    fireEvent.click(screen.getByTestId("button-resolve-duplicate-0"));
    await waitFor(() => expect(screen.getByTestId("button-resolve-cancel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("button-resolve-cancel"));

    await waitFor(() => expect(screen.queryByTestId("dialog-resolve-duplicate")).toBeNull());
    expect(await db.records.get(keeperId)).toBeTruthy();
    expect(await db.records.get(dupeId)).toBeTruthy();
    // The group is still listed — nothing was resolved.
    expect(screen.getByTestId("duplicate-group-0")).toBeTruthy();
  });

  it("disables confirm when the group is stale (rows already deleted elsewhere)", async () => {
    const keeperId = await seedVerbatim(BECH32, "keeper");
    const dupeId = await seedVerbatim(`${BECH32.toUpperCase()}`, "dupe");

    await runHealthCheck();

    // Simulate the user deleting the dupe from the detail panel after the scan.
    await db.records.delete(dupeId);

    fireEvent.click(screen.getByTestId("button-resolve-duplicate-0"));
    await waitFor(() => expect(screen.getByTestId("text-resolve-load-error")).toBeTruthy());
    expect((screen.getByTestId("button-resolve-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(await db.records.get(keeperId)).toBeTruthy();
  });
});

describe("DuplicateIdentifierCard pagination", () => {
  afterEach(() => cleanup());

  function makeGroups(n: number): CollisionGroup[] {
    return Array.from({ length: n }, (_, i) => ({
      canonical: `bc1qgroup${i.toString().padStart(34, "0")}`,
      rows: [
        { id: i * 2 + 1, inputString: `BC1QGROUP${i}`, label: "", type: "address", nonCanonical: true },
        { id: i * 2 + 2, inputString: `bc1qgroup${i}`, label: "", type: "address", nonCanonical: false },
      ],
    }));
  }

  it("pages through groups with Prev/Next", () => {
    render(<DuplicateIdentifierCard groups={makeGroups(25)} truncated={false} />);

    expect(screen.getByTestId("text-duplicates-page").textContent).toContain("Page 1 of 3");
    expect(screen.getByTestId("duplicate-group-0")).toBeTruthy();
    expect(screen.queryByTestId("duplicate-group-10")).toBeNull();
    expect((screen.getByTestId("button-duplicates-prev") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("button-duplicates-next"));
    expect(screen.getByTestId("text-duplicates-page").textContent).toContain("Page 2 of 3");
    expect(screen.getByTestId("duplicate-group-10")).toBeTruthy();
    expect(screen.queryByTestId("duplicate-group-0")).toBeNull();

    fireEvent.click(screen.getByTestId("button-duplicates-next"));
    expect(screen.getByTestId("text-duplicates-page").textContent).toContain("Page 3 of 3");
    expect((screen.getByTestId("button-duplicates-next") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("button-duplicates-prev"));
    expect(screen.getByTestId("text-duplicates-page").textContent).toContain("Page 2 of 3");
  });

  it("shows the truncation notice when caps trimmed the list", () => {
    render(<DuplicateIdentifierCard groups={makeGroups(1)} truncated={true} />);
    expect(screen.getByTestId("text-duplicates-truncated")).toBeTruthy();
  });
});
