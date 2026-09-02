// @vitest-environment jsdom
//
// Coverage for ProofOfFundsDeclaration's optional balance-verification QR codes.
//
// When enabled, the page draws one QR code per checked address that encodes a
// public block-explorer URL for that address. The codes are generated entirely
// offline via the bundled `qrcode` library (QRCode.toDataURL) — there is no
// runtime network call and no remote QR-image service.
//
// This test seeds one valid address (offline balance), toggles the QR option on,
// and asserts:
//   (1) a preview image renders for the address using the generated data URL;
//   (2) QRCode.toDataURL was called with the selected explorer's address URL
//       (the default, mempool.space), proving the payload is the explorer link
//       and that generation happens locally rather than over the network.

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/testProviders";

const ADDR = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

const mockToDataURL = vi.fn(
  async (text: string) => `data:image/png;base64,QR(${text})`,
);

vi.mock("qrcode", () => ({
  default: {
    toDataURL: (...args: unknown[]) => (mockToDataURL as any)(...args),
  },
}));

vi.mock("@/lib/data/address-stats", () => ({
  computeStatsForAddresses: vi.fn(async (addresses: string[]) => {
    const map = new Map<string, { balanceSats: number }>();
    for (const a of addresses) map.set(a, { balanceSats: 500_000 });
    return map;
  }),
}));

vi.mock("@/lib/data/record-crud", () => ({
  getRecordsByType: vi.fn(async () => []),
}));

describe("ProofOfFundsDeclaration — verification QR codes", () => {
  beforeEach(() => {
    mockToDataURL.mockClear();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("generates an offline QR code encoding the selected explorer URL when enabled", async () => {
    const { default: ProofOfFundsDeclaration } = await import(
      "@/pages/ProofOfFundsDeclaration"
    );

    renderWithProviders(<ProofOfFundsDeclaration />);

    // Paste a single valid address and run the offline balance check so the
    // address becomes a "done" row that the QR step can target.
    fireEvent.change(screen.getByTestId("textarea-address-input"), {
      target: { value: ADDR },
    });
    fireEvent.click(screen.getByTestId("button-check-balances"));

    // The totals row appears once the address balance check is done.
    await waitFor(() => {
      expect(screen.getByTestId("text-total-balance")).toBeTruthy();
    });

    // No QR code is generated until the option is switched on.
    expect(mockToDataURL).not.toHaveBeenCalled();

    // Enable the optional QR codes.
    fireEvent.click(screen.getByTestId("switch-include-qr"));

    // A preview image appears for the address, drawn from the generated data URL.
    await waitFor(() => {
      expect(screen.getByTestId(`qr-image-${ADDR}`)).toBeTruthy();
    });

    const img = screen.getByTestId(`qr-image-${ADDR}`) as HTMLImageElement;
    const expectedUrl = `https://mempool.space/address/${ADDR}`;
    expect(img.src).toBe(`data:image/png;base64,QR(${expectedUrl})`);

    // The QR payload is the explorer's address URL, generated locally.
    expect(mockToDataURL).toHaveBeenCalled();
    const encodedTexts = mockToDataURL.mock.calls.map((c) => c[0]);
    expect(encodedTexts).toContain(expectedUrl);
  });
});
