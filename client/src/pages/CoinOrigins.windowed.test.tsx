// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoinOriginsPage } from "@/lib/coin-origins";
import CoinOriginsPageComponent from "./CoinOrigins";

const mocks = vi.hoisted(() => ({
  dbSignal: 0,
  engineGetCoinOriginsPage: vi.fn(),
}));

vi.mock("@/hooks/use-address-records", () => ({
  useAddressRecords: () => ({ records: [], isLoading: false }),
}));
vi.mock("@/hooks/use-db-change-signal", () => ({
  useDbChangeSignal: () => mocks.dbSignal,
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/lib/engine/engine-freshness", () => ({
  evaluateEngineFreshness: vi.fn(async () => ({ useEngine: true, reason: "ready-fresh" })),
}));
vi.mock("@/lib/engine/engine-client", () => ({
  engineGetCoinOrigins: vi.fn(),
  engineGetCoinOriginsPage: (...args: unknown[]) => mocks.engineGetCoinOriginsPage(...args),
}));

function page(txid: string, fingerprint: string): CoinOriginsPage {
  return {
    version: 1,
    fingerprint,
    checkpointKey: fingerprint,
    holdings: [{
      lotId: `lot:${txid}:0`,
      label: txid,
      acquiredTxid: txid,
      acquiredVout: 0,
      acquiredAt: 100,
      sats: 1,
      outpointCount: 1,
      boundary: "deterministic",
    }],
    outpoints: [{
      txid,
      vout: 0,
      address: `address-${txid}`,
      amountSats: 1,
      allocations: [],
      hopTxids: [],
      boundary: "deterministic",
    }],
    summary: {
      currentSats: 1,
      allocatedSats: 1,
      knownSats: 1,
      unknownSats: 0,
      disposedSats: 0,
      feeSats: 0,
      acquisitionSats: 1,
      reconciled: true,
    },
    holdingsOffset: 0,
    outpointsOffset: 0,
    holdingsTotal: 1,
    outpointsTotal: 1,
    lotsTotal: 1,
    holdingsHasMore: false,
    outpointsHasMore: false,
  };
}

describe("Coin Origins native windows", () => {
  beforeEach(() => {
    mocks.dbSignal = 0;
    mocks.engineGetCoinOriginsPage.mockReset();
  });

  afterEach(() => cleanup());

  it("drops a superseded broad-wallet page when the source changes", async () => {
    let resolveOld!: (value: CoinOriginsPage) => void;
    const oldPage = new Promise<CoinOriginsPage>((resolve) => { resolveOld = resolve; });
    mocks.engineGetCoinOriginsPage
      .mockReturnValueOnce(oldPage)
      .mockResolvedValueOnce(page("fresh-window", "fresh"));

    const view = render(<CoinOriginsPageComponent />);
    mocks.dbSignal = 1;
    view.rerender(<CoinOriginsPageComponent />);

    expect((await screen.findAllByText("fresh-window:0")).length).toBeGreaterThan(0);
    await act(async () => {
      resolveOld(page("stale-window", "stale"));
      await oldPage;
    });

    expect(screen.queryAllByText("stale-window:0")).toHaveLength(0);
    expect(screen.getAllByText("fresh-window:0").length).toBeGreaterThan(0);
    expect(mocks.engineGetCoinOriginsPage).toHaveBeenCalledTimes(2);
  });
});