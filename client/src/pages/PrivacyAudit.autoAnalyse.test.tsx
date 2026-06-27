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

// Wait until the auto-run effect has posted to the worker, then crash the
// Boltzmann calculation by firing the worker's onerror callback — the same way
// the real worker reports an uncaught failure inside the calculation.
async function driveError(message: string) {
  await waitFor(() => {
    expect(lastWorker).not.toBeNull();
    expect(lastWorker!.postMessage).toHaveBeenCalled();
  });
  act(() => {
    lastWorker!.onerror!({ message } as { message: string });
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

describe("TransactionDeepDive auto-run — opened from a stale finding", () => {
  it("auto-runs once and shows the 'no participant data' message (no heatmap) when participants can't be loaded", async () => {
    // A flagged finding may point at a transaction whose participants are gone
    // (e.g. the address was never re-synced). analyse() should land on a clear
    // explanation, not a blank panel or a heatmap.
    mockedGetParticipants.mockResolvedValue([]);

    render(<TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} autoAnalyse />);

    // The auto-run fires on its own and surfaces the empty-data message.
    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain("No participant data available for this transaction");

    // It loaded the data exactly once — the auto-run guard held.
    expect(mockedGetParticipants).toHaveBeenCalledTimes(1);

    // With no inputs/outputs the Boltzmann worker is never created, so no
    // analysis, no heatmap, and no summary render.
    expect(lastWorker).toBeNull();
    expect(screen.queryByTestId("container-boltzmann-result")).toBeNull();
    expect(screen.queryByTestId("container-boltzmann-heatmap")).toBeNull();
    expect(screen.queryByTestId("container-deep-dive-summary")).toBeNull();

    // Empty data isn't a failure — there's nothing to retry, just re-sync.
    expect(screen.queryByTestId("button-retry-deep-dive")).toBeNull();
  });

  it("auto-runs once and shows a load-failure message with a Retry affordance when participants reject", async () => {
    // If the participant load itself throws, the catch branch should explain the
    // failure and offer a retry rather than leaving a blank panel.
    mockedGetParticipants.mockRejectedValue(new Error("indexeddb unavailable"));

    render(<TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} autoAnalyse />);

    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain("Couldn't load this transaction's data.");

    // The auto-run fired exactly once and never reached the worker.
    expect(mockedGetParticipants).toHaveBeenCalledTimes(1);
    expect(lastWorker).toBeNull();

    // No heatmap or results — and because a load failure is retryable, the
    // Retry button is offered.
    expect(screen.queryByTestId("container-boltzmann-result")).toBeNull();
    expect(screen.queryByTestId("container-boltzmann-heatmap")).toBeNull();
    expect(await screen.findByTestId("button-retry-deep-dive")).toBeTruthy();
  });
});

describe("TransactionDeepDive auto-run — the calculation itself fails", () => {
  it("shows the calculation-failure message, a Retry button, and a show/hide error-detail toggle (no heatmap) when the worker errors", async () => {
    // Participants load fine, but the Boltzmann calculation crashes inside the
    // worker (worker.onerror). The user should land on a clear failure message
    // with a retry affordance and an expandable detail — not a blank panel.
    render(<TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} autoAnalyse />);

    // The auto-run posts to the worker, then the worker reports a crash.
    await driveError("RangeError: too many interpretations");

    // The participant load still succeeded exactly once and reached the worker.
    expect(mockedGetParticipants).toHaveBeenCalledTimes(1);
    expect(lastWorker!.postMessage).toHaveBeenCalledTimes(1);

    // The calculation-failure message is shown.
    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain(
      "Couldn't analyse this transaction — the calculation failed unexpectedly.",
    );

    // A crashed calculation is retryable, so the Retry button is offered.
    expect(await screen.findByTestId("button-retry-deep-dive")).toBeTruthy();

    // The error detail is collapsed by default and expands/collapses via the toggle.
    expect(screen.queryByTestId("text-deep-dive-error-detail")).toBeNull();
    const toggle = screen.getByTestId("button-toggle-deep-dive-detail");

    act(() => {
      toggle.click();
    });
    expect(screen.getByTestId("text-deep-dive-error-detail")).toBeTruthy();

    act(() => {
      toggle.click();
    });
    expect(screen.queryByTestId("text-deep-dive-error-detail")).toBeNull();

    // The calculation never produced a result, so no heatmap or results render.
    expect(screen.queryByTestId("container-boltzmann-result")).toBeNull();
    expect(screen.queryByTestId("container-boltzmann-heatmap")).toBeNull();
  });
});
