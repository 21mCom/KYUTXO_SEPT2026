// @vitest-environment jsdom
//
// Worker-error branch coverage for the Transaction Deep-Dive (Task: "Catch a
// broken deep-dive worker before users see a silent spinner").
//
// The Boltzmann analysis runs in a Web Worker built from a Vite worker URL
// (new URL('../../lib/boltzmann.worker.ts', import.meta.url)). If a bundling
// regression breaks the worker, the browser fires worker.onerror — the panel
// must surface a message + "Show details" + Retry instead of a silent spinner,
// and after two consecutive worker failures a next-steps hint. Nothing else
// exercises Retry → second worker failure → hint through the WORKER path
// (PrivacyAudit.deepDive.test.tsx drives repeated failures through the data
// loaders only), so a regression there would ship unseen.
//
// We import the component directly from its own module (not the PrivacyAudit
// barrel) so this test keeps working against the real file.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";

// The component only imports these two loaders from transaction-crud, so a full
// mock is safe and avoids touching IndexedDB.
vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionByTxid: vi.fn(),
  getParticipantsByTxids: vi.fn(),
}));

import {
  getTransactionByTxid,
  getParticipantsByTxids,
} from "@/lib/data/transaction-crud";
import { TransactionDeepDive } from "./transaction-deep-dive";

const TXID = "e".repeat(64);

// Captured handle to the most recently constructed mock Worker so tests can
// fire onerror by hand, simulating a broken worker bundle.
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

beforeEach(() => {
  lastWorker = null;
  vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  // Data loading always succeeds — every failure in this file comes from the
  // worker itself, which is exactly the branch a bundling regression hits.
  mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
  mockedGetParticipants.mockResolvedValue([
    { txid: TXID, role: "input", address: "bc1qinput", amount: 100_000, vout: 0 },
    { txid: TXID, role: "output", address: "bc1qoutput", amount: 99_000, vout: 0 },
  ] as any);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function analyseAndFailWorker(message = "Failed to fetch dynamically imported module") {
  await waitFor(() => {
    expect(lastWorker).not.toBeNull();
    expect(lastWorker!.postMessage).toHaveBeenCalled();
  });
  act(() => {
    lastWorker!.onerror!({ message });
  });
}

describe("TransactionDeepDive worker-error branch", () => {
  it("shows message, Show details toggle and Retry when the worker errors — never a stuck spinner", async () => {
    render(
      <TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} />,
    );

    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await analyseAndFailWorker(
      "Failed to fetch dynamically imported module\n    at boltzmann.worker.ts",
    );

    // The three recovery affordances all render.
    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain(
      "Couldn't analyse this transaction — the calculation failed unexpectedly.",
    );
    expect(screen.getByTestId("button-toggle-deep-dive-detail")).toBeTruthy();
    expect(screen.getByTestId("button-retry-deep-dive")).toBeTruthy();

    // The loading spinner is gone — the Analyse button is re-enabled.
    expect(
      (screen.getByTestId("button-analyse-deep-dive") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // The detail toggle reveals only the condensed first line.
    fireEvent.click(screen.getByTestId("button-toggle-deep-dive-detail"));
    const detail = await screen.findByTestId("text-deep-dive-error-detail");
    expect(detail.textContent).toContain(
      "Failed to fetch dynamically imported module",
    );
    expect(detail.textContent).not.toContain("boltzmann.worker.ts");

    // No hint after a single failure.
    expect(screen.queryByTestId("text-deep-dive-next-steps")).toBeNull();
  });

  it("Retry re-runs the analysis (reloads data and posts to the worker again)", async () => {
    render(
      <TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} />,
    );

    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await analyseAndFailWorker();

    await screen.findByTestId("button-retry-deep-dive");
    expect(mockedGetTx).toHaveBeenCalledTimes(1);
    const postsBefore = lastWorker!.postMessage.mock.calls.length;

    fireEvent.click(screen.getByTestId("button-retry-deep-dive"));

    await waitFor(() => {
      expect(mockedGetTx).toHaveBeenCalledTimes(2);
      expect(lastWorker!.postMessage.mock.calls.length).toBeGreaterThan(
        postsBefore,
      );
    });
  });

  it("shows the next-steps hint after a second consecutive worker failure", async () => {
    render(
      <TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} />,
    );

    // First worker failure — no hint yet.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await analyseAndFailWorker();
    await screen.findByTestId("button-retry-deep-dive");
    expect(screen.queryByTestId("text-deep-dive-next-steps")).toBeNull();

    // Retry, and the worker fails again.
    const postsBefore = lastWorker!.postMessage.mock.calls.length;
    fireEvent.click(screen.getByTestId("button-retry-deep-dive"));
    await waitFor(() => {
      expect(lastWorker!.postMessage.mock.calls.length).toBeGreaterThan(
        postsBefore,
      );
    });
    act(() => {
      lastWorker!.onerror!({ message: "worker crashed again" });
    });

    // The repeated-failure hint appears alongside the message.
    await waitFor(() => {
      expect(screen.getByTestId("text-deep-dive-next-steps")).toBeTruthy();
    });
    expect(screen.getByTestId("text-deep-dive-message")).toBeTruthy();
    expect(screen.getByTestId("button-retry-deep-dive")).toBeTruthy();
  });
});
