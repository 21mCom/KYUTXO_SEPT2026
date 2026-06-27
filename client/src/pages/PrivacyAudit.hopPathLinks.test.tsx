// @vitest-environment jsdom
//
// Covers the FindingCard hop-path rendering for proximity findings. The
// privacy-audit engine records a connecting txid for each hop, and FindingCard
// renders those between consecutive addresses as a clickable transaction link
// (TxidLink) plus a deep-dive button (DeepDiveDialog). The engine side is
// unit-tested elsewhere; this verifies the component wiring:
//   - one connecting transaction link AND one deep-dive button per consecutive
//     address pair (i.e. hopPath.length - 1 of each),
//   - each link/button is wired to the correct hop txid,
//   - the fallback where hopTxids is missing/empty still renders the path
//     (the addresses) without throwing and without any tx links/buttons.
//
// TxidLink and ClickableAddress are leaf components with their own IndexedDB /
// context dependencies that are tested independently, so they are stubbed here
// to keep this focused on FindingCard's per-hop rendering logic. The stubs
// preserve the real data-testid shape (link-txid-<first8>) so the assertions
// still prove FindingCard passes the right txid to each link. DeepDiveDialog is
// the real component from PrivacyAudit (when closed it only renders its trigger
// button, data-testid button-deep-dive-<first8>).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
  act,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PrivacyFinding } from "@/lib/privacy-audit";

vi.mock("@/components/TxidLink", () => ({
  TxidLink: ({ txid }: { txid: string }) => (
    <span data-testid={`link-txid-${txid.slice(0, 8)}`}>{txid}</span>
  ),
}));

vi.mock("@/components/ClickableAddress", () => ({
  ClickableAddress: ({ address }: { address: string }) => (
    <span data-testid={`address-${address}`}>{address}</span>
  ),
}));

// Clicking a hop's deep-dive button opens DeepDiveDialog, which mounts the real
// TransactionDeepDive and auto-runs its analysis. Stub the two data loaders it
// calls (so there's no IndexedDB) and the Boltzmann Worker (so no real module
// worker is spun up under jsdom), exactly as PrivacyAudit.deepDive.test.tsx does.
vi.mock("@/lib/data/transaction-crud", () => ({
  getTransactionByTxid: vi.fn(),
}));
vi.mock("@/lib/data/record-queries", () => ({
  getParticipantsByTxids: vi.fn(),
}));

import { getTransactionByTxid } from "@/lib/data/transaction-crud";
import { getParticipantsByTxids } from "@/lib/data/record-queries";
import { FindingCard } from "./PrivacyAudit";

const mockedGetTx = vi.mocked(getTransactionByTxid);
const mockedGetParticipants = vi.mocked(getParticipantsByTxids);

// A minimal Worker stub so the deep-dive's lazy Boltzmann worker can be created
// under jsdom without loading the real module worker. A captured handle to the
// most recently constructed worker lets a test drive worker.onmessage by hand.
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

// Distinct 64-hex txids whose first 8 chars differ so every link/button gets a
// unique data-testid.
const TX = (n: number) => `${String(n).repeat(8)}${"0".repeat(56)}`;

function proximityFinding(overrides: Partial<PrivacyFinding> = {}): PrivacyFinding {
  return {
    type: "PROXIMITY",
    severity: "MEDIUM",
    description: "Funds sit close to a flagged entity.",
    details: {},
    correction: "Add a hop before spending.",
    txids: [],
    addresses: [],
    ...overrides,
  };
}

function renderCard(finding: PrivacyFinding) {
  return render(
    <TooltipProvider>
      <FindingCard finding={finding} coinjoinTxids={new Set<string>()} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("FindingCard proximity hop-path connecting transactions", () => {
  it("renders one tx link and one deep-dive button per consecutive address pair, wired to the right txid", () => {
    const hopPath = ["bc1qhopA", "bc1qhopB", "bc1qhopC", "bc1qhopD"];
    const hopTxids = [TX(1), TX(2), TX(3)]; // one per pair → 3

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));

    // The hop path lives inside the collapsed details section.
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    const container = screen.getByTestId("container-hop-path");

    // Every address in the path is rendered.
    for (const addr of hopPath) {
      expect(within(container).getByTestId(`address-${addr}`)).toBeTruthy();
    }

    // Exactly one connecting tx link AND one deep-dive button per pair.
    const pairs = hopPath.length - 1;
    expect(within(container).getAllByTestId(/^link-txid-/)).toHaveLength(pairs);
    expect(within(container).getAllByTestId(/^button-deep-dive-/)).toHaveLength(pairs);

    // Each is wired to the matching hop txid (in order).
    for (const txid of hopTxids) {
      const first8 = txid.slice(0, 8);
      expect(within(container).getByTestId(`link-txid-${first8}`)).toBeTruthy();
      expect(within(container).getByTestId(`button-deep-dive-${first8}`)).toBeTruthy();
    }
  });

  it("renders fewer links than pairs when some hop txids are absent (sparse array)", () => {
    const hopPath = ["bc1qa", "bc1qb", "bc1qc"];
    // Only the first hop has a connecting txid; the second is undefined.
    const hopTxids = [TX(7)];

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    const container = screen.getByTestId("container-hop-path");

    // Path still fully renders.
    for (const addr of hopPath) {
      expect(within(container).getByTestId(`address-${addr}`)).toBeTruthy();
    }

    // Only the hop that has a txid gets a link + deep-dive button.
    expect(within(container).getAllByTestId(/^link-txid-/)).toHaveLength(1);
    expect(within(container).getAllByTestId(/^button-deep-dive-/)).toHaveLength(1);
    expect(within(container).getByTestId(`link-txid-${TX(7).slice(0, 8)}`)).toBeTruthy();
  });

  it("renders the hop path without any tx links when hopTxids is missing entirely", () => {
    const hopPath = ["bc1qx", "bc1qy", "bc1qz"];

    // No hopTxids key at all — fallback arrows are shown instead.
    expect(() =>
      renderCard(proximityFinding({ details: { hopPath } })),
    ).not.toThrow();

    fireEvent.click(screen.getByTestId("button-toggle-details"));

    const container = screen.getByTestId("container-hop-path");

    // Addresses still render…
    for (const addr of hopPath) {
      expect(within(container).getByTestId(`address-${addr}`)).toBeTruthy();
    }

    // …but no connecting transaction links or deep-dive buttons appear.
    expect(within(container).queryAllByTestId(/^link-txid-/)).toHaveLength(0);
    expect(within(container).queryAllByTestId(/^button-deep-dive-/)).toHaveLength(0);
  });

  it("does not render a hop-path section for a single-address path", () => {
    renderCard(proximityFinding({ details: { hopPath: ["bc1qonly"], hopTxids: [] } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    expect(screen.queryByTestId("container-hop-path")).toBeNull();
  });
});

// Rendering the per-hop deep-dive button proves it's present, but the most useful
// user action — clicking it to open the transaction deep-dive — was previously
// untested. This drives the real DeepDiveDialog: clicking a hop's button must
// open the deep-dive dialog (data-testid dialog-deep-dive) for that hop's txid.
describe("FindingCard proximity hop-path deep-dive interaction", () => {
  beforeEach(() => {
    // The dialog auto-runs analysis on open; resolve the loaders and provide a
    // Worker so nothing throws while we assert the dialog itself opened.
    lastWorker = null;
    mockedGetTx.mockResolvedValue({ txid: TX(2), fee: 1_000 } as any);
    mockedGetParticipants.mockResolvedValue([
      { txid: TX(2), role: "input", address: "bc1qin", amount: 100_000, vout: 0 },
      { txid: TX(2), role: "output", address: "bc1qout", amount: 99_000, vout: 0 },
    ] as any);
    vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("opens the deep-dive dialog for the clicked hop's txid", async () => {
    const hopPath = ["bc1qhopA", "bc1qhopB", "bc1qhopC"];
    const hopTxids = [TX(1), TX(2)]; // one per pair → 2

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    // The dialog is closed initially — only the per-hop trigger buttons exist.
    expect(screen.queryByTestId("dialog-deep-dive")).toBeNull();

    // Click the second hop's deep-dive button.
    const second8 = TX(2).slice(0, 8);
    fireEvent.click(screen.getByTestId(`button-deep-dive-${second8}`));

    // The deep-dive dialog opens, scoped to that hop's txid.
    const dialog = await screen.findByTestId("dialog-deep-dive");
    expect(within(dialog).getByText(TX(2))).toBeTruthy();

    // It auto-analyses the clicked txid (and only that one).
    await waitFor(() => {
      expect(mockedGetTx).toHaveBeenCalledWith(TX(2));
    });
    expect(mockedGetTx).not.toHaveBeenCalledWith(TX(1));
  });

  it("renders the deep-dive results once the worker returns for the clicked hop's txid", async () => {
    const hopPath = ["bc1qhopA", "bc1qhopB", "bc1qhopC"];
    const hopTxids = [TX(1), TX(2)]; // one per pair → 2

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    // Open the deep-dive for the second hop's txid.
    const second8 = TX(2).slice(0, 8);
    fireEvent.click(screen.getByTestId(`button-deep-dive-${second8}`));

    const dialog = await screen.findByTestId("dialog-deep-dive");
    expect(within(dialog).getByText(TX(2))).toBeTruthy();

    // The dialog auto-runs analysis: data loads and the worker is posted to.
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Drive a valid worker result back using the id from the latest postMessage
    // so the handler's pendingIdRef guard accepts it.
    const calls = lastWorker!.postMessage.mock.calls;
    const { id } = calls[calls.length - 1][0] as { id: string };
    act(() => {
      lastWorker!.onmessage!({
        data: { id, result: { tooComplex: true } },
      } as MessageEvent);
    });

    // The user actually sees results inside the dialog: both the summary and the
    // Boltzmann result render for the clicked hop's txid.
    const summary = await within(dialog).findByTestId("container-deep-dive-summary");
    expect(summary).toBeTruthy();
    expect(within(dialog).getByTestId("container-boltzmann-result")).toBeTruthy();

    // The summary reflects the loaded participants (1 input, 1 output).
    expect(within(dialog).getByTestId("text-deep-dive-inputs").textContent).toBe("1");
    expect(within(dialog).getByTestId("text-deep-dive-outputs").textContent).toBe("1");
  });

  it("renders the numeric Boltzmann figures when the worker returns a full result for the clicked hop", async () => {
    const hopPath = ["bc1qhopA", "bc1qhopB", "bc1qhopC"];
    const hopTxids = [TX(1), TX(2)]; // one per pair → 2

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    // Open the deep-dive for the second hop's txid.
    const second8 = TX(2).slice(0, 8);
    fireEvent.click(screen.getByTestId(`button-deep-dive-${second8}`));

    const dialog = await screen.findByTestId("dialog-deep-dive");
    expect(within(dialog).getByText(TX(2))).toBeTruthy();

    // The dialog auto-runs analysis: data loads and the worker is posted to.
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Drive a full (non-tooComplex) result back, mirroring a normal transaction:
    // entropy 2 bits, 4 interpretations, efficiency 0.5 against maxEntropy 4.
    const calls = lastWorker!.postMessage.mock.calls;
    const { id } = calls[calls.length - 1][0] as { id: string };
    act(() => {
      lastWorker!.onmessage!({
        data: {
          id,
          result: {
            entropy: 2,
            entropyLabel: "Low",
            interpretationCount: 4,
            tooComplex: false,
            linkMatrix: [],
            efficiency: 0.5,
            maxEntropy: 4,
          },
        },
      } as MessageEvent);
    });

    // The user sees the actual privacy numbers (not the "too complex" notice):
    // entropy, interpretation count and efficiency for the clicked hop's txid.
    const boltzmann = await within(dialog).findByTestId("container-boltzmann-result");
    expect(within(boltzmann).getByTestId("text-boltzmann-entropy").textContent).toBe(
      "2.00 bits",
    );
    expect(
      within(boltzmann).getByTestId("text-boltzmann-interpretations").textContent,
    ).toBe("4");
    expect(within(boltzmann).getByTestId("text-boltzmann-efficiency").textContent).toBe(
      "50%",
    );
  });

  it("shows a dash (not a fake 0%) for efficiency when the transaction can't be meaningfully scored", async () => {
    const hopPath = ["bc1qhopA", "bc1qhopB", "bc1qhopC"];
    const hopTxids = [TX(1), TX(2)]; // one per pair → 2

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    // Open the deep-dive for the second hop's txid.
    const second8 = TX(2).slice(0, 8);
    fireEvent.click(screen.getByTestId(`button-deep-dive-${second8}`));

    const dialog = await screen.findByTestId("dialog-deep-dive");
    expect(within(dialog).getByText(TX(2))).toBeTruthy();

    // The dialog auto-runs analysis: data loads and the worker is posted to.
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Drive a full result whose maxEntropy is 0 — a transaction that can't be
    // meaningfully scored. Efficiency is 0 too, but the UI must NOT print "0%"
    // (which would falsely imply the worst possible privacy); it shows "—".
    const calls = lastWorker!.postMessage.mock.calls;
    const { id } = calls[calls.length - 1][0] as { id: string };
    act(() => {
      lastWorker!.onmessage!({
        data: {
          id,
          result: {
            entropy: 0,
            entropyLabel: "None",
            interpretationCount: 1,
            tooComplex: false,
            linkMatrix: [],
            efficiency: 0,
            maxEntropy: 0,
          },
        },
      } as MessageEvent);
    });

    // Entropy and interpretation count still render their figures…
    const boltzmann = await within(dialog).findByTestId("container-boltzmann-result");
    expect(within(boltzmann).getByTestId("text-boltzmann-entropy").textContent).toBe(
      "0.00 bits",
    );
    expect(
      within(boltzmann).getByTestId("text-boltzmann-interpretations").textContent,
    ).toBe("1");

    // …but efficiency shows a dash rather than a misleading 0%.
    const efficiency = within(boltzmann).getByTestId("text-boltzmann-efficiency");
    expect(efficiency.textContent).toBe("—");
    expect(efficiency.textContent).not.toBe("0%");
  });

  it("surfaces a visible error and Retry affordance (not a stuck loading state) when the worker errors", async () => {
    const hopPath = ["bc1qhopA", "bc1qhopB", "bc1qhopC"];
    const hopTxids = [TX(1), TX(2)]; // one per pair → 2

    renderCard(proximityFinding({ details: { hopPath, hopTxids } }));
    fireEvent.click(screen.getByTestId("button-toggle-details"));

    // Open the deep-dive for the second hop's txid.
    const second8 = TX(2).slice(0, 8);
    fireEvent.click(screen.getByTestId(`button-deep-dive-${second8}`));

    const dialog = await screen.findByTestId("dialog-deep-dive");
    expect(within(dialog).getByText(TX(2))).toBeTruthy();

    // The dialog auto-runs analysis: data loads and the worker is posted to.
    await waitFor(() => {
      expect(lastWorker).not.toBeNull();
      expect(lastWorker!.postMessage).toHaveBeenCalled();
    });

    // Drive the worker's failure path instead of onmessage — the calculation
    // crashed (e.g. the worker threw and reported via onerror).
    act(() => {
      lastWorker!.onerror!({ message: "Boltzmann worker crashed: out of memory" });
    });

    // The user sees a clear error notice rather than an empty/hung dialog…
    const message = await within(dialog).findByTestId("text-deep-dive-message");
    expect(message.textContent).toMatch(/couldn't analyse this transaction/i);

    // …and is offered a Retry affordance to try again.
    expect(within(dialog).getByTestId("button-retry-deep-dive")).toBeTruthy();

    // The dialog is no longer stuck loading: neither the inline loading status
    // nor the spinning Analyse button remain, and no results were rendered.
    expect(within(dialog).queryByTestId("status-deep-dive-loading")).toBeNull();
    expect(within(dialog).queryByTestId("container-boltzmann-result")).toBeNull();
  });
});
