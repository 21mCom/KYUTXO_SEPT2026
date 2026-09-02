// @vitest-environment jsdom
//
// Coverage for the bulk-paste identifier canonicalization heads-up (Task:
// "Warn about mixed-case address pastes in bulk import, not just the record
// form"). The single-record form warns when a pasted mixed-case bech32
// address will be case-folded or when a 64-hex string will be saved as a
// transaction ID; the Quick Tagger review step now surfaces an equivalent
// non-blocking summary notice (data-testid="alert-identifier-warning").

import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, waitFor, screen } from "@testing-library/react";

// ScrollPositionIndicator (review-step table) reads matchMedia, absent in jsdom.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import { renderWithProviders } from "@/test/testProviders";
import { clearAllRecords } from "@/lib/data/record-crud";
import QuickTagger from "./QuickTagger";

const LOWER_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const MIXED_CASE_ADDRESS = "bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const TXID =
  "a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d";
const UPPER_TXID = TXID.toUpperCase();

async function pasteAndParse(text: string) {
  fireEvent.change(screen.getByTestId("textarea-paste-input"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByTestId("button-parse-entries"));
  await waitFor(() => {
    expect(screen.getByTestId("button-continue-to-metadata")).toBeTruthy();
  });
}

function switchToTransactionsMode() {
  fireEvent.click(screen.getByTestId("button-mode-transaction"));
}

describe("QuickTagger identifier canonicalization warning", () => {
  beforeEach(async () => {
    await clearAllRecords();
  });

  afterEach(() => {
    cleanup();
  });

  it("warns when a pasted mixed-case bech32 address will be case-folded", async () => {
    renderWithProviders(<QuickTagger />);

    await pasteAndParse(`${MIXED_CASE_ADDRESS}\n${LOWER_ADDRESS}`);

    const alert = screen.getByTestId("alert-identifier-warning");
    expect(alert.textContent).toContain("1 entry will be saved in lowercase");
    expect(alert.textContent).toContain("canonical lowercase form");
  });

  it("shows no warning for already-canonical address pastes", async () => {
    renderWithProviders(<QuickTagger />);

    await pasteAndParse(LOWER_ADDRESS);

    expect(screen.queryByTestId("alert-identifier-warning")).toBeNull();
  });

  it("warns in Transactions mode that 64-hex entries are saved as transaction IDs, including case-folding of uppercase hex", async () => {
    renderWithProviders(<QuickTagger />);
    switchToTransactionsMode();

    await pasteAndParse(`${TXID}\n${UPPER_TXID.replace(/^A/, "B")}`);

    const alert = screen.getByTestId("alert-identifier-warning");
    // one uppercase txid gets case-folded
    expect(alert.textContent).toContain("1 entry will be saved in lowercase");
    // both are flagged as being saved as transaction IDs (possible pubkey paste)
    expect(alert.textContent).toContain(
      "2 entries will be saved as transaction IDs",
    );
    expect(alert.textContent).toContain("x-only public key");
  });

  it("does not count mismatched (wrong-mode) entries toward the case-fold warning in Addresses mode", async () => {
    renderWithProviders(<QuickTagger />);

    // Uppercase txid in Addresses mode: mismatched, not saved — no canonicalization notice
    await pasteAndParse(`${LOWER_ADDRESS}\n${UPPER_TXID}`);

    expect(screen.getByTestId("alert-mismatched-entries")).toBeTruthy();
    expect(screen.queryByTestId("alert-identifier-warning")).toBeNull();
  });
});
