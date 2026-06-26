// @vitest-environment jsdom
//
// Success-path coverage for the Transaction Deep-Dive (Task: "Confirm the
// deep-dive shows its link-probability heatmap after analysis").
//
// The failure, empty, and CoinJoin-Sankey paths are already covered elsewhere
// (PrivacyAudit.deepDive.test.tsx, PrivacyAudit.coinjoinSankey.test.tsx), but
// nothing verified the *main* visual output of a successful analysis: once the
// Boltzmann worker returns a result with a non-empty linkMatrix, the panel must
//   1. render the colour-coded link-probability heatmap (one cell per
//      input/output pair), and
//   2. render the entropy / interpretations / efficiency summary numbers from
//      the worker result.
//
// We exercise the real component. The two data loaders are mocked (no
// IndexedDB) and the Boltzmann Worker is stubbed so we can drive its onmessage
// with a known result and assert what renders.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionByTxid: vi.fn(),
}));
vi.mock("@/lib/data/record-queries", () => ({
  getParticipantsByTxids: vi.fn(),
}));

import { getTransactionByTxid } from "@/lib/data/transaction-crud";
import { getParticipantsByTxids } from "@/lib/data/record-queries";
import { TransactionDeepDive } from "./PrivacyAudit";
import type { BoltzmannResult } from "@/lib/boltzmann";

const TXID = "b".repeat(64);

let lastWorker: MockWorker | null = null;

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    lastWorker = this;
  }
}

const mockedGetTx = vi.mocked(getTransactionByTxid);
const mockedGetParticipants = vi.mocked(getParticipantsByTxids);

// A 2-input / 2-output transaction so the heatmap has a 2×2 grid of cells.
function validParticipants() {
  return [
    { txid: TXID, role: "input", address: "bc1qin0", amount: 100_000, vout: 0 },
    { txid: TXID, role: "input", address: "bc1qin1", amount: 200_000, vout: 0 },
    { txid: TXID, role: "output", address: "bc1qout0", amount: 150_000, vout: 0 },
    { txid: TXID, role: "output", address: "bc1qout1", amount: 148_000, vout: 1 },
  ] as any;
}

// A successful Boltzmann result with a non-empty linkMatrix. Probabilities are
// chosen so each cell renders a distinct, predictable percentage.
function successResult(): BoltzmannResult {
  return {
    entropy: 1.5,
    entropyLabel: "Very Low",
    interpretationCount: 3,
    tooComplex: false,
    efficiency: 0.75,
    maxEntropy: 2,
    linkMatrix: [
      { inputIndex: 0, outputIndex: 0, inputAddress: "bc1qin0", outputAddress: "bc1qout0", probability: 1 },
      { inputIndex: 0, outputIndex: 1, inputAddress: "bc1qin0", outputAddress: "bc1qout1", probability: 0.5 },
      { inputIndex: 1, outputIndex: 0, inputAddress: "bc1qin1", outputAddress: "bc1qout0", probability: 0.25 },
      { inputIndex: 1, outputIndex: 1, inputAddress: "bc1qin1", outputAddress: "bc1qout1", probability: 0 },
    ],
  };
}

function renderDeepDive() {
  return render(<TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} />);
}

// Run analyse(), wait for the worker to be posted to, then drive a valid result
// back through onmessage using the id from the latest postMessage.
async function analyseWith(result: BoltzmannResult) {
  renderDeepDive();
  fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

  await waitFor(() => {
    expect(lastWorker).not.toBeNull();
    expect(lastWorker!.postMessage).toHaveBeenCalled();
  });

  const calls = lastWorker!.postMessage.mock.calls;
  const { id } = calls[calls.length - 1][0] as { id: string };
  act(() => {
    lastWorker!.onmessage!({ data: { id, result } } as MessageEvent);
  });
}

beforeEach(() => {
  lastWorker = null;
  vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  mockedGetTx.mockResolvedValue({ txid: TXID, fee: 2_000 } as any);
  mockedGetParticipants.mockResolvedValue(validParticipants());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TransactionDeepDive success path — heatmap", () => {
  it("renders the link-probability heatmap with a cell per input/output pair", async () => {
    await analyseWith(successResult());

    // The results container and the heatmap itself appear.
    expect(await screen.findByTestId("container-boltzmann-result")).toBeTruthy();
    expect(await screen.findByTestId("container-boltzmann-heatmap")).toBeTruthy();

    // A 2×2 grid: one cell for every input/output pair.
    expect(screen.getByTestId("cell-heatmap-0-0")).toBeTruthy();
    expect(screen.getByTestId("cell-heatmap-0-1")).toBeTruthy();
    expect(screen.getByTestId("cell-heatmap-1-0")).toBeTruthy();
    expect(screen.getByTestId("cell-heatmap-1-1")).toBeTruthy();

    // Cell contents reflect each probability as a rounded percentage; a zero
    // probability renders the "–" placeholder rather than "0".
    expect(screen.getByTestId("cell-heatmap-0-0").textContent).toBe("100");
    expect(screen.getByTestId("cell-heatmap-0-1").textContent).toBe("50");
    expect(screen.getByTestId("cell-heatmap-1-0").textContent).toBe("25");
    expect(screen.getByTestId("cell-heatmap-1-1").textContent).toBe("–");
  });

  it("renders the entropy / interpretations / efficiency summary numbers from the worker result", async () => {
    await analyseWith(successResult());

    expect(await screen.findByTestId("container-boltzmann-result")).toBeTruthy();

    expect(screen.getByTestId("text-boltzmann-entropy").textContent).toBe("1.50 bits");
    expect(screen.getByTestId("text-boltzmann-interpretations").textContent).toBe("3");
    // efficiency 0.75 → 75% (maxEntropy > 0).
    expect(screen.getByTestId("text-boltzmann-efficiency").textContent).toBe("75%");

    // The transaction summary tiles also render from the loaded participant data.
    expect(screen.getByTestId("text-deep-dive-inputs").textContent).toBe("2");
    expect(screen.getByTestId("text-deep-dive-outputs").textContent).toBe("2");

    // A successful analysis shows no failure affordances.
    expect(screen.queryByTestId("text-deep-dive-message")).toBeNull();
    expect(screen.queryByTestId("button-retry-deep-dive")).toBeNull();
  });

  it("omits the heatmap when the result has an empty linkMatrix (but still shows the summary)", async () => {
    // A deterministic / zero-entropy result legitimately has no link matrix:
    // the summary numbers still render, but the heatmap must be absent.
    await analyseWith({
      entropy: 0,
      entropyLabel: "None (fully traceable)",
      interpretationCount: 0,
      tooComplex: false,
      efficiency: 0,
      maxEntropy: 0,
      linkMatrix: [],
    });

    expect(await screen.findByTestId("container-boltzmann-result")).toBeTruthy();
    expect(screen.getByTestId("text-boltzmann-entropy").textContent).toBe("0.00 bits");
    // maxEntropy 0 → efficiency shown as an em dash.
    expect(screen.getByTestId("text-boltzmann-efficiency").textContent).toBe("—");
    expect(screen.queryByTestId("container-boltzmann-heatmap")).toBeNull();
  });
});
