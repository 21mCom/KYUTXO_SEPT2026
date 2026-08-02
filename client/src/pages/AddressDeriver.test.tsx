// @vitest-environment jsdom
//
// Page test for the Address Deriver: derive -> results list -> copy-all /
// download-CSV wiring, plus the invalid-input error path. Derivation runs
// against the real BIP-84 test-vector zpub so the wiring is exercised
// end-to-end; only the clipboard, toast, and blob-download seams are stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// csv-export pulls the Dexie-backed record CRUD module at import time; the
// page only uses its pure CSV helpers.
vi.mock("@/lib/data/record-crud", () => ({
  getRecordsAfterId: vi.fn(),
}));

const { toastMock, downloadBlobMock, clipboardWriteMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  downloadBlobMock: vi.fn(),
  clipboardWriteMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/lib/backup/sink", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/backup/sink")>();
  return { ...original, downloadBlob: downloadBlobMock };
});

import AddressDeriver from "./AddressDeriver";

const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const BIP84_FIRST_RECEIVE = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

describe("AddressDeriver page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteMock },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("derives addresses, shows the detected-input summary, and lists results", async () => {
    render(<AddressDeriver />);

    fireEvent.change(screen.getByTestId("textarea-key-input"), {
      target: { value: BIP84_ZPUB },
    });
    fireEvent.change(screen.getByTestId("input-address-count"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByTestId("button-derive"));

    await waitFor(() => {
      expect(screen.getByTestId("list-derived-addresses")).toBeTruthy();
    });

    expect(screen.getByTestId("badge-network").textContent).toBe("Mainnet");
    expect(screen.getByTestId("badge-script-type").textContent).toMatch(/P2WPKH/i);
    expect(screen.getByTestId("text-result-count").textContent).toContain("3 addresses");
    expect(screen.getByTestId("row-derived-0").textContent).toContain(BIP84_FIRST_RECEIVE);
    expect(screen.queryByTestId("alert-derive-error")).toBeNull();
  });

  it("shows a clear error for invalid input and derives nothing", async () => {
    render(<AddressDeriver />);

    fireEvent.change(screen.getByTestId("textarea-key-input"), {
      target: { value: "definitely not a key" },
    });
    fireEvent.click(screen.getByTestId("button-derive"));

    await waitFor(() => {
      expect(screen.getByTestId("alert-derive-error")).toBeTruthy();
    });
    expect(screen.queryByTestId("list-derived-addresses")).toBeNull();
  });

  it("copy-all writes only the newline-separated addresses to the clipboard", async () => {
    render(<AddressDeriver />);

    fireEvent.change(screen.getByTestId("textarea-key-input"), {
      target: { value: BIP84_ZPUB },
    });
    fireEvent.change(screen.getByTestId("input-address-count"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("button-derive"));

    await waitFor(() => {
      expect(screen.getByTestId("list-derived-addresses")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("button-copy-all"));

    await waitFor(() => {
      expect(clipboardWriteMock).toHaveBeenCalledTimes(1);
    });
    const copied = clipboardWriteMock.mock.calls[0][0] as string;
    const lines = copied.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(BIP84_FIRST_RECEIVE);
    expect(lines.every(l => l.startsWith("bc1q"))).toBe(true);
    expect(toastMock).toHaveBeenCalled();
  });

  it("download CSV produces a blob with all columns and a descriptive filename", async () => {
    render(<AddressDeriver />);

    fireEvent.change(screen.getByTestId("textarea-key-input"), {
      target: { value: BIP84_ZPUB },
    });
    fireEvent.change(screen.getByTestId("input-address-count"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("button-derive"));

    await waitFor(() => {
      expect(screen.getByTestId("list-derived-addresses")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("button-download-csv"));

    await waitFor(() => {
      expect(downloadBlobMock).toHaveBeenCalledTimes(1);
    });
    const [blob, filename] = downloadBlobMock.mock.calls[0] as [Blob, string];
    expect(filename).toBe("derived-addresses-extended-key-mainnet-2.csv");
    const text = await blob.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe("Address,Chain,Index,Derivation Path");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(BIP84_FIRST_RECEIVE);
    expect(lines[1]).toContain(",receive,0,");
  });
});
