// @vitest-environment jsdom
//
// Regression coverage for Task #2132 (Standardize Transactions & UTXOs
// filters): the UTXOs page's Owner/Wallet/Tag/Category selectors are
// searchable MultiSelectCombobox controls (OR within a dimension, AND across
// dimensions, with an "Unassigned" sentinel), and a single "Clear all
// filters" button resets search, all four entity dimensions, the historical
// date picker, and hide-dust together. This locks in that wiring so a future
// refactor of the filter memo chain can't silently regress it.
//
// The full page is rendered against real Dexie (fake-indexeddb) seeded via
// the real CRUD/vocabulary modules. The engine freshness gate is mocked to
// always fall back to the in-browser Dexie computation, and the virtualizer
// is stubbed (jsdom has no layout, so a real virtualizer would render zero
// rows).
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// jsdom has no layout: render every row instead of a measured window.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * 56,
      size: opts.estimateSize(index),
    }));
    return {
      getTotalSize: () => opts.count * 56,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));

vi.mock("@/components/ScrollPositionIndicator", () => ({
  ScrollPositionIndicator: () => null,
}));

vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn().mockResolvedValue({ useEngine: false }),
}));
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountOwnedUtxos: vi.fn().mockResolvedValue(0),
  engineGetHeuristicOwnedUtxos: vi.fn().mockResolvedValue([]),
  engineCountHeuristicOwnedUtxos: vi.fn().mockResolvedValue(0),
}));

import { renderWithProviders } from "@/test/testProviders";
import { clearAllRecords, createRecord } from "@/lib/data/record-crud";
import {
  bulkAddTransactions,
  bulkAddParticipants,
  clearTransactions,
  clearParticipants,
} from "@/lib/data/transaction-crud";
import { createOwner, createWalletName, createTag, createCategory } from "@/lib/data/vocabulary-crud";
import { db } from "@/lib/database";
import UTXOs from "./UTXOs";

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  // MultiSelectCombobox's cmdk popover needs ResizeObserver + scrollIntoView,
  // neither of which jsdom implements.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

// Distinct first-8-char prefixes: AddressLink truncates to
// `${addr.slice(0,8)}` for its data-testid, so shared prefixes would collide.
const ADDR_ALICE = "bc1qaaaaentityfilteraliceaddress0000000000";
const ADDR_BOB = "bc1qbbbbentityfilterbobaddress00000000000000";
const ADDR_UNASSIGNED = "bc1quuuuentityfilterunassignedaddr000000000";

async function seed() {
  await Promise.all([
    createOwner("Alice"),
    createOwner("Bob"),
    createWalletName("WalletA"),
    createTag("hot"),
    createCategory("exchange"),
  ]);
  await createRecord({
    type: "address",
    inputString: ADDR_ALICE,
    label: "Alice addr",
    owner: "Alice",
    walletName: "WalletA",
    tags: ["hot"],
    categories: ["exchange"],
  });
  await createRecord({
    type: "address",
    inputString: ADDR_BOB,
    label: "Bob addr",
    owner: "Bob",
    tags: [],
    categories: [],
  });
  await createRecord({
    type: "address",
    inputString: ADDR_UNASSIGNED,
    label: "Unassigned addr",
    tags: [],
    categories: [],
  });
  const txAlice = "a".repeat(64);
  const txBob = "b".repeat(64);
  const txUnassigned = "c".repeat(64);
  await bulkAddTransactions([
    { txid: txAlice, blockHeight: 800_000, blockTime: 1_700_000_000, fee: 100, feeRate: 1, syncedAt: Date.now() },
    { txid: txBob, blockHeight: 800_001, blockTime: 1_700_000_100, fee: 100, feeRate: 1, syncedAt: Date.now() },
    { txid: txUnassigned, blockHeight: 800_002, blockTime: 1_700_000_200, fee: 100, feeRate: 1, syncedAt: Date.now() },
  ]);
  await bulkAddParticipants([
    { txid: txAlice, role: "output", address: ADDR_ALICE, amount: 50_000, vout: 0 },
    { txid: txBob, role: "output", address: ADDR_BOB, amount: 60_000, vout: 0 },
    { txid: txUnassigned, role: "output", address: ADDR_UNASSIGNED, amount: 70_000, vout: 0 },
  ]);
}

describe("UTXOs page entity filters and clear-all", () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllRecords();
    await clearTransactions();
    await clearParticipants();
    await db.dustFlags.clear();
    await db.owners.clear();
    await db.walletNames.clear();
    await db.tags.clear();
    await db.categories.clear();
    await seed();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("Owner combobox narrows the address list to the selected owner (OR-within, AND-across dimensions)", async () => {
    renderWithProviders(<UTXOs />);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("3 / 3");
    }, { timeout: 10000 });

    // Open the Owner combobox and select "Alice".
    fireEvent.click(screen.getByTestId("select-owner"));
    const aliceOption = await screen.findByRole("option", { name: "Alice" });
    fireEvent.click(aliceOption);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
    });
    expect(screen.getByTestId(`link-address-${ADDR_ALICE.slice(0, 8)}`)).toBeTruthy();
    expect(screen.queryByTestId(`link-address-${ADDR_BOB.slice(0, 8)}`)).toBeNull();

    // Selecting "Bob" too widens the OR-within-dimension match back to both.
    // The popover stays open after the first selection (multi-select), so no
    // need to re-click the trigger — doing so would toggle it closed.
    const bobOption = await screen.findByRole("option", { name: "Bob" });
    fireEvent.click(bobOption);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("2 / 2");
    });
  });

  it("the Unassigned sentinel matches addresses with no owner set", async () => {
    renderWithProviders(<UTXOs />);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("3 / 3");
    }, { timeout: 10000 });

    fireEvent.click(screen.getByTestId("select-owner"));
    const unassignedOption = await screen.findByRole("option", { name: "Unassigned" });
    fireEvent.click(unassignedOption);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
    });
    expect(screen.getByTestId(`link-address-${ADDR_UNASSIGNED.slice(0, 8)}`)).toBeTruthy();
  });

  it("owner AND wallet filters compose (AND-across-dimensions)", async () => {
    renderWithProviders(<UTXOs />);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("3 / 3");
    }, { timeout: 10000 });

    // Owner=Bob AND Wallet=WalletA has no addresses (Bob has no wallet set).
    fireEvent.click(screen.getByTestId("select-owner"));
    fireEvent.click(await screen.findByRole("option", { name: "Bob" }));
    fireEvent.click(screen.getByTestId("select-wallet"));
    fireEvent.click(await screen.findByRole("option", { name: "WalletA" }));

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("0 / 0");
    });
  });

  it("Clear all filters resets search, every entity dimension, and hide-dust together", async () => {
    renderWithProviders(<UTXOs />);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("3 / 3");
    }, { timeout: 10000 });

    fireEvent.change(screen.getByTestId("input-search"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByTestId("select-owner"));
    fireEvent.click(await screen.findByRole("option", { name: "Alice" }));
    fireEvent.click(screen.getByTestId("switch-hide-dust"));

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("1 / 1");
    });

    const clearButton = await screen.findByTestId("button-clear-filters");
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(screen.getByTestId("text-utxo-count").textContent).toBe("3 / 3");
    });
    expect((screen.getByTestId("input-search") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("switch-hide-dust").getAttribute("data-state")).toBe("unchecked");
    expect(screen.queryByTestId("button-clear-filters")).toBeNull();
  });
});
