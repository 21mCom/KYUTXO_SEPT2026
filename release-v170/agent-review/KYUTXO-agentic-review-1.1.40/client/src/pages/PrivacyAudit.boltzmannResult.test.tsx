// @vitest-environment jsdom
//
// End-to-end coverage for the Transaction Deep-Dive's *Boltzmann result render*
// (Task: "Confirm the deep-dive's Boltzmann analysis actually renders its
// results").
//
// The deep-dive runs its Boltzmann entropy / link-probability analysis in a Web
// Worker (client/src/lib/boltzmann.worker.ts). Workers don't exist under jsdom,
// so the worker path was previously only exercised with synthetic
// `{ tooComplex: true }` payloads — the real entropy / interpretations /
// efficiency numbers (the core forensic value of the deep-dive) were never
// asserted end to end.
//
// Here the MockWorker runs the SAME pure computation the real worker runs
// (computeBoltzmann) on exactly the inputs the component posts to it, so this
// test exercises the full chain: participant rows → BoltzmannInput/Output
// mapping (rounding, fee) → real Boltzmann algorithm → rendered cells. We cover:
//   1. A seeded equal-value (CoinJoin-like) tx that yields >1 interpretation and
//      non-zero entropy, asserting the rendered entropy / interpretations /
//      efficiency match the computed result.
//   2. The "too complex" branch (>8×8) message path.
//   3. The worker-error path (text-deep-dive-message + button-retry-deep-dive).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionByTxid: vi.fn(),
  getParticipantsByTxids: vi.fn(),
}));

// Radix Select doesn't open under jsdom; swap for a minimal native <select>.
// (The single-txid tests below never render it, but TransactionDeepDive imports
// it, so the mock keeps the module cheap and import-safe.)
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger: any = () => null;
  SelectTrigger.__isTrigger = true;
  return {
    Select: ({ value, onValueChange, children }: any) => {
      let testid: string | undefined;
      React.Children.forEach(children, (child: any) => {
        if (child && child.type && child.type.__isTrigger) {
          testid = child.props["data-testid"];
        }
      });
      return React.createElement(
        "select",
        {
          "data-testid": testid,
          value: value ?? "",
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) =>
      React.createElement("option", { value }, children),
  };
});

import { getTransactionByTxid } from "@/lib/data/transaction-crud";
import { getParticipantsByTxids } from "@/lib/data/transaction-crud";
import {
  computeBoltzmann,
  formatEntropy,
  type BoltzmannInput,
  type BoltzmannOutput,
  type BoltzmannResult,
} from "@/lib/boltzmann";
import { TransactionDeepDive } from "./PrivacyAudit";

const TXID = "f".repeat(64);

// A captured handle to the most recently constructed mock Worker.
let lastWorker: MockWorker | null = null;

// Faithfully mirrors client/src/lib/boltzmann.worker.ts: on postMessage it runs
// the real computeBoltzmann on the posted inputs and delivers the result via
// onmessage. The dispatch is deferred so a test can flush it inside act().
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage = vi.fn((data: any) => {
    this._lastData = data;
  });
  terminate = vi.fn();
  _lastData: any = null;
  constructor() {
    lastWorker = this;
  }
  // Run the same computation the real worker would and deliver it.
  deliverReal() {
    const { id, inputs, outputs, fee } = this._lastData as {
      id: string;
      inputs: BoltzmannInput[];
      outputs: BoltzmannOutput[];
      fee: number;
    };
    const result = computeBoltzmann(inputs, outputs, fee);
    this.onmessage?.({ data: { id, result, error: null } } as MessageEvent);
    return result;
  }
  // Deliver an arbitrary, hand-seeded result (used to pin the heatmap render to a
  // known link matrix instead of whatever computeBoltzmann happens to produce).
  deliver(result: BoltzmannResult) {
    const { id } = this._lastData as { id: string };
    this.onmessage?.({ data: { id, result, error: null } } as MessageEvent);
  }
}

const mockedGetTx = vi.mocked(getTransactionByTxid);
const mockedGetParticipants = vi.mocked(getParticipantsByTxids);

function renderDeepDive(coinjoinTxids: Set<string> = new Set<string>()) {
  return render(
    <TransactionDeepDive txids={[TXID]} coinjoinTxids={coinjoinTxids} />,
  );
}

beforeEach(() => {
  lastWorker = null;
  vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TransactionDeepDive Boltzmann result rendering", () => {
  it("renders the real entropy, interpretations and efficiency for a seeded multi-interpretation tx", async () => {
    // Two equal inputs → two equal outputs (a CoinJoin-shaped tx). With no fee
    // this has several valid balanced partitions, so entropy > 0 and there is
    // more than one interpretation — i.e. genuine forensic output, not the
    // trivial fully-traceable case.
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 0 } as any);
    mockedGetParticipants.mockResolvedValue([
      { txid: TXID, role: "input", address: "bc1qin0", amount: 100_000, vout: 0 },
      { txid: TXID, role: "input", address: "bc1qin1", amount: 100_000, vout: 1 },
      { txid: TXID, role: "output", address: "bc1qout0", amount: 100_000, vout: 0 },
      { txid: TXID, role: "output", address: "bc1qout1", amount: 100_000, vout: 1 },
    ] as any);

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    // Wait until the component has mapped participants → boltzmann inputs and
    // posted them to the worker.
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // The worker runs the REAL computeBoltzmann on exactly what the component
    // posted, then delivers it back — this is the full data→compute→render path.
    let result!: ReturnType<typeof computeBoltzmann>;
    act(() => {
      result = lastWorker!.deliverReal();
    });

    // Sanity: this fixture must produce a genuine, non-trivial result.
    expect(result.tooComplex).toBe(false);
    expect(result.interpretationCount).toBeGreaterThan(1);
    expect(result.entropy).toBeGreaterThan(0);
    expect(result.maxEntropy).toBeGreaterThan(0);

    // The result container renders (not the too-complex message).
    const container = await screen.findByTestId("container-boltzmann-result");
    expect(container).toBeTruthy();

    // Entropy / interpretations / efficiency render the computed values.
    expect(screen.getByTestId("text-boltzmann-entropy").textContent).toBe(
      formatEntropy(result.entropy),
    );
    expect(
      screen.getByTestId("text-boltzmann-interpretations").textContent,
    ).toBe(result.interpretationCount.toLocaleString());
    expect(screen.getByTestId("text-boltzmann-efficiency").textContent).toBe(
      `${(result.efficiency * 100).toFixed(0)}%`,
    );

    // The entropy label / interpretation copy renders too.
    expect(container.textContent).toContain(result.entropyLabel);

    // And the link-probability heatmap (built from the real link matrix) shows.
    expect(result.linkMatrix.length).toBeGreaterThan(0);
    expect(screen.getByTestId("cell-heatmap-0-0")).toBeTruthy();
  });

  it("renders each heatmap cell's probability from the link matrix in the correct input-row/output-column orientation", async () => {
    // A 2×2 link matrix with deliberately ASYMMETRIC off-diagonal entries and
    // empty diagonal cells. Asymmetry is the whole point: if the component ever
    // transposed the matrix (used inputIndex as the column / outputIndex as the
    // row), cell (0,1) and cell (1,0) would swap values and this test would fail.
    // The probabilities are also chosen to exercise the percentage rounding:
    // 0.25 → "25", 0.666 → "67" (rounds up), 0.5 → "50".
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 0 } as any);
    mockedGetParticipants.mockResolvedValue([
      { txid: TXID, role: "input", address: "bc1qin0", amount: 100_000, vout: 0 },
      { txid: TXID, role: "input", address: "bc1qin1", amount: 100_000, vout: 1 },
      { txid: TXID, role: "output", address: "bc1qout0", amount: 100_000, vout: 0 },
      { txid: TXID, role: "output", address: "bc1qout1", amount: 100_000, vout: 1 },
    ] as any);

    const seeded: BoltzmannResult = {
      entropy: 1,
      entropyLabel: "Very Low",
      interpretationCount: 2,
      tooComplex: false,
      efficiency: 0.5,
      maxEntropy: 2,
      linkMatrix: [
        // I0 funded O1 a quarter of the time.
        { inputIndex: 0, outputIndex: 1, inputAddress: "bc1qin0", outputAddress: "bc1qout1", probability: 0.25 },
        // I1 funded O0 two-thirds of the time (rounds to 67%).
        { inputIndex: 1, outputIndex: 0, inputAddress: "bc1qin1", outputAddress: "bc1qout0", probability: 0.666 },
        // I1 funded O1 half the time.
        { inputIndex: 1, outputIndex: 1, inputAddress: "bc1qin1", outputAddress: "bc1qout1", probability: 0.5 },
      ],
    };

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Deliver the hand-seeded result instead of the computed one.
    act(() => {
      lastWorker!.deliver(seeded);
    });

    expect(await screen.findByTestId("container-boltzmann-heatmap")).toBeTruthy();

    // Filled cells show their rounded percentage in the right cell.
    expect(screen.getByTestId("cell-heatmap-0-1").textContent).toBe("25");
    expect(screen.getByTestId("cell-heatmap-1-0").textContent).toBe("67");
    expect(screen.getByTestId("cell-heatmap-1-1").textContent).toBe("50");

    // Empty cell (no matrix entry) renders the placeholder, not "0" or a number.
    expect(screen.getByTestId("cell-heatmap-0-0").textContent).toBe("–");

    // Orientation guard: a transposed matrix would put I1→O0's 67% in cell (0,1)
    // and I0→O1's 25% in cell (1,0). Assert the opposite explicitly.
    expect(screen.getByTestId("cell-heatmap-0-1").textContent).not.toBe("67");
    expect(screen.getByTestId("cell-heatmap-1-0").textContent).not.toBe("25");

    // The cell's title attribute also encodes the I→O orientation.
    expect(screen.getByTestId("cell-heatmap-0-1").getAttribute("title")).toBe(
      "I0→O1: 25%",
    );
    expect(screen.getByTestId("cell-heatmap-1-0").getAttribute("title")).toBe(
      "I1→O0: 67%",
    );
  });

  it("shows the too-complex message for a transaction beyond the 8×8 limit", async () => {
    // Nine inputs exceeds MAX_INPUTS (8), so computeBoltzmann returns
    // tooComplex and the panel must render the explanatory message instead of
    // entropy numbers.
    const inputs = Array.from({ length: 9 }, (_, i) => ({
      txid: TXID,
      role: "input",
      address: `bc1qin${i}`,
      amount: 10_000 + i,
      vout: i,
    }));
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 0 } as any);
    mockedGetParticipants.mockResolvedValue([
      ...inputs,
      { txid: TXID, role: "output", address: "bc1qout0", amount: 90_000, vout: 0 },
    ] as any);

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    let result!: ReturnType<typeof computeBoltzmann>;
    act(() => {
      result = lastWorker!.deliverReal();
    });
    expect(result.tooComplex).toBe(true);

    const container = await screen.findByTestId("container-boltzmann-result");
    expect(container.textContent).toContain(
      "too many inputs/outputs for exact Boltzmann analysis",
    );

    // No entropy numbers in the too-complex branch.
    expect(screen.queryByTestId("text-boltzmann-entropy")).toBeNull();
    expect(screen.queryByTestId("text-boltzmann-interpretations")).toBeNull();
    expect(screen.queryByTestId("text-boltzmann-efficiency")).toBeNull();
  });

  it("surfaces the failure message and Retry when the worker errors", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue([
      { txid: TXID, role: "input", address: "bc1qin0", amount: 100_000, vout: 0 },
      { txid: TXID, role: "output", address: "bc1qout0", amount: 99_000, vout: 0 },
    ] as any);

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // The worker thread blows up instead of returning a result.
    act(() => {
      lastWorker!.onerror!({ message: "the analysis worker stopped unexpectedly" });
    });

    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain(
      "Couldn't analyse this transaction — the calculation failed unexpectedly.",
    );
    expect(screen.getByTestId("button-retry-deep-dive")).toBeTruthy();

    // No result container on the error path.
    expect(screen.queryByTestId("container-boltzmann-result")).toBeNull();
  });
});

// ─── CoinJoin Sankey wiring ───────────────────────────────────────────────────
//
// The deep-dive renders the CoinJoin fund-flow Sankey
// (container-coinjoin-sankey) ONLY when the analysed txid is in the
// `coinjoinTxids` set passed to TransactionDeepDive. The buildSankey helper has
// its own unit coverage, but the wiring at the TransactionDeepDive level — that
// a coinjoin txid surfaces the Sankey *alongside* the Boltzmann result, and a
// non-coinjoin txid does not — is asserted here using the same real
// participants→compute→render path the Boltzmann tests use.
describe("TransactionDeepDive CoinJoin Sankey wiring", () => {
  // A CoinJoin-shaped tx: two equal inputs → two equal outputs. This both yields
  // a genuine Boltzmann result and (when flagged) proportional Sankey links.
  function seedCoinjoinShapedTx() {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 0 } as any);
    mockedGetParticipants.mockResolvedValue([
      { txid: TXID, role: "input", address: "bc1qin0", amount: 100_000, vout: 0 },
      { txid: TXID, role: "input", address: "bc1qin1", amount: 100_000, vout: 1 },
      { txid: TXID, role: "output", address: "bc1qout0", amount: 100_000, vout: 0 },
      { txid: TXID, role: "output", address: "bc1qout1", amount: 100_000, vout: 1 },
    ] as any);
  }

  it("surfaces the Sankey alongside the Boltzmann result when the txid is a CoinJoin", async () => {
    seedCoinjoinShapedTx();

    // The analysed txid is flagged as a CoinJoin.
    renderDeepDive(new Set<string>([TXID]));
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Deliver the real Boltzmann result so the result container renders too.
    act(() => {
      lastWorker!.deliverReal();
    });

    // Both the Boltzmann result AND the CoinJoin Sankey are present.
    expect(await screen.findByTestId("container-boltzmann-result")).toBeTruthy();
    expect(await screen.findByTestId("container-coinjoin-sankey")).toBeTruthy();
  });

  it("keeps the Sankey for a flagged CoinJoin even when Boltzmann is too complex (>8×8)", async () => {
    // A large CoinJoin: nine equal inputs → nine equal outputs. Nine inputs
    // exceeds MAX_INPUTS (8) so computeBoltzmann returns tooComplex, but
    // buildSankey has no size cap and still produces proportional links. This
    // is exactly the large mix a user most wants to inspect, so the Sankey must
    // NOT be gated on a successful Boltzmann result.
    const inputs = Array.from({ length: 9 }, (_, i) => ({
      txid: TXID,
      role: "input",
      address: `bc1qin${i}`,
      amount: 100_000,
      vout: i,
    }));
    const outputs = Array.from({ length: 9 }, (_, i) => ({
      txid: TXID,
      role: "output",
      address: `bc1qout${i}`,
      amount: 100_000,
      vout: i,
    }));
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 0 } as any);
    mockedGetParticipants.mockResolvedValue([...inputs, ...outputs] as any);

    // The analysed txid is flagged as a CoinJoin.
    renderDeepDive(new Set<string>([TXID]));
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // The real worker computation hits the too-complex branch.
    let result!: ReturnType<typeof computeBoltzmann>;
    act(() => {
      result = lastWorker!.deliverReal();
    });
    expect(result.tooComplex).toBe(true);

    // The Boltzmann panel shows the too-complex message (no entropy numbers)…
    const container = await screen.findByTestId("container-boltzmann-result");
    expect(container.textContent).toContain(
      "too many inputs/outputs for exact Boltzmann analysis",
    );
    expect(screen.queryByTestId("text-boltzmann-entropy")).toBeNull();

    // …and the CoinJoin Sankey still renders alongside it.
    expect(await screen.findByTestId("container-coinjoin-sankey")).toBeTruthy();
  });

  it("does not render the Sankey for a non-CoinJoin txid (Boltzmann result still shows)", async () => {
    // Same participant shape, but the txid is NOT flagged as a CoinJoin.
    seedCoinjoinShapedTx();

    renderDeepDive(new Set<string>());
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    act(() => {
      lastWorker!.deliverReal();
    });

    // The Boltzmann result renders, but the Sankey is absent for a plain tx.
    expect(await screen.findByTestId("container-boltzmann-result")).toBeTruthy();
    expect(screen.queryByTestId("container-coinjoin-sankey")).toBeNull();
  });
});
