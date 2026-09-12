// @vitest-environment jsdom
//
// Companion to copy-button-toast.test.tsx. Task #538 wired success / failure
// clipboard toasts into many copy points beyond the three shared link
// components covered there. This file guards the remaining copy buttons that
// are reachable as standalone (exported) components so a future change cannot
// silently drop their confirmation toast:
//   - UTXODetailPanel        (Transaction ID + Address copy)
//   - CopyAddressButton      (Network Analysis address copy)
//   - AddressFinderRow       (Bitcoin Flow Visualizer address copy)
// Each component pulls in IndexedDB-backed CRUD / context modules at import
// time, so we stub those to keep the render cheap, deterministic, and isolated
// to the copy-button-to-toast wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

// Data layer must never touch IndexedDB during the test. UTXODetailPanel and
// the two page modules read through dataFacade in effects/handlers; resolve
// everything to neutral values so the copy buttons render immediately.
vi.mock("@/lib/dataFacade", () => ({
  getParticipantsByTxid: vi.fn().mockResolvedValue([]),
  getTransactionByTxid: vi.fn().mockResolvedValue(null),
  getRecordsByType: vi.fn().mockResolvedValue([]),
  countTransactionParticipants: vi.fn().mockResolvedValue(0),
  getAllTransactionParticipants: vi.fn().mockResolvedValue([]),
  getParticipantsByRecordIds: vi.fn().mockResolvedValue([]),
  getParticipantsByTxids: vi.fn().mockResolvedValue([]),
  getParticipantsByAddresses: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/metadata-hover", () => ({
  DEFAULT_HOVER_TOOLTIP_PREFS: {},
  isSystemTag: vi.fn(() => false),
  getHoverLabel: vi.fn(() => ""),
  getHoverMetadataFields: vi.fn(() => []),
  hasHoverMetadata: vi.fn(() => false),
  subscribeCacheEntry: vi.fn(() => () => {}),
  getCachedRecord: vi.fn(() => null),
  resolveIdentifier: vi.fn(async () => null),
  invalidateCachedRecord: vi.fn(),
  invalidateCachedRecords: vi.fn(),
  clearCachedRecords: vi.fn(),
  batchPreloadIdentifiers: vi.fn(),
}));

const {
  openRecordPreview,
  openRecordPreviewByAddress,
  openTransactionAnnotation,
  openIdentifierAnnotation,
} = vi.hoisted(() => ({
  openRecordPreview: vi.fn(() => Promise.resolve()),
  openRecordPreviewByAddress: vi.fn(() => Promise.resolve()),
  openTransactionAnnotation: vi.fn(),
  openIdentifierAnnotation: vi.fn(),
}));
vi.mock("@/contexts/RecordPreviewContext", () => ({
  useRecordPreview: () => ({
    openRecordPreview,
    openRecordPreviewByAddress,
    openTransactionAnnotation,
    openIdentifierAnnotation,
  }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { UTXODetailPanel } from "../UTXODetailPanel";
import { CopyAddressButton } from "@/pages/NetworkAnalysis";
import { AddressFinderRow } from "@/pages/BitcoinFlowVisualizer";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TXID = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

let writeText: ReturnType<typeof vi.fn>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const UTXO = {
  id: `${TXID}:0`,
  txid: TXID,
  vout: 0,
  address: ADDRESS,
  amountSats: 100_000,
  blockTime: 1_700_000_000,
  blockHeight: 800_000,
};

describe("UTXODetailPanel copy buttons toast", () => {
  it("copies the transaction ID and shows the success toast", async () => {
    renderWithProvider(
      <UTXODetailPanel open utxo={UTXO} onClose={() => {}} />,
    );
    await flush();
    fireEvent.click(screen.getByTestId(`button-copy-txid-${TXID.slice(0, 8)}`));
    await flush();

    expect(writeText).toHaveBeenCalledWith(TXID);
    expect(toastMock).toHaveBeenCalledWith({ description: "Transaction ID copied" });
  });

  it("copies the address and shows the success toast", async () => {
    renderWithProvider(
      <UTXODetailPanel open utxo={UTXO} onClose={() => {}} />,
    );
    await flush();
    fireEvent.click(screen.getByTestId(`button-copy-address-${ADDRESS.slice(0, 8)}`));
    await flush();

    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(toastMock).toHaveBeenCalledWith({ description: "Address copied" });
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    renderWithProvider(
      <UTXODetailPanel open utxo={UTXO} onClose={() => {}} />,
    );
    await flush();
    fireEvent.click(screen.getByTestId(`button-copy-txid-${TXID.slice(0, 8)}`));
    await flush();

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
  });
});

describe("NetworkAnalysis CopyAddressButton toast", () => {
  const copyTestId = `button-copy-network-address-${ADDRESS.slice(-8)}`;

  it("copies the address and shows the success toast", async () => {
    renderWithProvider(<CopyAddressButton address={ADDRESS} />);
    fireEvent.click(screen.getByTestId(copyTestId));
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(toastMock).toHaveBeenCalledWith({ description: "Address copied" });
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    renderWithProvider(<CopyAddressButton address={ADDRESS} />);
    fireEvent.click(screen.getByTestId(copyTestId));
    await flush();

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
  });
});

describe("BitcoinFlowVisualizer AddressFinderRow copy button toast", () => {
  const copyTestId = `button-copy-finder-address-${ADDRESS.slice(-8)}`;
  const addr = {
    address: ADDRESS,
    label: "",
    balanceSats: 100_000,
    lastTxDate: 1_700_000_000,
    txCount: 2,
  };
  const rowProps = {
    addr: addr as never,
    onSelect: vi.fn(),
    satsToBtcDisplay: (s: number) => (s / 1e8).toFixed(8),
    formatDate: () => "Jan 1, 2024",
    rowHeight: 44,
  };

  it("copies the address and shows the success toast", async () => {
    renderWithProvider(<AddressFinderRow {...rowProps} />);
    fireEvent.click(screen.getByTestId(copyTestId));
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(toastMock).toHaveBeenCalledWith({ description: "Address copied" });
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    renderWithProvider(<AddressFinderRow {...rowProps} />);
    fireEvent.click(screen.getByTestId(copyTestId));
    await flush();

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
  });
});
