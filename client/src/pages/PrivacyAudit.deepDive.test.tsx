// @vitest-environment jsdom
//
// Error-handling coverage for the Transaction Deep-Dive (Task: "Test the
// deep-dive failure message, details, and retry flow").
//
// The TransactionDeepDive panel surfaces three things on failure, none of which
// were covered by tests before:
//   1. A friendly message plus a collapsible "Show details" that reveals only
//      the condensed first line of the underlying error (never a multi-line
//      stack trace).
//   2. A next-steps hint (data-testid="text-deep-dive-next-steps") that only
//      appears after 2+ consecutive failures.
//   3. A Retry button that re-runs analyse().
//
// We exercise the real component. The two data loaders it calls
// (getTransactionByTxid / getParticipantsByTxids) are mocked so we can make them
// throw, and the Boltzmann Worker is stubbed so we can drive worker.onerror by
// hand.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";

// PrivacyAudit only ever imports these single functions from these modules, so a
// full mock is safe and keeps the import cheap (no IndexedDB).
vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionByTxid: vi.fn(),
}));
vi.mock("@/lib/data/record-queries", () => ({
  getParticipantsByTxids: vi.fn(),
}));

// Radix Select doesn't open under jsdom (it relies on real pointer-capture and
// layout), so swap it for a minimal native <select> that wires value /
// onValueChange the same way. The single-txid tests never render the Select, so
// this only affects the multi-txid switching test below.
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
import { getParticipantsByTxids } from "@/lib/data/record-queries";
import { TransactionDeepDive } from "./PrivacyAudit";

const TXID = "f".repeat(64);

const MULTI_LINE_ERROR =
  "QuotaExceededError: the database is full\n" +
  "    at getTransactionByTxid (transaction-crud.ts:42:11)\n" +
  "    at analyse (PrivacyAudit.tsx:397:18)\n" +
  "    at HTMLButtonElement.onClick";

// A captured handle to the most recently constructed mock Worker so a test can
// drive worker.onerror directly.
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

function validParticipants() {
  return [
    { txid: TXID, role: "input", address: "bc1qinput", amount: 100_000, vout: 0 },
    { txid: TXID, role: "output", address: "bc1qoutput", amount: 99_000, vout: 0 },
  ] as any;
}

function renderDeepDive() {
  return render(
    <TransactionDeepDive txids={[TXID]} coinjoinTxids={new Set<string>()} />,
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

describe("TransactionDeepDive failure handling", () => {
  it("shows a friendly message and reveals only the condensed first line of a data-load error", async () => {
    mockedGetTx.mockRejectedValue(new Error(MULTI_LINE_ERROR));

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    // Friendly, non-leaky message.
    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain("Couldn't load this transaction's data.");

    // Detail is collapsed by default.
    expect(screen.queryByTestId("text-deep-dive-error-detail")).toBeNull();

    // Toggle reveals it.
    const toggle = screen.getByTestId("button-toggle-deep-dive-detail");
    expect(toggle.textContent).toContain("Show details");
    fireEvent.click(toggle);

    const detail = await screen.findByTestId("text-deep-dive-error-detail");
    // Only the first line — no stack frames, no newlines.
    expect(detail.textContent).toContain("QuotaExceededError: the database is full");
    expect(detail.textContent).not.toContain("at getTransactionByTxid");
    expect(detail.textContent).not.toContain("\n");
    expect(toggle.textContent).toContain("Hide details");

    // Toggling again hides it.
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.queryByTestId("text-deep-dive-error-detail")).toBeNull();
    });
  });

  it("surfaces the same condensed message/detail when the Boltzmann worker errors", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(validParticipants());

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    // Wait until data has loaded and the worker has been created + posted to.
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Drive the worker error path with a multi-line message.
    act(() => {
      lastWorker!.onerror!({ message: MULTI_LINE_ERROR });
    });

    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain(
      "Couldn't analyse this transaction — the calculation failed unexpectedly.",
    );

    fireEvent.click(screen.getByTestId("button-toggle-deep-dive-detail"));
    const detail = await screen.findByTestId("text-deep-dive-error-detail");
    expect(detail.textContent).toContain("QuotaExceededError: the database is full");
    expect(detail.textContent).not.toContain("at getTransactionByTxid");
    expect(detail.textContent).not.toContain("\n");
  });

  it("shows the next-steps hint only after 2+ consecutive failures", async () => {
    mockedGetTx.mockRejectedValue(new Error("boom"));

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    // First failure: message + retry, but no hint yet.
    await screen.findByTestId("text-deep-dive-message");
    expect(screen.queryByTestId("text-deep-dive-next-steps")).toBeNull();

    // Second failure via Retry.
    fireEvent.click(screen.getByTestId("button-retry-deep-dive"));

    await waitFor(() => {
      expect(screen.getByTestId("text-deep-dive-next-steps")).toBeTruthy();
    });
  });

  it("re-runs analyse() when Retry is clicked", async () => {
    mockedGetTx.mockRejectedValue(new Error("boom"));

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await screen.findByTestId("button-retry-deep-dive");
    expect(mockedGetTx).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("button-retry-deep-dive"));

    await waitFor(() => {
      expect(mockedGetTx).toHaveBeenCalledTimes(2);
    });
  });

  it("fully clears the prior error state once a retry succeeds", async () => {
    // First analyse fails on the data load, every later call succeeds. We make
    // the first attempt fail twice (analyse + one Retry) so the next-steps hint
    // is on screen, then let the third attempt succeed — proving the success
    // path wipes the error message, the hint and the Retry button.
    mockedGetTx
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(validParticipants());

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    // First failure: message + retry, no hint yet.
    await screen.findByTestId("button-retry-deep-dive");
    expect(screen.queryByTestId("text-deep-dive-next-steps")).toBeNull();

    // Second failure surfaces the next-steps hint.
    fireEvent.click(screen.getByTestId("button-retry-deep-dive"));
    await screen.findByTestId("text-deep-dive-next-steps");

    // Third attempt succeeds: data loads and the worker is posted to.
    fireEvent.click(screen.getByTestId("button-retry-deep-dive"));
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Drive a valid worker result back using the id from the latest postMessage.
    const calls = lastWorker!.postMessage.mock.calls;
    const { id } = calls[calls.length - 1][0] as { id: string };
    act(() => {
      lastWorker!.onmessage!({
        data: { id, result: { tooComplex: true } },
      } as MessageEvent);
    });

    // Results render…
    await screen.findByTestId("container-boltzmann-result");
    expect(screen.getByTestId("container-deep-dive-summary")).toBeTruthy();

    // …and every trace of the prior error is gone.
    expect(screen.queryByTestId("text-deep-dive-message")).toBeNull();
    expect(screen.queryByTestId("text-deep-dive-next-steps")).toBeNull();
    expect(screen.queryByTestId("button-retry-deep-dive")).toBeNull();
  });

  it("hides the first tx's successful results when a different tx is selected, until it is re-analysed", async () => {
    // Success-then-switch: analyse the first transaction successfully (its
    // summary + Boltzmann result render), then pick a *different* transaction
    // from the dropdown. The stale results must disappear immediately — a user
    // must never read one tx's privacy numbers while a different txid is
    // selected — and only the newly analysed tx's results may appear.
    const TXID2 = "a".repeat(64);

    // First tx resolves with its own participants; second tx with its own.
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants
      .mockResolvedValueOnce([
        { txid: TXID, role: "input", address: "bc1qin1", amount: 100_000, vout: 0 },
        { txid: TXID, role: "output", address: "bc1qout1", amount: 99_000, vout: 0 },
      ] as any)
      .mockResolvedValue([
        { txid: TXID2, role: "input", address: "bc1qin2", amount: 200_000, vout: 0 },
        { txid: TXID2, role: "output", address: "bc1qout2", amount: 199_000, vout: 0 },
      ] as any);

    render(
      <TransactionDeepDive
        txids={[TXID, TXID2]}
        coinjoinTxids={new Set<string>()}
      />,
    );

    // Analyse the first transaction successfully.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });
    const firstCallCount = lastWorker!.postMessage.mock.calls.length;
    const firstId = (
      lastWorker!.postMessage.mock.calls[firstCallCount - 1][0] as { id: string }
    ).id;
    act(() => {
      lastWorker!.onmessage!({
        data: { id: firstId, result: { tooComplex: true } },
      } as MessageEvent);
    });

    // First tx's results are on screen.
    await screen.findByTestId("container-boltzmann-result");
    expect(screen.getByTestId("container-deep-dive-summary")).toBeTruthy();

    // Switch to a different transaction.
    fireEvent.change(screen.getByTestId("select-deep-dive-txid"), {
      target: { value: TXID2 },
    });

    // The first tx's stale results must be gone immediately — before the new
    // tx has been analysed.
    await waitFor(() => {
      expect(screen.queryByTestId("container-boltzmann-result")).toBeNull();
    });
    expect(screen.queryByTestId("container-deep-dive-summary")).toBeNull();

    // Analyse the second transaction successfully.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await waitFor(() => {
      expect(lastWorker!.postMessage.mock.calls.length).toBeGreaterThan(
        firstCallCount,
      );
    });
    const secondCalls = lastWorker!.postMessage.mock.calls;
    const secondId = (secondCalls[secondCalls.length - 1][0] as { id: string }).id;
    act(() => {
      lastWorker!.onmessage!({
        data: { id: secondId, result: { tooComplex: true } },
      } as MessageEvent);
    });

    // The second tx's results now render.
    await screen.findByTestId("container-boltzmann-result");
    expect(screen.getByTestId("container-deep-dive-summary")).toBeTruthy();
  });

  it("clears a prior transaction's error when a different tx is selected and analysed successfully", async () => {
    // Multi-tx mode: the first transaction's analysis fails (twice, so the
    // next-steps hint is on screen), then the user picks a *different*
    // transaction from the dropdown and analyses it successfully. The success
    // path must wipe the first tx's stale error UI — message, next-steps hint
    // and Retry button — and never leave one tx's error showing over another's
    // results.
    const TXID2 = "a".repeat(64);

    // The first two calls (for the first tx: analyse + Retry) fail; every call
    // after that (the second tx) succeeds.
    mockedGetTx
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ txid: TXID2, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue([
      { txid: TXID2, role: "input", address: "bc1qinput", amount: 100_000, vout: 0 },
      { txid: TXID2, role: "output", address: "bc1qoutput", amount: 99_000, vout: 0 },
    ] as any);

    render(
      <TransactionDeepDive
        txids={[TXID, TXID2]}
        coinjoinTxids={new Set<string>()}
      />,
    );

    // First tx fails, then fails again via Retry → the next-steps hint appears,
    // so we have the full error UI (message + hint + Retry) on screen.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await screen.findByTestId("button-retry-deep-dive");
    fireEvent.click(screen.getByTestId("button-retry-deep-dive"));
    await screen.findByTestId("text-deep-dive-next-steps");
    expect(screen.getByTestId("text-deep-dive-message")).toBeTruthy();

    // Switch to a different transaction…
    fireEvent.change(screen.getByTestId("select-deep-dive-txid"), {
      target: { value: TXID2 },
    });

    // …and analyse it. This succeeds: data loads and the worker is posted to.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Drive a valid worker result back for the latest analysis.
    const calls = lastWorker!.postMessage.mock.calls;
    const { id } = calls[calls.length - 1][0] as { id: string };
    act(() => {
      lastWorker!.onmessage!({
        data: { id, result: { tooComplex: true } },
      } as MessageEvent);
    });

    // The second tx's results render…
    await screen.findByTestId("container-boltzmann-result");
    expect(screen.getByTestId("container-deep-dive-summary")).toBeTruthy();

    // …and none of the first tx's error UI lingers.
    expect(screen.queryByTestId("text-deep-dive-message")).toBeNull();
    expect(screen.queryByTestId("text-deep-dive-next-steps")).toBeNull();
    expect(screen.queryByTestId("button-retry-deep-dive")).toBeNull();
  });
});

// The worker.onmessage handler guards against out-of-order results: a slow
// first analysis can deliver its result after the user has already kicked off a
// second one. The handler compares e.data.id to pendingIdRef.current and bails
// when they differ, so a stale result must never overwrite the current one.
//
// The Analyse button is disabled while an analysis is loading, so a second
// analysis can't be started by clicking it again mid-flight. The reachable way
// to have a *first* analysis still in flight (its id posted) while a *second*
// one has started is the error→Retry path: the first analysis posts to the
// reused worker, that worker reports an error (which re-enables the UI), the
// user hits Retry to start a second analysis (a new id), and only then does the
// first analysis's queued result straggle back from the still-alive, reused
// worker. The guard must drop that stale result.
describe("TransactionDeepDive stale-result guard", () => {
  it("ignores a stale worker result delivered after a newer analysis started", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(validParticipants());

    renderDeepDive();

    // First analysis: load data and post to the worker, capturing its id (#1).
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalledTimes(1);
    });
    const firstId = (lastWorker!.postMessage.mock.calls[0][0] as { id: string })
      .id;

    // The first analysis's worker errors — this re-enables the UI (Retry) while
    // leaving the first id's result still pending from the reused worker.
    act(() => {
      lastWorker!.onerror!({ message: "transient worker hiccup" } as any);
    });
    await screen.findByTestId("button-retry-deep-dive");

    // Second analysis via Retry on the SAME (reused) worker. Capture its id
    // (#2); pendingIdRef.current is now this newer id.
    fireEvent.click(screen.getByTestId("button-retry-deep-dive"));
    await waitFor(() => {
      expect(lastWorker!.postMessage).toHaveBeenCalledTimes(2);
    });
    const secondId = (lastWorker!.postMessage.mock.calls[1][0] as { id: string })
      .id;
    expect(secondId).not.toBe(firstId);

    // The FIRST analysis's result finally straggles back. Its id no longer
    // matches pendingIdRef.current, so the guard must ignore it — nothing renders.
    act(() => {
      lastWorker!.onmessage!({
        data: { id: firstId, result: { tooComplex: true } },
      } as MessageEvent);
    });
    await Promise.resolve();
    expect(screen.queryByTestId("container-boltzmann-result")).toBeNull();

    // The SECOND (current) analysis's result does render.
    act(() => {
      lastWorker!.onmessage!({
        data: { id: secondId, result: { tooComplex: true } },
      } as MessageEvent);
    });
    await screen.findByTestId("container-boltzmann-result");
  });
});

// A transaction can load successfully yet have no participant rows (e.g. the
// address was never synced). That is a legitimate, non-error outcome: the panel
// shows an informational message but must NOT treat it like a failure — so no
// Retry button, no error-detail toggle, and it must never count toward the
// consecutive-failure next-steps hint.
describe("TransactionDeepDive empty-participants handling", () => {
  function inputOnlyParticipants() {
    return [
      { txid: TXID, role: "input", address: "bc1qinput", amount: 100_000, vout: 0 },
    ] as any;
  }

  function outputOnlyParticipants() {
    return [
      { txid: TXID, role: "output", address: "bc1qoutput", amount: 99_000, vout: 0 },
    ] as any;
  }

  async function assertInformationalOnly() {
    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain(
      "No participant data available for this transaction",
    );

    // This is informational, not a failure: none of the failure affordances
    // should appear.
    expect(screen.queryByTestId("button-retry-deep-dive")).toBeNull();
    expect(screen.queryByTestId("button-toggle-deep-dive-detail")).toBeNull();
    expect(screen.queryByTestId("text-deep-dive-next-steps")).toBeNull();

    // It must also never spin up the Boltzmann worker for an empty result.
    expect(lastWorker).toBeNull();
  }

  it("shows an informational message (no failure affordances) when there are no participants", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue([] as any);

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await assertInformationalOnly();
  });

  it("treats inputs-only the same as empty (informational, no failure affordances)", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(inputOnlyParticipants());

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await assertInformationalOnly();
  });

  it("treats outputs-only the same as empty (informational, no failure affordances)", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(outputOnlyParticipants());

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));

    await assertInformationalOnly();
  });

  it("does not show the next-steps hint even after repeated empty results", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue([] as any);

    renderDeepDive();
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await screen.findByTestId("text-deep-dive-message");

    // Run it again — an empty result must never accumulate failCount, so the
    // 2+ consecutive-failure hint must stay hidden.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await screen.findByTestId("text-deep-dive-message");

    expect(screen.queryByTestId("text-deep-dive-next-steps")).toBeNull();
    expect(screen.queryByTestId("button-retry-deep-dive")).toBeNull();
  });

  it("clears a prior empty-result message once a different tx analyses successfully", async () => {
    // The first transaction loads but has no participants, so the informational
    // "No participant data available" message is shown (no worker spun up). The
    // user then picks a *different* transaction with valid participants and
    // analyses it successfully. The success path must wipe the stale empty
    // message and never leave it lingering alongside valid results.
    const TXID2 = "a".repeat(64);

    mockedGetTx
      .mockResolvedValueOnce({ txid: TXID, fee: 1_000 } as any)
      .mockResolvedValue({ txid: TXID2, fee: 1_000 } as any);
    mockedGetParticipants
      .mockResolvedValueOnce([] as any)
      .mockResolvedValue([
        { txid: TXID2, role: "input", address: "bc1qinput", amount: 100_000, vout: 0 },
        { txid: TXID2, role: "output", address: "bc1qoutput", amount: 99_000, vout: 0 },
      ] as any);

    render(
      <TransactionDeepDive
        txids={[TXID, TXID2]}
        coinjoinTxids={new Set<string>()}
      />,
    );

    // First tx: empty participants → informational message, no worker.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    const message = await screen.findByTestId("text-deep-dive-message");
    expect(message.textContent).toContain(
      "No participant data available for this transaction",
    );
    expect(lastWorker).toBeNull();

    // Switch to a different transaction…
    fireEvent.change(screen.getByTestId("select-deep-dive-txid"), {
      target: { value: TXID2 },
    });

    // …and analyse it. This succeeds: data loads and the worker is posted to.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Drive a valid worker result back for the latest analysis.
    const calls = lastWorker!.postMessage.mock.calls;
    const { id } = calls[calls.length - 1][0] as { id: string };
    act(() => {
      lastWorker!.onmessage!({
        data: { id, result: { tooComplex: true } },
      } as MessageEvent);
    });

    // The second tx's results render…
    await screen.findByTestId("container-boltzmann-result");
    expect(screen.getByTestId("container-deep-dive-summary")).toBeTruthy();

    // …and the stale empty-result message is gone.
    expect(screen.queryByTestId("text-deep-dive-message")).toBeNull();
  });
});

// The deep-dive spins up a dedicated Boltzmann worker lazily on first analyse
// and reuses it. It must be torn down when the panel unmounts (closed/navigated
// away), otherwise the worker leaks and can keep delivering late messages to a
// component that no longer exists.
describe("TransactionDeepDive worker teardown", () => {
  it("terminates the worker when the component unmounts", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(validParticipants());

    const { unmount } = renderDeepDive();

    // Run an analysis so the worker is actually created.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    expect(lastWorker!.terminate).not.toHaveBeenCalled();

    // Closing/navigating away unmounts the panel → the worker must be torn down.
    unmount();
    expect(lastWorker!.terminate).toHaveBeenCalledTimes(1);
  });
});

// The worker is created lazily on first analyse and reused, but it must not be
// held forever on a long-lived panel that has gone idle. After an analysis
// settles (a result delivered or an error), the worker is released once it has
// sat idle for WORKER_IDLE_TEARDOWN_MS (30s). A new analysis transparently
// recreates it via the existing lazy-create path.
describe("TransactionDeepDive worker idle teardown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminates the worker after it sits idle following a delivered result", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(validParticipants());

    renderDeepDive();

    // Run an analysis so the worker is created and posted to.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await vi.waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Deliver a result. The worker must NOT be torn down immediately — it stays
    // warm for a follow-up analysis within the idle window.
    const { id } = lastWorker!.postMessage.mock.calls[0][0] as { id: string };
    act(() => {
      lastWorker!.onmessage!({
        data: { id, result: { tooComplex: true } },
      } as MessageEvent);
    });
    expect(lastWorker!.terminate).not.toHaveBeenCalled();

    // Once the idle window elapses with nothing running, the worker is released.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(lastWorker!.terminate).toHaveBeenCalledTimes(1);
  });

  it("releases the worker after it sits idle following an error", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(validParticipants());

    renderDeepDive();

    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await vi.waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // The worker errors. It must not be torn down right away (Retry reuses it),
    // but once idle past the window it is released.
    act(() => {
      lastWorker!.onerror!({ message: "transient worker hiccup" } as any);
    });
    expect(lastWorker!.terminate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(lastWorker!.terminate).toHaveBeenCalledTimes(1);
  });

  it("a new analysis cancels a pending idle teardown and reuses the worker", async () => {
    mockedGetTx.mockResolvedValue({ txid: TXID, fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue(validParticipants());

    renderDeepDive();

    // First analysis → result delivered → idle teardown scheduled.
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await vi.waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalledTimes(1);
    });
    const firstWorker = lastWorker!;
    const { id } = firstWorker.postMessage.mock.calls[0][0] as { id: string };
    act(() => {
      firstWorker.onmessage!({
        data: { id, result: { tooComplex: true } },
      } as MessageEvent);
    });

    // Before the idle window elapses, start a second analysis. The pending
    // teardown must be cancelled and the SAME worker reused (no new Worker
    // constructed, no terminate).
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    fireEvent.click(screen.getByTestId("button-analyse-deep-dive"));
    await vi.waitFor(() => {
      expect(firstWorker.postMessage).toHaveBeenCalledTimes(2);
    });
    expect(lastWorker).toBe(firstWorker);
    expect(firstWorker.terminate).not.toHaveBeenCalled();

    // The original idle window would have fired by now had it not been cancelled.
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(firstWorker.terminate).not.toHaveBeenCalled();
  });
});
