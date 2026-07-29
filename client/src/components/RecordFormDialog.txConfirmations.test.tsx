// @vitest-environment jsdom
//
// Boundary tests for the manual transaction-import (txid fetch) path in
// RecordFormDialog (Task #1533).
//
// The dialog counts the tip block as 1 confirmation (tip - height + 1). The
// backfill engine has boundary tests for this rule, but the dialog path had
// none — an off-by-one regression here would make users wait one extra block
// and show a wrong count in the error message.
//
// Covered:
//   1. A tx at exactly MINIMUM_CONFIRMATIONS (tip counted as 1) is ACCEPTED —
//      the "Transaction Data Fetched" card renders, no error.
//   2. A tx one block younger is REJECTED with an error reporting the correct
//      count (MINIMUM_CONFIRMATIONS - 1).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Radix primitives (Select, Dialog) reach for APIs jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;
Element.prototype.scrollIntoView = vi.fn();
(Element.prototype as any).hasPointerCapture = vi.fn();
(Element.prototype as any).releasePointerCapture = vi.fn();
(Element.prototype as any).setPointerCapture = vi.fn();

// The dialog only reads `nodeSettings` to build a provider; the factory is
// stubbed below, so the value is irrelevant.
vi.mock("@/hooks/use-node-settings", () => ({
  useNodeSettings: () => ({
    nodeSettings: { id: "default", providerType: "mempool-space" },
  }),
}));

// Stub ONLY the provider factory; keep the real parseTransaction and the real
// MINIMUM_CONFIRMATIONS constant so the test exercises the genuine boundary.
const getBlockHeight = vi.fn<[], Promise<number>>();
const getTransaction = vi.fn();
vi.mock("@/lib/blockchain-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blockchain-api")>();
  return {
    ...actual,
    createProviderFromSettings: () => ({ getBlockHeight, getTransaction }),
  };
});

import { RecordFormDialog } from "@/components/RecordFormDialog";
import { MINIMUM_CONFIRMATIONS } from "@/lib/blockchain-api";
import { ConfirmationStatusUnknownError } from "@/lib/providers/electrum";

const TXID = "a".repeat(64);
const TX_HEIGHT = 800_000;

// A minimal confirmed tx that parseTransaction accepts (one real input with a
// prevout address, one standard output).
const CONFIRMED_TX = {
  txid: TXID,
  status: { confirmed: true, block_height: TX_HEIGHT, block_time: 1_700_000_000 },
  fee: 1_000,
  size: 200,
  weight: 800,
  vin: [
    {
      txid: "b".repeat(64),
      vout: 0,
      prevout: {
        scriptpubkey_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        scriptpubkey_type: "v0_p2wpkh",
        value: 101_000,
      },
    },
  ],
  vout: [
    {
      scriptpubkey_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      scriptpubkey_type: "v0_p2wpkh",
      value: 100_000,
      n: 0,
    },
  ],
};

// Open the Radix type <Select> via keyboard (pointer events don't open it
// under jsdom) and pick the "Transaction" option so the Fetch button appears.
async function switchTypeToTransaction() {
  const trigger = screen.getByTestId("select-type");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: /^Transaction$/ });
  fireEvent.click(option);
}

async function renderAndFetch() {
  render(
    <RecordFormDialog open onClose={() => {}} onSave={async () => {}} />,
  );
  await switchTypeToTransaction();
  fireEvent.change(screen.getByTestId("input-address"), {
    target: { value: TXID },
  });
  // No jest-dom matchers in this repo's vitest setup — assert the DOM
  // property directly.
  await waitFor(() =>
    expect(
      (screen.getByTestId("button-fetch-tx") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByTestId("button-fetch-tx"));
}

describe("RecordFormDialog — txid import confirmation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTransaction.mockResolvedValue(CONFIRMED_TX);
  });

  afterEach(() => {
    cleanup();
  });

  it(`accepts a tx at exactly ${MINIMUM_CONFIRMATIONS} confirmations (tip block counts as 1)`, async () => {
    // tip - height + 1 === MINIMUM_CONFIRMATIONS exactly.
    getBlockHeight.mockResolvedValue(TX_HEIGHT + MINIMUM_CONFIRMATIONS - 1);

    await renderAndFetch();

    // Accepted: the fetched-data card renders and no rejection error appears.
    await waitFor(() =>
      expect(screen.getByText("Transaction Data Fetched")).toBeTruthy(),
    );
    expect(screen.queryByText(/confirmations\. Minimum/)).toBeNull();
  });

  it("rejects a tx one block younger and reports the correct count", async () => {
    // One fewer confirmation than required.
    getBlockHeight.mockResolvedValue(TX_HEIGHT + MINIMUM_CONFIRMATIONS - 2);

    await renderAndFetch();

    await waitFor(() =>
      expect(
        screen.getByText(
          `Transaction has only ${MINIMUM_CONFIRMATIONS - 1} confirmations. Minimum ${MINIMUM_CONFIRMATIONS} required.`,
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Transaction Data Fetched")).toBeNull();
  });

  it("shows an accurate connection error (NOT 'unconfirmed') when the confirmation status is undeterminable", async () => {
    getBlockHeight.mockResolvedValue(TX_HEIGHT + 100);
    getTransaction.mockRejectedValue(new ConfirmationStatusUnknownError());

    await renderAndFetch();

    await waitFor(() =>
      expect(
        screen.getByText(
          "Could not determine confirmation status — check your node connection.",
        ),
      ).toBeTruthy(),
    );
    // The false "unconfirmed" claim must NOT appear.
    expect(screen.queryByText(/Transaction is unconfirmed/)).toBeNull();
    expect(screen.queryByText("Transaction Data Fetched")).toBeNull();
  });

  it("still shows the unconfirmed message for a genuine mempool transaction", async () => {
    getBlockHeight.mockResolvedValue(TX_HEIGHT + 100);
    getTransaction.mockResolvedValue({
      ...CONFIRMED_TX,
      status: { confirmed: false },
    });

    await renderAndFetch();

    await waitFor(() =>
      expect(
        screen.getByText(
          "Transaction is unconfirmed. Only confirmed transactions can be imported.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/Could not determine confirmation status/)).toBeNull();
  });
});
