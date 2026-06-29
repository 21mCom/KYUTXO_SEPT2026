// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

// Task #538 wired success/failure clipboard toasts into the shared copy
// buttons (AddressLink / TxidLink). These components pull in IndexedDB-backed
// CRUD modules and the RecordPreview context at import time, so we stub those to
// keep the render cheap and deterministic and isolate the copy-button-to-toast
// wiring.
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

import { TooltipProvider } from "@/components/ui/tooltip";
import { AddressLink } from "../AddressLink";
import { TxidLink } from "../TxidLink";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TXID = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

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

describe("AddressLink copy button toast", () => {
  const copyTestId = `button-copy-address-${ADDRESS.slice(0, 8)}`;

  it("writes the address to the clipboard and shows the success toast", async () => {
    renderWithProvider(<AddressLink address={ADDRESS} />);
    fireEvent.click(screen.getByTestId(copyTestId));
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ description: "Address copied" });
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    renderWithProvider(<AddressLink address={ADDRESS} />);
    fireEvent.click(screen.getByTestId(copyTestId));
    await flush();

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
  });
});

describe("TxidLink copy button toast", () => {
  const copyTestId = `button-copy-txid-${TXID.slice(0, 8)}`;

  it("writes the txid to the clipboard and shows the success toast", async () => {
    renderWithProvider(<TxidLink txid={TXID} />);
    fireEvent.click(screen.getByTestId(copyTestId));
    await flush();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(TXID);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ description: "Transaction ID copied" });
  });

  it("shows the destructive 'Copy failed' toast when the clipboard write rejects", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    renderWithProvider(<TxidLink txid={TXID} />);
    fireEvent.click(screen.getByTestId(copyTestId));
    await flush();

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copy failed", variant: "destructive" }),
    );
  });
});
