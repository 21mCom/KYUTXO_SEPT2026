// @vitest-environment jsdom
//
// Regression coverage for Task #2132 (Standardize Transactions & UTXOs
// filters): Transactions previously had no user-facing sort control at all
// (hard-coded newest-first). This locks in the new `button-sort-date` control
// — matching the sortable-column-header pattern already on UTXOs — actually
// reorders the rendered transaction cards, not just its icon/label.
//
// The full page renders against real Dexie (fake-indexeddb) seeded via the
// real CRUD modules; the engine freshness gate is mocked to always fall back
// to the in-browser Dexie computation.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: false }),
}));
vi.mock("@/lib/engine/engine-client", () => ({
  engineCountTransactions: vi.fn().mockResolvedValue(0),
  engineGetTransactionPage: vi.fn().mockResolvedValue([]),
  subscribeEngineReadiness: vi.fn(() => () => {}),
}));

import { renderWithProviders } from "@/test/testProviders";
import { clearAllRecords, createRecord } from "@/lib/data/record-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { db } from "@/lib/database";
import Transactions from "./Transactions";

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});

// Distinct first-8-char prefixes so `card-transaction-${txid.slice(0,8)}`
// testids never collide (see the memory note on force-graph testid collisions
// for why sharing a prefix silently breaks lookups, not renders).
const TX_OLDEST = "1".repeat(63) + "a";
const TX_MIDDLE = "2".repeat(63) + "b";
const TX_NEWEST = "3".repeat(63) + "c";
const ADDR = "bc1qsortcontroltestaddress00000000000000000";

async function seed() {
  const recordId = await createRecord({
    type: "address",
    inputString: ADDR,
    label: "Sort control test",
    // getAddressRecordsByImportanceTiers matches the compound
    // [type+addressImportance] index exactly against USER_CURATED_TIERS, so an
    // undefined importance (which isUserCuratedImportance treats as curated)
    // is invisible to it — an explicit curated tier is required here.
    addressImportance: "manual",
    tags: [],
    categories: [],
  });
  await bulkAddTransactions([
    { txid: TX_OLDEST, blockHeight: 800_000, blockTime: 1_700_000_000, fee: 100, feeRate: 1, syncedAt: Date.now() },
    { txid: TX_MIDDLE, blockHeight: 800_001, blockTime: 1_700_000_500, fee: 100, feeRate: 1, syncedAt: Date.now() },
    { txid: TX_NEWEST, blockHeight: 800_002, blockTime: 1_700_001_000, fee: 100, feeRate: 1, syncedAt: Date.now() },
  ]);
  // The curatedOnly default view resolves via participant.recordId (indexed
  // lookup against curated records), not the address string, so every
  // participant needs recordId wired to the record just created.
  await bulkAddParticipants([
    { txid: TX_OLDEST, role: "output", address: ADDR, amount: 10_000, vout: 0, recordId },
    { txid: TX_MIDDLE, role: "output", address: ADDR, amount: 20_000, vout: 0, recordId },
    { txid: TX_NEWEST, role: "output", address: ADDR, amount: 30_000, vout: 0, recordId },
  ]);
}

function renderedOrder(): string[] {
  const cards = Array.from(document.querySelectorAll('[data-testid^="card-transaction-"]'));
  return cards.map((el) => (el as HTMLElement).dataset.testid!.replace("card-transaction-", ""));
}

describe("Transactions page sort control", () => {
  beforeEach(async () => {
    await clearAllRecords();
    await clearTransactions();
    await clearParticipants();
    await db.dustFlags.clear();
    await seed();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("defaults to newest-first and the sort button reverses to oldest-first", async () => {
    renderWithProviders(<Transactions />);

    await waitFor(() => {
      expect(renderedOrder()).toEqual([
        TX_NEWEST.slice(0, 8),
        TX_MIDDLE.slice(0, 8),
        TX_OLDEST.slice(0, 8),
      ]);
    }, { timeout: 10000 });

    const sortButton = screen.getByTestId("button-sort-date");
    expect(sortButton.getAttribute("title")).toBe("Sorted newest first");

    fireEvent.click(sortButton);

    await waitFor(() => {
      expect(renderedOrder()).toEqual([
        TX_OLDEST.slice(0, 8),
        TX_MIDDLE.slice(0, 8),
        TX_NEWEST.slice(0, 8),
      ]);
    });
    expect(screen.getByTestId("button-sort-date").getAttribute("title")).toBe("Sorted oldest first");

    // Toggling again returns to the default newest-first order.
    fireEvent.click(screen.getByTestId("button-sort-date"));
    await waitFor(() => {
      expect(renderedOrder()).toEqual([
        TX_NEWEST.slice(0, 8),
        TX_MIDDLE.slice(0, 8),
        TX_OLDEST.slice(0, 8),
      ]);
    });
  }, 20000);
});
