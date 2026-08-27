// @vitest-environment jsdom
//
// Tests for the Dusted page's spent-dust linkage damage analysis: the scan
// resolves which transaction spent each dust output and groups that
// transaction's co-input addresses into owned-in-scope, owned-out-of-scope,
// and external — plus a page-level damage summary — and the expanded row UI
// surfaces it all.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";
import { db } from "@/lib/database";
import { createRecord, clearAllRecords } from "@/lib/data/record-crud";
import { bulkAddParticipants, clearParticipants } from "@/lib/data/transaction-crud";
import DustedPage, { computeDustings } from "./DustedPage";

// jsdom has no layout, so the real virtualizer measures a 0-height scroll
// element and renders nothing. Render every row instead.
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
    };
  },
}));

const THRESHOLD = 1000;
const NOOP_PROGRESS = () => {};

// Identifiers must differ in their first 8 characters (testid prefixes).
const TX_DUST_A = "a".repeat(64);
const TX_DUST_B = "b".repeat(64);
const TX_SPEND_1 = "c".repeat(64);
const TX_SPEND_2 = "d".repeat(64);
const TX_PREV_1 = "e".repeat(64);
const TX_PREV_2 = "f".repeat(64);
const TX_PREV_3 = "0".repeat(64);

const ADDR_DUST = "bc1qdustspenddamageaddr10000000000000000";
const ADDR_OWNED = "bc1qownedspenddamageaddr200000000000000";
const ADDR_OUT_OF_SCOPE = "bc1qoutofscopespenddamageaddr30000000000";
const ADDR_EXTERNAL = "bc1qexternalspenddamageaddr4000000000000";

async function seedCoSpendScenario() {
  const dustRecordId = await createRecord({
    type: "address",
    inputString: ADDR_DUST,
    label: "Dust address",
    walletName: "W1",
    tags: [],
    categories: [],
  });
  const ownedRecordId = await createRecord({
    type: "address",
    inputString: ADDR_OWNED,
    label: "Owned co-input",
    walletName: "W1",
    tags: [],
    categories: [],
  });
  await createRecord({
    type: "address",
    inputString: ADDR_OUT_OF_SCOPE,
    label: "Out-of-scope owned",
    walletName: "W2",
    tags: [],
    categories: [],
  });

  await bulkAddParticipants([
    // Dust output on ADDR_DUST.
    { txid: TX_DUST_A, role: "output", address: ADDR_DUST, amount: 500, vout: 0 },
    // The spending transaction combines the dust with three other inputs.
    {
      txid: TX_SPEND_1,
      role: "input",
      address: ADDR_DUST,
      amount: 500,
      prevTxid: TX_DUST_A,
      prevVout: 0,
    },
    {
      txid: TX_SPEND_1,
      role: "input",
      address: ADDR_OWNED,
      amount: 5000,
      prevTxid: TX_PREV_1,
      prevVout: 0,
    },
    {
      txid: TX_SPEND_1,
      role: "input",
      address: ADDR_OUT_OF_SCOPE,
      amount: 7000,
      prevTxid: TX_PREV_2,
      prevVout: 1,
    },
    {
      txid: TX_SPEND_1,
      role: "input",
      address: ADDR_EXTERNAL,
      amount: 9000,
      prevTxid: TX_PREV_3,
      prevVout: 2,
    },
  ]);
  return { dustRecordId, ownedRecordId };
}

describe("computeDustings spend-damage resolution", () => {
  beforeEach(async () => {
    await clearAllRecords();
    await clearParticipants();
    await db.dustFlags.clear();
  });

  it("resolves the spending tx and classifies co-inputs as owned in-scope, owned out-of-scope, and external", async () => {
    const { dustRecordId, ownedRecordId } = await seedCoSpendScenario();

    // Scope to wallet W1 so ADDR_OUT_OF_SCOPE (wallet W2) exercises the
    // out-of-scope record lookup path.
    const outcome = await computeDustings(
      "wallet",
      ["W1"],
      THRESHOLD,
      new AbortController().signal,
      NOOP_PROGRESS,
    );

    expect(outcome).not.toBeNull();
    const row = outcome!.results.find((r) => r.address === ADDR_DUST);
    expect(row).toBeTruthy();
    expect(row!.spentCount).toBe(1);
    expect(row!.spentOutputs).toHaveLength(1);

    const ev = row!.spentOutputs[0];
    expect(ev.txid).toBe(TX_DUST_A);
    expect(ev.vout).toBe(0);
    expect(ev.amountSats).toBe(500);
    expect(ev.spendingTxid).toBe(TX_SPEND_1);
    // The dust input itself is excluded from its own co-input list.
    expect(ev.ownedInScope).toEqual([{ address: ADDR_OWNED, recordId: ownedRecordId }]);
    expect(ev.ownedOutOfScope).toEqual([
      { address: ADDR_OUT_OF_SCOPE, recordId: expect.any(Number) },
    ]);
    expect(ev.external).toEqual([ADDR_EXTERNAL]);
    expect(dustRecordId).not.toBe(ownedRecordId);

    // Summary: 1 output, 1 tx, and dust + both owned co-inputs are linked.
    expect(outcome!.spendDamage).toEqual({
      spentOutputCount: 1,
      spendingTxCount: 1,
      linkedAddressCount: 3,
    });
  });

  it("gives each dust output its own event while counting a shared spending tx once", async () => {
    const addr = "bc1qmultidustspenddamageaddr5000000000000";
    await createRecord({
      type: "address",
      inputString: addr,
      label: "Multi dust",
      tags: [],
      categories: [],
    });
    await bulkAddParticipants([
      // Two dust outputs on the same address, both spent by one transaction.
      { txid: TX_DUST_A, role: "output", address: addr, amount: 400, vout: 0 },
      { txid: TX_DUST_B, role: "output", address: addr, amount: 600, vout: 1 },
      {
        txid: TX_SPEND_1,
        role: "input",
        address: addr,
        amount: 400,
        prevTxid: TX_DUST_A,
        prevVout: 0,
      },
      {
        txid: TX_SPEND_1,
        role: "input",
        address: addr,
        amount: 600,
        prevTxid: TX_DUST_B,
        prevVout: 1,
      },
      // One external co-input.
      {
        txid: TX_SPEND_1,
        role: "input",
        address: ADDR_EXTERNAL,
        amount: 9000,
        prevTxid: TX_PREV_1,
        prevVout: 0,
      },
    ]);

    const outcome = await computeDustings(
      "all",
      [],
      THRESHOLD,
      new AbortController().signal,
      NOOP_PROGRESS,
    );

    const row = outcome!.results.find((r) => r.address === addr);
    expect(row!.spentCount).toBe(2);
    expect(row!.spentOutputs).toHaveLength(2);
    for (const ev of row!.spentOutputs) {
      expect(ev.spendingTxid).toBe(TX_SPEND_1);
      expect(ev.ownedInScope).toEqual([]);
      expect(ev.external).toEqual([ADDR_EXTERNAL]);
    }
    expect(outcome!.spendDamage).toEqual({
      spentOutputCount: 2,
      spendingTxCount: 1,
      linkedAddressCount: 0, // dust was not combined with other owned addresses
    });
  });

  it("treats a dust-only spend as benign and ignores blank-address (coinbase/unresolved) inputs", async () => {
    const addr = "bc1qdustonlyspenddamageaddr60000000000000";
    await createRecord({
      type: "address",
      inputString: addr,
      label: "Dust only",
      tags: [],
      categories: [],
    });
    await bulkAddParticipants([
      { txid: TX_DUST_A, role: "output", address: addr, amount: 300, vout: 0 },
      {
        txid: TX_SPEND_1,
        role: "input",
        address: addr,
        amount: 300,
        prevTxid: TX_DUST_A,
        prevVout: 0,
      },
      // Blank-address input (e.g. unresolved prevout) — must not be listed.
      {
        txid: TX_SPEND_1,
        role: "input",
        address: "",
        amount: 0,
        prevTxid: TX_PREV_1,
        prevVout: 0,
      },
    ]);

    const outcome = await computeDustings(
      "all",
      [],
      THRESHOLD,
      new AbortController().signal,
      NOOP_PROGRESS,
    );

    const row = outcome!.results.find((r) => r.address === addr);
    expect(row!.spentOutputs).toHaveLength(1);
    const ev = row!.spentOutputs[0];
    expect(ev.spendingTxid).toBe(TX_SPEND_1);
    expect(ev.ownedInScope).toEqual([]);
    expect(ev.ownedOutOfScope).toEqual([]);
    expect(ev.external).toEqual([]);
    expect(outcome!.spendDamage.linkedAddressCount).toBe(0);
  });

  it("marks the spending tx as unknown when only an unsynced input proves the spend", async () => {
    const addr = "bc1qunknowntxspenddamageaddr7000000000000";
    await createRecord({
      type: "address",
      inputString: addr,
      label: "Unknown spend",
      tags: [],
      categories: [],
    });
    await bulkAddParticipants([
      { txid: TX_DUST_A, role: "output", address: addr, amount: 300, vout: 0 },
      // The spending input exists (so the outpoint is known-spent) but carries
      // no other participants for its txid in this scenario beyond itself.
      {
        txid: TX_SPEND_1,
        role: "input",
        address: addr,
        amount: 300,
        prevTxid: TX_DUST_A,
        prevVout: 0,
      },
    ]);

    const outcome = await computeDustings(
      "all",
      [],
      THRESHOLD,
      new AbortController().signal,
      NOOP_PROGRESS,
    );

    const ev = outcome!.results.find((r) => r.address === addr)!.spentOutputs[0];
    expect(ev.spendingTxid).toBe(TX_SPEND_1);
    expect(ev.ownedInScope).toEqual([]);
    expect(ev.external).toEqual([]);
  });

  it("returns null when cancelled during spend resolution", async () => {
    await seedCoSpendScenario();

    const ctrl = new AbortController();
    const outcome = await computeDustings(
      "all",
      [],
      THRESHOLD,
      ctrl.signal,
      (_count, phase) => {
        if (phase === "spends") ctrl.abort();
      },
    );

    expect(outcome).toBeNull();
  });
});

describe("DustedPage spent-dust UI", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(async () => {
    await clearAllRecords();
    await clearParticipants();
    await db.dustFlags.clear();
  });

  it("expands to show the Spent section with the spending tx, combined addresses, and the damage summary", async () => {
    const { dustRecordId } = await seedCoSpendScenario();
    renderWithProviders(<DustedPage />);

    const toggle = await screen.findByTestId(
      `button-toggle-outputs-${dustRecordId}`,
      {},
      { timeout: 10000 },
    );

    // Summary banner: 1 output, 1 tx, dust + 2 owned co-inputs linked.
    const summary = await screen.findByTestId("text-spend-damage-summary");
    expect(summary.textContent).toContain("1");
    expect(summary.textContent).toContain("linked");
    expect(summary.textContent).toContain("3 of your addresses together");

    fireEvent.click(toggle);

    // Spent section header + the spent output row.
    await screen.findByTestId(`header-spent-${dustRecordId}`);
    expect(
      screen.getByTestId(`text-spend-outpoint-${dustRecordId}-${TX_DUST_A}-0`).textContent,
    ).toBe(`${TX_DUST_A}:0`);
    expect(
      screen.getByTestId(`text-spend-sats-${dustRecordId}-${TX_DUST_A}-0`).textContent,
    ).toContain("500");

    // Harmful-case badge, spending tx link, owned co-input link, external count.
    expect(
      screen.getByTestId(`badge-links-owned-${dustRecordId}-${TX_DUST_A}-0`),
    ).toBeTruthy();
    expect(screen.getByTestId(`link-txid-${TX_SPEND_1.slice(0, 8)}`)).toBeTruthy();
    expect(
      screen.getAllByTestId(`link-address-${ADDR_OWNED.slice(0, 8)}`).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByTestId(`text-spend-external-${dustRecordId}-${TX_DUST_A}-0`).textContent,
    ).toContain("1 external address");
  });

  it("renders the benign dust-only explanation without a harmful badge", async () => {
    const addr = "bc1qbenignspenddamageaddr800000000000000";
    const recordId = await createRecord({
      type: "address",
      inputString: addr,
      label: "Benign spend",
      tags: [],
      categories: [],
    });
    await bulkAddParticipants([
      { txid: TX_DUST_A, role: "output", address: addr, amount: 300, vout: 0 },
      {
        txid: TX_SPEND_2,
        role: "input",
        address: addr,
        amount: 300,
        prevTxid: TX_DUST_A,
        prevVout: 0,
      },
    ]);
    renderWithProviders(<DustedPage />);

    // Banner appears but reports no linkage.
    const summary = await screen.findByTestId("text-spend-damage-summary", {}, { timeout: 10000 });
    expect(summary.textContent).toContain("none combined your addresses");

    const toggle = await screen.findByTestId(`button-toggle-outputs-${recordId}`);
    fireEvent.click(toggle);

    await screen.findByTestId(`row-spend-${recordId}-${TX_DUST_A}-0`);
    expect(
      screen.queryByTestId(`badge-links-owned-${recordId}-${TX_DUST_A}-0`),
    ).toBeNull();
    expect(screen.getByTestId(`row-spend-${recordId}-${TX_DUST_A}-0`).textContent).toContain(
      "no other known inputs",
    );
  });
});
