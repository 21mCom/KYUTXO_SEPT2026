// @vitest-environment jsdom
//
// Auto-run coverage for the Transaction Deep-Dive (Task: "Confirm the deep-dive
// auto-runs and shows the heatmap when opened from a finding").
//
// When the deep-dive is opened directly from a flagged finding it is given the
// `autoAnalyse` prop, and an effect (the autoRunRef useEffect) must fire
// analyse() exactly once — with no button click — so the user lands on results
// instead of an empty panel. The heatmap success-path tests
// (PrivacyAudit.heatmap.test.tsx) all click the Analyse button manually; this
// file verifies the auto-run path itself:
//   1. analyse() runs exactly once (the worker is posted to) without any user
//      interaction, and a valid worker result renders the heatmap + summary, and
//   2. it does not re-run on re-render (the autoRunRef guard holds).
//
// We exercise the real component. The two data loaders are mocked (no
// IndexedDB) and the Boltzmann Worker is stubbed so we can drive its onmessage
// with a known result and assert what renders.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

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

const TXID = "c".repeat(64);

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

// A successful Boltzmann result with a non-empty linkMatrix.
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

// Wait until the auto-run effect has posted to the worker, then drive a valid
// result back through onmessage using the id from the latest postMessage.
async function driveResult(result: BoltzmannResult) {
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

describe("TransactionDeepDive auto-run — opened from a finding", () => {
  it("runs analyse exactly once without a button click and renders the heatmap + summary", async () => {
    render(<TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} autoAnalyse />);

    // The analysis fires on its own: the worker is created and posted to, with
    // no user interaction whatsoever.
    await driveResult(successResult());

    // analyse() loaded the data and posted to the worker exactly once.
    expect(mockedGetParticipants).toHaveBeenCalledTimes(1);
    expect(lastWorker!.postMessage).toHaveBeenCalledTimes(1);

    // The results, heatmap, and summary all render from the worker result.
    expect(await screen.findByTestId("container-boltzmann-result")).toBeTruthy();
    expect(await screen.findByTestId("container-boltzmann-heatmap")).toBeTruthy();
    expect(screen.getByTestId("cell-heatmap-0-0").textContent).toBe("100");
    expect(screen.getByTestId("cell-heatmap-1-1").textContent).toBe("–");
    expect(screen.getByTestId("text-boltzmann-entropy").textContent).toBe("1.50 bits");
    expect(screen.getByTestId("text-boltzmann-interpretations").textContent).toBe("3");
    expect(screen.getByTestId("text-boltzmann-efficiency").textContent).toBe("75%");

    // A successful auto-run shows no empty/failure affordances.
    expect(screen.queryByTestId("text-deep-dive-message")).toBeNull();
    expect(screen.queryByTestId("button-retry-deep-dive")).toBeNull();
  });

  it("does not re-run on re-render (autoRunRef guard)", async () => {
    const { rerender } = render(
      <TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} autoAnalyse />,
    );

    await driveResult(successResult());
    expect(lastWorker!.postMessage).toHaveBeenCalledTimes(1);

    // Re-render with the same props (and an unrelated prop change) — the guard
    // must prevent a second auto-run.
    rerender(<TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} autoAnalyse embedded />);
    rerender(<TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} autoAnalyse />);

    // Give any stray effect a chance to fire, then confirm nothing re-ran.
    await new Promise(r => setTimeout(r, 0));
    expect(mockedGetParticipants).toHaveBeenCalledTimes(1);
    expect(lastWorker!.postMessage).toHaveBeenCalledTimes(1);
  });

  it("does not auto-run when autoAnalyse is not set", async () => {
    render(<TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} />);

    // Let effects settle; with no autoAnalyse the panel stays idle until a click.
    await new Promise(r => setTimeout(r, 0));
    expect(mockedGetParticipants).not.toHaveBeenCalled();
    expect(lastWorker).toBeNull();
    expect(screen.queryByTestId("container-boltzmann-result")).toBeNull();
  });
});
