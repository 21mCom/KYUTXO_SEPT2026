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
});
