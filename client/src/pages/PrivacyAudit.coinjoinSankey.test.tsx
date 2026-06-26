// @vitest-environment jsdom
//
// Coverage for the CoinJoin fund-flow Sankey in the transaction deep-dive
// (Task: "Test the CoinJoin fund-flow diagram in the transaction deep-dive").
//
// The deep-dive (DeepDiveDialog → TransactionDeepDive) renders a CoinJoin
// fund-flow Sankey (container data-testid="container-coinjoin-sankey") only when
// the opened txid is in the coinjoinTxids set. For an ordinary transaction the
// Sankey must be absent. We also unit-test buildSankey to confirm each input's
// value is distributed across the outputs proportionally.
//
// We render the real DeepDiveDialog (controlled-open, no trigger) so the whole
// auto-analyse → setData → Sankey render path runs. The two data loaders it
// calls are mocked (no IndexedDB) and the Boltzmann Worker is stubbed since the
// Sankey itself doesn't depend on the worker result.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionByTxid: vi.fn(),
}));
vi.mock("@/lib/data/record-queries", () => ({
  getParticipantsByTxids: vi.fn(),
}));

import { getTransactionByTxid } from "@/lib/data/transaction-crud";
import { getParticipantsByTxids } from "@/lib/data/record-queries";
import { DeepDiveDialog, buildSankey } from "./PrivacyAudit";

const TXID = "a".repeat(64);

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

const mockedGetTx = vi.mocked(getTransactionByTxid);
const mockedGetParticipants = vi.mocked(getParticipantsByTxids);

// A CoinJoin-shaped tx: two inputs, two equal-sized outputs.
function coinjoinParticipants() {
  return [
    { txid: TXID, role: "input", address: "bc1qinput1", amount: 100_000, vout: 0 },
    { txid: TXID, role: "input", address: "bc1qinput2", amount: 100_000, vout: 0 },
    { txid: TXID, role: "output", address: "bc1qout1", amount: 99_000, vout: 0 },
    { txid: TXID, role: "output", address: "bc1qout2", amount: 99_000, vout: 1 },
  ] as any;
}

function renderDialog(coinjoinTxids: Set<string>) {
  return render(
    <DeepDiveDialog
      txid={TXID}
      coinjoinTxids={coinjoinTxids}
      open
      showTrigger={false}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  mockedGetTx.mockResolvedValue({ txid: TXID, fee: 2_000 } as any);
  mockedGetParticipants.mockResolvedValue(coinjoinParticipants());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DeepDiveDialog CoinJoin fund-flow Sankey", () => {
  it("renders the Sankey when the txid is a CoinJoin", async () => {
    renderDialog(new Set<string>([TXID]));

    // The dialog opens and auto-analyses the txid.
    expect(await screen.findByTestId("dialog-deep-dive")).toBeTruthy();

    // The fund-flow Sankey appears for a CoinJoin transaction.
    expect(await screen.findByTestId("container-coinjoin-sankey")).toBeTruthy();
  });

  it("does not render the Sankey for an ordinary (non-CoinJoin) transaction", async () => {
    // Same participant data, but the txid is NOT flagged as a CoinJoin.
    renderDialog(new Set<string>());

    expect(await screen.findByTestId("dialog-deep-dive")).toBeTruthy();

    // Wait until the analysis has loaded participant data (worker posted to),
    // then confirm the Sankey is still absent.
    await waitFor(() => {
      expect(mockedGetParticipants).toHaveBeenCalled();
    });
    // Give any post-load render a chance to flush, then assert absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("container-coinjoin-sankey")).toBeNull();
  });
});

describe("buildSankey", () => {
  it("distributes each input proportionally across the outputs", () => {
    const inputs = [
      { txid: TXID, role: "input", address: "in1", amount: 100_000, vout: 0 },
      { txid: TXID, role: "input", address: "in2", amount: 300_000, vout: 0 },
    ] as any;
    const outputs = [
      { txid: TXID, role: "output", address: "out1", amount: 200_000, vout: 0 },
      { txid: TXID, role: "output", address: "out2", amount: 200_000, vout: 1 },
    ] as any;

    const { nodes, links } = buildSankey(inputs, outputs);

    // 2 inputs + 2 outputs = 4 nodes; outputs are indexed after the inputs.
    expect(nodes).toHaveLength(4);
    // Fully connected: every input links to every output (all values > 0).
    expect(links).toHaveLength(4);

    const totalIn = 400_000;
    // input i (si), output t (target = inputs.length + ti)
    const find = (si: number, ti: number) =>
      links.find((l) => l.source === si && l.target === inputs.length + ti);

    // in1 (100k / 400k = 25%) feeds 25% of each 200k output = 50k each.
    expect(find(0, 0)!.value).toBe(Math.round((100_000 / totalIn) * 200_000));
    expect(find(0, 0)!.value).toBe(50_000);
    expect(find(0, 1)!.value).toBe(50_000);
    // in2 (300k / 400k = 75%) feeds 75% of each 200k output = 150k each.
    expect(find(1, 0)!.value).toBe(150_000);
    expect(find(1, 1)!.value).toBe(150_000);

    // Each output receives its full value back across all input links.
    const out0Total = links
      .filter((l) => l.target === inputs.length + 0)
      .reduce((s, l) => s + l.value, 0);
    expect(out0Total).toBe(200_000);
  });

  it("omits zero-value links (skips empty inputs/outputs)", () => {
    const inputs = [
      { txid: TXID, role: "input", address: "in1", amount: 100_000, vout: 0 },
    ] as any;
    const outputs = [
      { txid: TXID, role: "output", address: "out1", amount: 100_000, vout: 0 },
      { txid: TXID, role: "output", address: "out2", amount: 0, vout: 1 },
    ] as any;

    const { links } = buildSankey(inputs, outputs);

    // The zero-amount output produces a zero-value link, which is dropped.
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ source: 0, target: 1, value: 100_000 });
  });
});
