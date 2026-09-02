// @vitest-environment jsdom
//
// The txid copy buttons show a green confirmation check + success toast when
// navigator.clipboard.writeText resolves, and a destructive "Copy failed"
// toast WITHOUT the confirmation check when it rejects. This guards that
// contract across the three txid copy entry points:
//   - TxidLink                              (shared inline txid link)
//   - RecordDetailPanel TransactionHistory  (expanded tx-history row)
//   - UTXOs CopyTxidButton                  (UTXO row copy button)
// Each component pulls in IndexedDB-backed CRUD / context modules at import
// time, so we stub those to keep the render cheap, deterministic, and isolated
// to the copy-button confirmation wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/lib/data/record-crud", () => ({ getRecordsByInputString: vi.fn() }));

const { openRecordPreview, openRecordPreviewByAddress } = vi.hoisted(() => ({
  openRecordPreview: vi.fn(() => Promise.resolve()),
  openRecordPreviewByAddress: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({ openRecordPreview, openRecordPreviewByAddress }),
}));

const TXID = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

// RecordDetailPanel's TransactionHistorySection reads tx history through
// dataFacade. Provide a single output participant so exactly one tx-history
// row (with a copy button) renders.
const { getParticipantsByAddress, getTransactionsByTxids, getParticipantsByTxid } =
  vi.hoisted(() => ({
    getParticipantsByAddress: vi.fn(),
    getTransactionsByTxids: vi.fn(),
    getParticipantsByTxid: vi.fn(),
  }));
vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByAddress,
  getTransactionsByTxids,
  getParticipantsByTxid,
  getRecordOrigins: vi.fn().mockResolvedValue([]),
  getParticipantsByTxids: vi.fn().mockResolvedValue([]),
  getTransactionByTxid: vi.fn().mockResolvedValue(null),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { TxidLink } from "../TxidLink";
import { TransactionHistorySection } from "../RecordDetailPanel";
import { CopyTxidButton } from "@/pages/UTXOs";

let writeText: ReturnType<typeof vi.fn>;

// Flush pending promise microtasks (and the React state updates they trigger).
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

// The copy button swaps a lucide Copy glyph for a lucide Check glyph while in
// the confirmed state. Detect the confirmation by the rendered svg class.
function hasConfirmationCheck(button: HTMLElement): boolean {
  return button.querySelector(".lucide-check") !== null;
}

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  getParticipantsByAddress.mockResolvedValue([
    { id: 1, txid: TXID, role: "output", vout: 0, amount: 100_000, address: ADDRESS },
  ]);
  getTransactionsByTxids.mockResolvedValue([{ txid: TXID, blockTime: 1_700_000_000 }]);
  getParticipantsByTxid.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("TxidLink copy confirmation", () => {
  const copyTestId = `button-copy-txid-${TXID.slice(0, 8)}`;

  it("shows the confirmation check and success toast on a successful copy", async () => {
    renderWithProvider(<TxidLink txid={TXID} />);
    const button = screen.getByTestId(copyTestId);
    expect(hasConfirmationCheck(button)).toBe(false);

    fireEvent.click(button);
    await flush();

    expect(writeText).toHaveBeenCalledWith(TXID);
    expect(toastMock).toHaveBeenCalledWith({ description: "Transaction ID copied" });
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
    expect(hasConfirmationCheck(screen.getByTestId(copyTestId))).toBe(true);
  });

  it("warns with a destructive toast and hides the check when the copy is rejected", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    renderWithProvider(<TxidLink txid={TXID} />);
    const button = screen.getByTestId(copyTestId);

    fireEvent.click(button);
    await flush();

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
    expect(toastMock).not.toHaveBeenCalledWith({ description: "Transaction ID copied" });
    expect(hasConfirmationCheck(screen.getByTestId(copyTestId))).toBe(false);
  });
});

describe("RecordDetailPanel transaction-history copy confirmation", () => {
  const copyTestId = `button-copy-txid-${TXID.slice(0, 8)}`;

  // Open the collapsible history, wait for the row to load, then expand the
  // row so its copy button is mounted.
  async function openCopyButton() {
    renderWithProvider(<TransactionHistorySection address={ADDRESS} />);
    fireEvent.click(screen.getByTestId("button-toggle-tx-history"));
    await flush();
    const expandRow = await screen.findByTestId(`button-expand-tx-${TXID.slice(0, 8)}`);
    fireEvent.click(expandRow);
    await flush();
    return screen.getByTestId(copyTestId);
  }

  it("shows the confirmation check and success toast on a successful copy", async () => {
    const button = await openCopyButton();
    expect(hasConfirmationCheck(button)).toBe(false);

    fireEvent.click(button);
    await flush();

    expect(writeText).toHaveBeenCalledWith(TXID);
    expect(toastMock).toHaveBeenCalledWith({ description: "Transaction ID copied" });
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
    await waitFor(() =>
      expect(hasConfirmationCheck(screen.getByTestId(copyTestId))).toBe(true),
    );
  });

  it("warns with a destructive toast and hides the check when the copy is rejected", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    const button = await openCopyButton();

    fireEvent.click(button);
    await flush();

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
    expect(toastMock).not.toHaveBeenCalledWith({ description: "Transaction ID copied" });
    expect(hasConfirmationCheck(screen.getByTestId(copyTestId))).toBe(false);
  });
});

describe("UTXOs CopyTxidButton copy confirmation", () => {
  const copyTestId = `button-copy-${TXID.slice(0, 8)}`;

  it("shows the confirmation check and success toast on a successful copy", async () => {
    renderWithProvider(<CopyTxidButton txid={TXID} />);
    const button = screen.getByTestId(copyTestId);
    expect(hasConfirmationCheck(button)).toBe(false);

    fireEvent.click(button);
    await flush();

    expect(writeText).toHaveBeenCalledWith(TXID);
    expect(toastMock).toHaveBeenCalledWith({ description: "Transaction ID copied" });
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
    expect(hasConfirmationCheck(screen.getByTestId(copyTestId))).toBe(true);
  });

  it("warns with a destructive toast and hides the check when the copy is rejected", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    renderWithProvider(<CopyTxidButton txid={TXID} />);
    const button = screen.getByTestId(copyTestId);

    fireEvent.click(button);
    await flush();

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
    expect(toastMock).not.toHaveBeenCalledWith({ description: "Transaction ID copied" });
    expect(hasConfirmationCheck(screen.getByTestId(copyTestId))).toBe(false);
  });
});
