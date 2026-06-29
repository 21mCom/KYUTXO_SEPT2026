// @vitest-environment jsdom
//
// Coverage for AnnualActivityReport's "unresolved input amounts" warning.
//
// generate()'s Step 6 backfill resolves spent-input amounts stored as 0 by
// looking up the referenced prevout's funding transaction. When that funding tx
// was never synced, resolveInputAmount silently falls back to 0 and the report
// under-counts BTC spent with no signal to the user.
//
// This test seeds pasted-address inputs (amount=0) whose funding txs are absent
// from synced data, so Step 6 cannot resolve them, and asserts:
//   (1) a non-blocking warning surfaces to the user;
//   (2) the unresolved count in the notice is correct.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const {
  MINE,
  EXT,
  spendTxid,
  prevTxid,
  getParticipantsByAddresses,
  getParticipantsByTxids,
  getParticipantsByPrevOutKeys,
  getTransactionsByTxids,
} = vi.hoisted(() => {
  // 3 pasted-address spends, each input amount=0 pointing to a prevout whose
  // funding tx is NEVER returned by the data layer → 3 unresolved prevouts that
  // remain 0 after the Step 6 backfill.
  const N = 3;
  const MINE = "bc1qmine0000000000000000000000000000000000";
  const EXT = "bc1qexternalzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

  const spendTxid = (i: number) => i.toString(16).padStart(64, "0");
  const prevTxid = (i: number) => (i + 0x500000).toString(16).padStart(64, "0");

  const TIME_2024 = Math.floor(Date.UTC(2024, 5, 1) / 1000);
  const BULK_SATS = 100_000_000;

  const spendInputs: any[] = [];
  const participantsByTxid = new Map<string, any[]>();
  const txBlockTime = new Map<string, number>();

  let idSeq = 1;
  for (let i = 0; i < N; i++) {
    const spend = spendTxid(i);
    const prev = prevTxid(i);
    const spendInput = {
      id: idSeq++,
      txid: spend,
      role: "input" as const,
      address: MINE,
      amount: 0,
      prevTxid: prev,
      prevVout: 0,
    };
    const spendOutput = {
      id: idSeq++,
      txid: spend,
      role: "output" as const,
      vout: 0,
      address: EXT,
      amount: BULK_SATS,
    };
    spendInputs.push(spendInput);
    // Note: the funding tx (prev) is intentionally NOT seeded, so its amount can
    // never be resolved — Step 6 backfill leaves these prevouts unresolved.
    participantsByTxid.set(spend, [spendInput, spendOutput]);
    txBlockTime.set(spend, TIME_2024);
  }

  const getParticipantsByAddresses = vi.fn((addrs: string[]) =>
    Promise.resolve(spendInputs.filter((p) => addrs.includes(p.address))),
  );
  const getParticipantsByTxids = vi.fn((txids: string[]) => {
    const out: any[] = [];
    for (const t of txids) {
      const list = participantsByTxid.get(t);
      if (list) out.push(...list);
    }
    return Promise.resolve(out);
  });
  const getParticipantsByPrevOutKeys = vi.fn(() => Promise.resolve([]));
  const getTransactionsByTxids = vi.fn((txids: string[]) =>
    Promise.resolve(
      txids
        .map((t) => (txBlockTime.has(t) ? { txid: t, blockTime: txBlockTime.get(t) } : null))
        .filter(Boolean),
    ),
  );

  return {
    MINE,
    EXT,
    spendTxid,
    prevTxid,
    getParticipantsByAddresses,
    getParticipantsByTxids,
    getParticipantsByPrevOutKeys,
    getTransactionsByTxids,
  };
});

vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddresses,
  getParticipantsByTxids,
}));

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionsByTxids,
  getParticipantsByPrevOutKeys,
}));

beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const AnnualActivityReport = (await import("../AnnualActivityReport")).default;

beforeEach(() => {
  getParticipantsByAddresses.mockClear();
  getParticipantsByTxids.mockClear();
  getParticipantsByPrevOutKeys.mockClear();
  getTransactionsByTxids.mockClear();
});

afterEach(() => {
  cleanup();
});

function generateReport() {
  renderWithProviders(<AnnualActivityReport />);
  fireEvent.change(screen.getByTestId("textarea-addresses"), {
    target: { value: MINE },
  });
  fireEvent.click(screen.getByTestId("button-generate"));
}

describe("AnnualActivityReport — unresolved input amount warning", () => {
  it("warns when funding txs for spent inputs were never synced and reports the count", async () => {
    generateReport();

    const warning = await screen.findByTestId("warning-unresolved-input-amounts");
    expect(warning).toBeTruthy();
    // All 3 seeded prevouts remain unresolved → the notice reports 3.
    expect(warning.textContent).toContain("3 input amounts could not be resolved");
    expect(warning.textContent).toContain("spent totals may be understated");
  });
});
